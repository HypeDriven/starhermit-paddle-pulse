// Platform adapter (spec §5/§6): launch-token read/refresh (fragment
// #game_token, 45-min re-mint), profile nickname, server-time sync with
// round-trip adjustment, and cloud-save transport (one zip slot, debounced,
// remote-preferred load, localStorage stays the offline cache). The
// presence/activity/telemetry routes below exist only on this game's own dev
// server (server.js) and are used solely when NOT hosted on the platform —
// the platform has no per-game endpoints for them. Everything degrades
// gracefully when the game runs standalone (no host shell, no /api).
// Tokens are read from the short-lived launch URL and NEVER persisted.

// ---------------------------------------------------------------------------
// Minimal ZIP writer/reader (stored entries only, no compression).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

export function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// ---------------------------------------------------------------------------
// Launch-token JWT payload (base64url decode, no verify): sub = user id,
// game_scope = slug. Never hard-code the slug.
// ---------------------------------------------------------------------------

function decodeLaunchJwt(token) {
  try {
    const seg = String(token).split('.')[1];
    if (!seg) return {};
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
    return { sub: json.sub ?? null, scope: json.game_scope ?? null };
  } catch {
    return {};
  }
}

const REFRESH_MS = 45 * 60 * 1000; // token lifetime is 60 min: re-mint early
const REFRESH_RETRY_MS = 60 * 1000;
const CLOUD_DEBOUNCE_MS = 2000;

export class Platform {
  constructor() {
    this.offset = 0; // server-clock offset (ms), round-trip adjusted
    this.hosted = false; // true iff a launch token was read from the URL
    this.embedded = false;
    this.scope = null; // game scope from launch token, never hard-coded
    this.sub = null; // user id from launch token
    this.launchToken = null;
    this.playerName = null; // platform nickname (hosted), null offline
    this.syncState = 'offline'; // offline | saving | synced | error
    this.onSyncStatus = null;
    this.consented = false;
    this.telemetryQueue = [];
    this._presenceTimer = null;
    this._activityOpen = false;
    this._flushing = false;
    this._refreshTimer = null;
    this._cloudTimer = null;
    this._cloudDoc = null;
  }

  init() {
    this.launchToken = this._readLaunchToken();
    this.hosted = !!this.launchToken;
    this.embedded = window.parent !== window;
    if (this.hosted) {
      this._scheduleRefresh();
      const flush = () => this.flushCloudSave();
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }
    // Same-origin /api and /ws routes exist only when hosted (or server.js).
    return this.syncTime();
  }

  _readLaunchToken() {
    // Platform launch: the token arrives in the URL fragment, read once and
    // stripped so it never lingers in history or referrals.
    const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
    let token = frag.get('game_token');
    if (token) {
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      // Local-dev fallbacks only; the platform never sends query params.
      const params = new URLSearchParams(location.search);
      token = params.get('token') || params.get('launch_token') || null;
      if (!token) this.scope = params.get('scope') || null;
    }
    if (token) {
      const { sub, scope } = decodeLaunchJwt(token);
      this.sub = sub;
      this.scope = scope;
    }
    return token;
  }

  // Scoped launch tokens re-mint: POST with the current token, swap in the
  // new one, retry failures after ~60 s.
  _scheduleRefresh() {
    if (!this.scope) return;
    const attempt = async () => {
      try {
        const res = await fetch(`/api/v1/games/${encodeURIComponent(this.scope)}/launch-token`, {
          method: 'POST',
          headers: this._headers(),
        });
        if (!res.ok) throw new Error('http-' + res.status);
        const body = await res.json().catch(() => ({}));
        const token = body?.token ?? body?.launchToken;
        if (typeof token === 'string' && token) this.launchToken = token;
        this._refreshTimer = setTimeout(attempt, REFRESH_MS);
      } catch {
        this._refreshTimer = setTimeout(attempt, REFRESH_RETRY_MS);
      }
    };
    this._refreshTimer = setTimeout(attempt, REFRESH_MS);
  }

  // Platform nickname for the launch user. NEVER /api/v1/me (403 for launch
  // tokens), never usernames; fall back to "Player " + id.slice(0,8).
  async syncProfile() {
    if (!this.hosted || !this.sub) return null;
    const fallback = 'Player ' + String(this.sub).slice(0, 8);
    try {
      const res = await fetch(`/api/v1/users/${encodeURIComponent(this.sub)}/profile`, {
        headers: this._headers(),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error('http-' + res.status);
      const body = await res.json();
      const nick = typeof body?.nickname === 'string' ? body.nickname.trim() : '';
      this.playerName = nick || fallback;
    } catch {
      this.playerName = fallback;
    }
    return this.playerName;
  }

  async syncTime() {
    // Probes this game's own /api/v1/time when present (dev server); on the
    // platform the route may not exist — the local clock stays authoritative.
    const t0 = Date.now();
    try {
      const res = await fetch('/api/v1/time', { cache: 'no-store' });
      if (!res.ok) throw new Error('http-' + res.status);
      const body = await res.json();
      const t1 = Date.now();
      const rtt = t1 - t0;
      const serverNow = typeof body.now === 'number' ? body.now : body.serverTime;
      if (typeof serverNow !== 'number') throw new Error('invalid time response');
      // Round-trip-adjusted offset: assume symmetric latency.
      this.offset = serverNow + rtt / 2 - t1;
    } catch {
      this.offset = 0; // standalone: local clock is authoritative enough
    }
    return this.hosted;
  }

  now() {
    return Date.now() + this.offset;
  }

  // -------------------------------------------------------------------------
  // Cloud save (hosted): one slot per game (gameKey = scope), zip+base64.
  // localStorage remains the offline cache; cloud is a mirror.
  // -------------------------------------------------------------------------

  _setSyncState(state) {
    this.syncState = state;
    this.onSyncStatus?.(state);
  }

  queueCloudSave(doc) {
    if (!this.hosted || !this.scope) return;
    this._cloudDoc = doc;
    this._setSyncState('saving');
    clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => this.flushCloudSave(), CLOUD_DEBOUNCE_MS);
  }

  async flushCloudSave(doc) {
    clearTimeout(this._cloudTimer);
    this._cloudTimer = null;
    if (doc) {
      if (!this.hosted || !this.scope) return false;
      this._cloudDoc = doc;
    }
    if (!this.hosted || !this.scope || !this._cloudDoc) return false;
    const payload = this._cloudDoc;
    try {
      const json = new TextEncoder().encode(JSON.stringify(payload));
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.scope)}`, {
        method: 'PUT',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataBase64: bytesToBase64(zipStore('save.json', json)) }),
      });
      if (!res.ok) throw new Error('http-' + res.status);
      this._cloudDoc = null;
      this._setSyncState('synced');
      return true;
    } catch {
      this._setSyncState('error'); // local save remains the fallback
      return false;
    }
  }

  async loadCloud() {
    if (!this.hosted || !this.scope) return null;
    try {
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.scope)}`, {
        headers: this._headers(),
        cache: 'no-store',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('http-' + res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const json = unzipFirstEntry(bytes);
      return JSON.parse(new TextDecoder().decode(json));
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Dev-server-only instrumentation. These routes are stand-ins implemented
  // by this game's own server.js; the platform has no per-game
  // presence/activity/telemetry endpoints, so hosted mode never calls them.
  // -------------------------------------------------------------------------

  activityStart() {
    if (this.hosted || this._activityOpen) return;
    this._activityOpen = true;
    this._post('/api/v1/activity/start', { at: this.now() });
  }

  activityEnd() {
    if (this.hosted || !this._activityOpen) return;
    this._activityOpen = false;
    this._post('/api/v1/activity/end', { at: this.now() });
  }

  startPresence() {
    if (this.hosted || this._presenceTimer) return;
    const beat = () => this._post('/api/v1/presence', { at: this.now(), state: document.visibilityState });
    beat();
    this._presenceTimer = setInterval(beat, 30000); // throttled heartbeat
  }

  stopPresence() {
    clearInterval(this._presenceTimer);
    this._presenceTimer = null;
  }

  // Anonymous funnel events only (spec §6): start, tutorial step, round end,
  // retry, settings change, error category. No raw text, no pointers.
  telemetry(event, data = {}) {
    if (this.hosted || !this.consented) return;
    const allowed = ['start', 'tutorial-step', 'round-end', 'retry', 'settings-change', 'error'];
    if (!allowed.includes(event)) return;
    this.telemetryQueue.push({ event, data, at: this.now() });
    if (this.telemetryQueue.length >= 10) this.flushTelemetry();
  }

  flushTelemetry() {
    if (this._flushing || this.telemetryQueue.length === 0) return;
    this._flushing = true;
    const batch = this.telemetryQueue.splice(0, this.telemetryQueue.length);
    this._post('/api/v1/telemetry', { batch }).finally(() => {
      this._flushing = false;
    });
  }

  // Sign-in goes through the host shell — the game never handles credentials.
  requestSignIn() {
    if (this.embedded) {
      window.parent.postMessage({ type: 'starhermit:sign-in' }, '*');
      return true;
    }
    return false;
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.launchToken) h.Authorization = 'Bearer ' + this.launchToken;
    return h;
  }

  async _post(url, body) {
    if (this.hosted) return false; // dev-server stand-in routes only
    try {
      const res = await fetch(url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body) });
      if (res.status === 429) return false; // rate limit: recoverable, drop
      return res.ok;
    } catch {
      return false;
    }
  }
}

export const platform = new Platform();

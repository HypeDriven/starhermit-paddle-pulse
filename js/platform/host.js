// Platform adapter (spec §5/§6): launch-token scope, server-time sync with
// round-trip adjustment, presence heartbeats, activity start/end pairing,
// consent-gated telemetry, cloud-save transport. Everything degrades
// gracefully when the game runs standalone (no host shell, no /api).
// Tokens are read from the short-lived launch URL and NEVER persisted.

export class Platform {
  constructor() {
    this.offset = 0; // server-clock offset (ms), round-trip adjusted
    this.hosted = false;
    this.scope = null; // game scope from launch token, never hard-coded
    this.launchToken = null;
    this.consented = false;
    this.telemetryQueue = [];
    this._presenceTimer = null;
    this._activityOpen = false;
    this._flushing = false;
  }

  init() {
    const params = new URLSearchParams(location.search);
    this.launchToken = params.get('launch_token') || params.get('token') || null;
    this.scope = params.get('scope') || null;
    this.embedded = window.parent !== window;
    // Same-origin /api and /ws routes exist only when hosted (or server.js).
    return this.syncTime();
  }

  async syncTime() {
    const t0 = Date.now();
    try {
      const res = await fetch('/api/v1/time', { cache: 'no-store' });
      if (!res.ok) throw new Error('http-' + res.status);
      const body = await res.json();
      const t1 = Date.now();
      const rtt = t1 - t0;
      // Round-trip-adjusted offset: assume symmetric latency.
      this.offset = body.now + rtt / 2 - t1;
      this.hosted = true;
    } catch {
      this.offset = 0;
      this.hosted = false; // standalone: local clock is authoritative enough
    }
    return this.hosted;
  }

  now() {
    return Date.now() + this.offset;
  }

  // Activity pairing so playtime stays accurate.
  activityStart() {
    if (this._activityOpen) return;
    this._activityOpen = true;
    this._post('/api/v1/activity/start', { at: this.now() });
  }

  activityEnd() {
    if (!this._activityOpen) return;
    this._activityOpen = false;
    this._post('/api/v1/activity/end', { at: this.now() });
  }

  startPresence() {
    if (this._presenceTimer) return;
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
    if (!this.consented) return;
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

  async saveCloud(doc) {
    try {
      const res = await fetch('/api/v1/saves', {
        method: 'PUT',
        headers: this._headers(),
        body: JSON.stringify(doc),
      });
      return res.ok;
    } catch {
      return false; // local save remains the fallback
    }
  }

  async loadCloud() {
    try {
      const res = await fetch('/api/v1/saves', { headers: this._headers(), cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
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
    if (!this.hosted) return false;
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

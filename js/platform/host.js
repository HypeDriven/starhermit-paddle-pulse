// Platform adapter (spec §5/§6) over the shared StarHermit SDK
// (starhermit-sdk.js, loaded by index.html as window.StarHermit). The SDK
// reads the launch token (#game_token / #access_token, stripped after read),
// renews it, and owns the `game:<slug>` cloud-save slot, the settings KV,
// controls and the invite link; this adapter keeps the game's API. The game
// never calls its own server routes (/api or /ws), standalone or hosted; the
// device clock is authoritative. Without a token no request is made at all.
// Tokens are never persisted.

const sdk = () => (typeof window !== 'undefined' && window.StarHermit) || globalThis.StarHermit || null;
const CLOUD_DEBOUNCE_MS = 2000;

export class Platform {
  constructor() {
    this.embedded = false;
    this.playerName = null; // platform nickname (hosted), null offline
    this.avatarUrl = null;
    this.syncState = 'offline'; // offline | saving | synced | error
    this.onSyncStatus = null;
    this.onAuth = null; // ({ signedIn }) after a sign-out (refused renewal)
    this._cloudTimer = null;
    this._cloudDoc = null;
    this._inited = false;
  }

  /** true iff the SDK holds a launch token */
  get hosted() { const s = sdk(); return !!(s && s.signedIn && s.slug); }
  get scope() { const s = sdk(); return s ? s.slug : null; }
  get sub() { return this.hosted ? sdk().userId : null; }

  init() {
    this.embedded = typeof window !== 'undefined' && window.parent !== window;
    const s = sdk();
    if (s && !this._inited) {
      this._inited = true;
      s.init();
      let was = this.hosted;
      s.on('auth', (a) => {
        if (a.signedIn === was) return; // renewals change nothing visible
        was = a.signedIn;
        if (!a.signedIn) { this.playerName = null; this.avatarUrl = null; this._setSyncState('offline'); }
        this.onAuth?.(a);
      });
    }
    if (this.hosted && typeof window !== 'undefined') {
      const flush = () => this.flushCloudSave();
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
    }
    return this.syncTime();
  }

  // Platform nickname for the launch user (never /api/v1/me); fallback
  // "Player " + id prefix. Also resolves the avatar for the profile card.
  async syncProfile() {
    if (!this.hosted) return null;
    const p = await sdk().profile();
    this.playerName = p ? p.displayName : 'Player ' + String(this.sub).slice(0, 6);
    sdk().avatarUrl().then((u) => { this.avatarUrl = u; }).catch(() => {});
    return this.playerName;
  }

  // Device clock only: there is no client-reachable time route.
  async syncTime() { return this.hosted; }

  now() {
    return Date.now();
  }

  // -------------------------------------------------------------------------
  // Cloud save (hosted): the `game:<slug>` slot; localStorage remains the
  // offline cache; cloud is a mirror.
  // -------------------------------------------------------------------------

  _setSyncState(state) {
    this.syncState = state;
    this.onSyncStatus?.(state);
  }

  queueCloudSave(doc) {
    if (!this.hosted) return;
    this._cloudDoc = doc;
    this._setSyncState('saving');
    clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => this.flushCloudSave(), CLOUD_DEBOUNCE_MS);
  }

  async flushCloudSave(doc) {
    clearTimeout(this._cloudTimer);
    this._cloudTimer = null;
    if (!this.hosted) return false;
    if (doc) this._cloudDoc = doc;
    if (!this._cloudDoc) return false;
    const payload = this._cloudDoc;
    const ok = await sdk().writeSave(JSON.stringify(payload), { keepalive: true });
    if (ok) {
      if (this._cloudDoc === payload) this._cloudDoc = null;
      this._setSyncState('synced');
    } else {
      this._setSyncState('error'); // local save remains the fallback
    }
    return ok;
  }

  async loadCloud() {
    if (!this.hosted) return null;
    return sdk().loadJSON();
  }

  // -------------------------------------------------------------------------
  // Settings KV, controls, sign-in and invite (all no-ops standalone).
  // -------------------------------------------------------------------------

  async getSettings() { return this.hosted ? sdk().getSettings() : null; }
  patchSettings(obj) { if (this.hosted) sdk().patchSettings(obj); }
  async loadBindings(defaults) {
    const copy = JSON.parse(JSON.stringify(defaults));
    if (!this.hosted) return copy;
    try { return await sdk().loadBindings(defaults); } catch { return copy; }
  }
  async setControl(action, codes) {
    if (!this.hosted) return false;
    try { await sdk().setControl(action, codes); return true; } catch { return false; }
  }
  /** Post a finished match to a leaderboard (score-script.js) → { posted, rank }. Offline: no call. */
  async submitScore(key, value) {
    if (!this.hosted) return { posted: false, rank: null };
    const s = sdk();
    const keys = await s.submitScores({ [key]: value }).catch(() => []);
    if (keys.indexOf(key) < 0) return { posted: false, rank: null };
    try {
      const r = await s.leaderboard(key, { pageSize: 100 });
      const me = (r.items || []).find((i) => i.userId === s.userId);
      return { posted: true, rank: me ? me.rank : null };
    } catch { return { posted: true, rank: null }; }
  }
  canSignIn() { const s = sdk(); return !!(s && s.canSignIn()); }
  signIn() { const s = sdk(); return !!(s && s.signIn()); }
  inviteLink() { return this.hosted ? sdk().inviteLink() : null; }
}

export const platform = new Platform();

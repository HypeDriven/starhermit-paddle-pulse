// Versioned, checksummed persistence (spec §6). Local-first; the host adapter
// can sync the same document shape to cloud save. Conflicts preserve both
// snapshots (primary + backup) rather than destroying data.
// Never stores credentials, tokens, or private chat.

import { hashObject } from '../rules/hash.js';

const PREFIX = 'paddlepulse:';
export const SETTINGS_VERSION = 1;
export const PROGRESS_VERSION = 1;

function memoryBackend() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function defaultBackend() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PREFIX + 'probe', '1');
      localStorage.removeItem(PREFIX + 'probe');
      return localStorage;
    }
  } catch {
    /* fall through to memory */
  }
  return memoryBackend();
}

export class Storage {
  constructor(backend = defaultBackend()) {
    this.backend = backend;
  }

  saveDoc(key, data) {
    const doc = { v: data.v ?? 1, updatedAt: Date.now(), data };
    doc.checksum = hashObject(doc.data);
    const full = PREFIX + key;
    try {
      const prev = this.backend.getItem(full);
      if (prev) this.backend.setItem(full + ':bak', prev); // preserve both
      this.backend.setItem(full, JSON.stringify(doc));
      return true;
    } catch {
      return false;
    }
  }

  loadDoc(key) {
    const full = PREFIX + key;
    const primary = this._read(full);
    if (primary) return primary;
    return this._read(full + ':bak'); // conflict/corruption fallback
  }

  _read(full) {
    try {
      const raw = this.backend.getItem(full);
      if (!raw) return null;
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || doc.checksum !== hashObject(doc.data)) return null;
      return doc;
    } catch {
      return null;
    }
  }

  clear(key) {
    this.backend.removeItem(PREFIX + key);
    this.backend.removeItem(PREFIX + key + ':bak');
  }
}

// ---------------------------------------------------------------------------
// Settings (spec §6): accessibility, audio, graphics tier, tutorial
// completion, camera preference, rules options, control bindings.
// ---------------------------------------------------------------------------

export function defaultSettings() {
  return {
    v: SETTINGS_VERSION,
    displayName: 'Guest',
    language: 'auto', // 'auto' detects from navigator; otherwise a LOCALES tag
    privacy: { hiddenProfile: false },
    audio: { music: 0.7, effects: 0.9, ambience: 0.5, voice: 0.8, muted: false },
    graphics: { tier: 'auto', bloom: true, trails: true },
    camera: { view: 'broadcast' }, // 'broadcast' | 'behind'
    accessibility: {
      reducedMotion: false,
      highContrast: false,
      palette: 'none', // none|deuteranopia|protanopia|tritanopia|high-contrast
      textScale: 1,
      leftHanded: false,
      holdVsToggle: 'hold',
      timingAssist: false, // widened paddle in solo play (declared assist)
      haptics: true,
      captions: true,
    },
    controls: {
      keys: { left: 'ArrowLeft', right: 'ArrowRight', serve: 'Space', pause: 'Escape', undo: 'KeyU', camera: 'KeyC', hint: 'KeyH' },
      gamepad: { moveAxis: 0, serve: 0, pause: 9, altLeft: 14, altRight: 15 },
    },
    tutorialDone: {},
    consent: { telemetry: false },
    solo: { difficulty: 'steady' },
  };
}

export function migrateSettings(s) {
  const d = defaultSettings();
  if (!s || typeof s !== 'object') return d;
  const merged = { ...d, ...s };
  for (const k of ['audio', 'graphics', 'camera', 'accessibility', 'controls', 'privacy', 'consent', 'solo']) {
    merged[k] = { ...d[k], ...(s[k] || {}) };
  }
  merged.controls.keys = { ...d.controls.keys, ...((s.controls || {}).keys || {}) };
  merged.controls.gamepad = { ...d.controls.gamepad, ...((s.controls || {}).gamepad || {}) };
  merged.tutorialDone = { ...(s.tutorialDone || {}) };
  merged.v = SETTINGS_VERSION;
  return merged;
}

// ---------------------------------------------------------------------------
// Progress: journey stars, challenges, dailies, achievements, streaks,
// mastery track, long-term counters.
// ---------------------------------------------------------------------------

export function defaultProgress() {
  return {
    v: PROGRESS_VERSION,
    journey: {}, // id -> { stars, bestConceded, wins }
    challenges: {}, // id -> { cleared, best }
    dailies: {}, // date -> { won, score, duration, seed, rulesetVersion }
    achievements: {}, // key -> { at, progress }
    streak: { current: 0, best: 0 },
    totals: { matches: 0, wins: 0, angledHits: 0, masteryCleared: 0 },
    leaderboards: { daily: {}, local: [] }, // local entries: validated below
    rating: { mu: 25, rd: 8, matches: 0 }, // display-only; server-authoritative when hosted
  };
}

export function migrateProgress(p) {
  const d = defaultProgress();
  if (!p || typeof p !== 'object') return d;
  const merged = { ...d, ...p };
  for (const k of ['journey', 'challenges', 'dailies', 'achievements', 'leaderboards']) {
    merged[k] = { ...d[k], ...(p[k] || {}) };
  }
  merged.streak = { ...d.streak, ...(p.streak || {}) };
  merged.totals = { ...d.totals, ...(p.totals || {}) };
  merged.rating = { ...d.rating, ...(p.rating || {}) };
  merged.v = PROGRESS_VERSION;
  return merged;
}

// Leaderboard submission validation (spec §6): reject impossible or
// stale-version scores; every entry carries ruleset, version, seed, assists,
// and duration.
export function validateLeaderboardEntry(entry, { targetScore = 99 } = {}) {
  if (!entry || typeof entry !== 'object') return { ok: false, reason: 'malformed' };
  if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > targetScore) {
    return { ok: false, reason: 'impossible-score' };
  }
  if (!Number.isFinite(entry.duration) || entry.duration < 5 || entry.duration > 36000) {
    return { ok: false, reason: 'impossible-duration' };
  }
  if (entry.rulesetVersion == null || entry.rulesetVersion < 1) return { ok: false, reason: 'stale-version' };
  if (!Number.isInteger(entry.seed)) return { ok: false, reason: 'bad-seed' };
  return { ok: true };
}

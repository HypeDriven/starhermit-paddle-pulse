/**
 * migrate.js — carrying the browser build's account data over to the engine
 * client (pure; native/platform.ts calls it, tests/migrate.test.mjs covers it).
 *
 * - The browser build's cloud save (the JS SDK's writeSave under game:<slug>)
 *   held { settings, progress } as JSON: parseForeign() reads it back.
 * - Its settings were mirrored into the account's settings KV one key per
 *   top-level field (audio, graphics, camera, accessibility, solo, privacy),
 *   plus the language helper's ui.language and the options panel's
 *   audio.options: settingsFromLegacy() keeps the game's own options among
 *   them (the mute, ball trails, camera view, colour palette, left-handed
 *   layout, timing assist, haptics, captions, practice difficulty and the
 *   hidden-profile flag); volumes, graphics, language, reduced motion, high
 *   contrast and text size are the runtime's Options now and are dropped.
 */

export const LEGACY_KEYS = ['audio', 'graphics', 'camera', 'accessibility', 'solo', 'privacy', 'ui.language', 'audio.options'];

/** { settings, progress } from the old cloud slot's text, or null when it is not ours. */
export function parseForeign(text) {
  let doc;
  try { doc = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const progress = doc.progress && typeof doc.progress === 'object' && !Array.isArray(doc.progress) ? doc.progress : null;
  const settings = doc.settings && typeof doc.settings === 'object' && !Array.isArray(doc.settings) ? doc.settings : null;
  if (!progress && !settings) return null;
  return { settings, progress };
}

const KEEP = {
  audio: { muted: 'boolean' },
  graphics: { trails: 'boolean' },
  camera: { view: ['broadcast', 'behind'] },
  accessibility: {
    palette: ['none', 'deuteranopia', 'protanopia', 'tritanopia', 'high-contrast'],
    leftHanded: 'boolean', timingAssist: 'boolean', haptics: 'boolean', captions: 'boolean',
  },
  solo: { difficulty: ['calm', 'steady', 'brisk', 'fierce', 'zenith'] },
  privacy: { hiddenProfile: 'boolean' },
};

/** Copies the kept fields of `from` (an object of sections) over `out`. */
function keep(out, from) {
  for (const [sect, fields] of Object.entries(KEEP)) {
    const v = from && from[sect];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    for (const [f, type] of Object.entries(fields)) {
      const ok = Array.isArray(type) ? type.includes(v[f]) : typeof v[f] === type;
      if (ok) out[sect] = { ...(out[sect] || {}), [f]: v[f] };
    }
  }
  return out;
}

/** Settings from the defaults with the old account KV values (key → value) the engine client keeps. */
export function settingsFromLegacy(defaults, legacy) {
  return keep(JSON.parse(JSON.stringify(defaults)), legacy || {});
}

/**
 * The old cloud save's settings over this device's: its kept options (when
 * `adoptOptions`), the display name when this device still has the default,
 * and the tutorial completions unioned (as the browser build's adoptRemote).
 */
export function mergeForeignSettings(local, remote, adoptOptions) {
  const out = JSON.parse(JSON.stringify(local));
  if (!remote || typeof remote !== 'object') return out;
  if (adoptOptions) keep(out, remote);
  if ((!out.displayName || out.displayName === 'Guest') && typeof remote.displayName === 'string' && remote.displayName.trim()) {
    out.displayName = remote.displayName.trim().slice(0, 24);
  }
  const done = remote.tutorialDone && typeof remote.tutorialDone === 'object' ? remote.tutorialDone : {};
  for (const [k, v] of Object.entries(done)) if (v === true) out.tutorialDone[k] = true;
  return out;
}

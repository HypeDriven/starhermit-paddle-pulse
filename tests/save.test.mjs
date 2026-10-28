// The save on the engine: the browser build's progress merge (storage.mergeProgress, used on
// cloud conflicts and for the old cloud save), the documents' checksum wrapping on a pluggable
// backend (native/platform.ts gives js/session/storage.js the engine's saves), and the migration
// of the browser build's cloud save and account settings (js/migrate.js). node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage, defaultSettings, migrateSettings, defaultProgress } from '../js/session/storage.js';
import { parseForeign, settingsFromLegacy, mergeForeignSettings, LEGACY_KEYS } from '../js/migrate.js';
import { hashObject } from '../js/rules/hash.js';

test('mergeProgress keeps the better result of each record', async () => {
  const { mergeProgress, defaultProgress } = await import('../js/session/storage.js');
  const a = defaultProgress(), b = defaultProgress();
  a.journey.j01 = { stars: 3, wins: 1 }; b.journey.j01 = { stars: 1, wins: 4 }; b.journey.j02 = { stars: 2, wins: 1 };
  a.challenges['c-economy'] = { cleared: true, best: '5-2' }; b.challenges['c-economy'] = { cleared: false };
  a.dailies['2026-10-01'] = { won: true, score: [5, 1] }; b.dailies['2026-10-02'] = { won: false, score: [2, 5] };
  a.achievements['first-win'] = { at: '2026-10-03', progress: 0 }; b.achievements['first-win'] = { at: '2026-10-01', progress: 0 };
  b.achievements.centurion = { at: null, progress: 40 }; a.achievements.centurion = { at: null, progress: 12 };
  a.streak = { current: 0, best: 6 }; b.streak = { current: 3, best: 3 };
  a.totals = { matches: 50, wins: 20, angledHits: 10, masteryCleared: 2 }; b.totals = { matches: 30, wins: 25, angledHits: 40, masteryCleared: 1 };
  a.leaderboards.local = [{ name: 'Al', score: 20, duration: 90 }]; b.leaderboards.local = [{ name: 'Al', score: 25, duration: 120 }];
  const m = mergeProgress(a, b);
  assert.deepEqual(m.journey, { j01: { stars: 3, wins: 4 }, j02: { stars: 2, wins: 1 } });
  assert.equal(m.challenges['c-economy'].cleared, true);
  assert.deepEqual(Object.keys(m.dailies).sort(), ['2026-10-01', '2026-10-02']);
  assert.equal(m.achievements['first-win'].at, '2026-10-01');
  assert.equal(m.achievements.centurion.progress, 40);
  assert.deepEqual(m.streak, { current: 3, best: 6 });
  assert.deepEqual(m.totals, { matches: 50, wins: 25, angledHits: 40, masteryCleared: 2 });
  assert.deepEqual(m.leaderboards.local, [{ name: 'Al', score: 25, duration: 90 }]);
});

test('documents keep their checksum wrapping on any backend; a corrupt one falls back to its backup', () => {
  const map = new Map();
  const backend = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const s = new Storage(backend);
  s.saveDoc('progress', { a: 1 });
  s.saveDoc('progress', { a: 2 });
  assert.deepEqual(s.loadDoc('progress').data, { a: 2 });
  const doc = JSON.parse(map.get('paddlepulse:progress'));
  assert.equal(doc.checksum, hashObject({ a: 2 }));
  map.set('paddlepulse:progress', JSON.stringify({ ...doc, checksum: 'bad' }));
  assert.deepEqual(s.loadDoc('progress').data, { a: 1 });
  // native/platform.ts wraps the engine save the same way: { v, updatedAt, data, checksum }
  map.set('paddlepulse:settings', JSON.stringify({ v: 1, updatedAt: 0, data: { displayName: 'Ana' }, checksum: hashObject({ displayName: 'Ana' }) }));
  assert.equal(migrateSettings(s.loadDoc('settings').data).displayName, 'Ana');
});

test("the browser build's cloud save parses back to { settings, progress }; anything else is not ours", () => {
  const p = defaultProgress();
  p.journey.j01 = { stars: 2, wins: 1 };
  const text = JSON.stringify({ settings: { displayName: 'Old', tutorialDone: { 't-move': true } }, progress: p });
  const doc = parseForeign(text);
  assert.deepEqual(doc.progress.journey, { j01: { stars: 2, wins: 1 } });
  assert.equal(doc.settings.displayName, 'Old');
  assert.equal(parseForeign('not json'), null);
  assert.equal(parseForeign('[1,2]'), null);
  assert.equal(parseForeign(JSON.stringify({ other: 1 })), null);
});

test('old account settings keep the game options only (the runtime owns volumes, graphics, language, motion, contrast, text size)', () => {
  const legacy = {
    audio: { music: 0.1, muted: true }, graphics: { preset: 'ultra', trails: false }, camera: { view: 'behind' },
    accessibility: { palette: 'tritanopia', leftHanded: true, timingAssist: true, haptics: false, captions: false, reducedMotion: true, textScale: 1.4 },
    solo: { difficulty: 'fierce' }, privacy: { hiddenProfile: true }, 'ui.language': { choice: 'de-DE' },
  };
  const s = settingsFromLegacy(defaultSettings(), legacy);
  assert.equal(s.audio.muted, true);
  assert.equal(s.audio.music, defaultSettings().audio.music);
  assert.equal(s.graphics.trails, false);
  assert.equal(s.graphics.preset, 'auto');
  assert.equal(s.camera.view, 'behind');
  assert.deepEqual([s.accessibility.palette, s.accessibility.leftHanded, s.accessibility.timingAssist, s.accessibility.haptics, s.accessibility.captions], ['tritanopia', true, true, false, false]);
  assert.equal(s.accessibility.reducedMotion, false);
  assert.equal(s.solo.difficulty, 'fierce');
  assert.equal(s.privacy.hiddenProfile, true);
  // bad values are ignored
  const bad = settingsFromLegacy(defaultSettings(), { camera: { view: 'drone' }, solo: { difficulty: 7 } });
  assert.equal(bad.camera.view, 'broadcast');
  assert.equal(bad.solo.difficulty, 'steady');
  assert.ok(LEGACY_KEYS.includes('ui.language') && LEGACY_KEYS.includes('audio.options'));
});

test('old cloud settings: options adopted only for a device without its own, name if still Guest, lessons unioned', () => {
  const local = defaultSettings();
  local.tutorialDone = { 't-serve': true };
  const remote = { displayName: 'Mia', camera: { view: 'behind' }, tutorialDone: { 't-move': true } };
  const a = mergeForeignSettings(local, remote, true);
  assert.equal(a.camera.view, 'behind');
  assert.equal(a.displayName, 'Mia');
  assert.deepEqual(a.tutorialDone, { 't-serve': true, 't-move': true });
  const b = mergeForeignSettings({ ...local, displayName: 'Kai' }, remote, false);
  assert.equal(b.camera.view, 'broadcast');
  assert.equal(b.displayName, 'Kai');
});

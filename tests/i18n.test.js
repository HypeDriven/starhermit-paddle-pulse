// Every string key used in markup and code exists in all nine locales, and
// every authored content string (lessons, stages, challenges, achievements,
// daily cards, practice difficulties) is translated (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, resolvedStrings, CONTENT, setLocale, tc, t } from '../js/ui/i18n.js';
import { LESSONS } from '../js/content/tutorials.js';
import { JOURNEY_LEVELS, CHALLENGES, PRACTICE_DIFFICULTIES } from '../js/content/levels.js';
import { ACHIEVEMENTS } from '../js/content/achievements.js';
import { TERMINAL } from '../js/rules/engine.js';
import { defaultSettings } from '../js/session/storage.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? jsFiles(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

const tsFiles = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.ts')).map((n) => path.join(dir, n));

function usedKeys() {
  const keys = new Set();
  for (const f of [...jsFiles(path.join(ROOT, 'js')), ...tsFiles(path.join(ROOT, 'native'))]) {
    if (/i18n(-content|-native)?\.js$/.test(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    // Literal keys only (t('x') or t("x")); keys built from data are added below.
    for (const m of src.matchAll(/(?<![\w.$])t\(\s*['"]([a-zA-Z][\w.-]*[\w-])['"]/g)) keys.add(m[1]);
    // keys named in tables and ternaries ("help.keyPause", "settings.camBehind", …)
    for (const m of src.matchAll(/["'](help\.key\w+|settings\.cam\w+|sync\.state\w+|modes\.\w+Sub|chip\.\w+|dur\.\w+|nat\.\w+|invalid\.\w+)["']/g)) keys.add(m[1]);
  }
  // Keys built from data at runtime.
  for (const r of Object.values(TERMINAL)) keys.add('reason.' + r);
  for (const c of CHALLENGES) keys.add('constraint.' + c.goals.constraint);
  for (const p of ['none', 'deuteranopia', 'protanopia', 'tritanopia', 'high-contrast']) keys.add('palette.' + p);
  for (const a of Object.keys(defaultSettings().controls.keys)) keys.add('action.' + a);
  const main = fs.readFileSync(path.join(ROOT, 'native/main.ts'), 'utf8');
  for (const m of main.matchAll(/"(caption\.\w+)"/g)) keys.add(m[1]);
  for (const id of ['learn', 'journey', 'daily', 'practice', 'challenge', 'hosted']) keys.add(`modes.${id}Sub`);
  return keys;
}

function contentKeys() {
  const keys = new Set();
  const add = (s) => { if (typeof s === 'string' && s) keys.add(s); };
  for (const l of LESSONS) { add(l.title); add(l.objective); for (const s of l.steps) { add(s.text); add(s.hint); } }
  for (const l of JOURNEY_LEVELS) { add(l.title); add(l.brief); add(l.chapter); }
  for (const c of CHALLENGES) { add(c.title); add(c.brief); }
  for (const p of PRACTICE_DIFFICULTIES) add(p.name);
  for (const a of ACHIEVEMENTS) { add(a.name); add(a.desc); }
  const daily = fs.readFileSync(path.join(ROOT, 'js/content/daily.js'), 'utf8');
  for (const m of daily.matchAll(/name: '([^']+)'/g)) add(m[1]);
  return keys;
}

test('every t() key used in code exists in all nine locales', () => {
  const keys = usedKeys();
  assert.ok(keys.size > 150, `only ${keys.size} keys found`);
  const en = resolvedStrings('en-US');
  const missingEn = [...keys].filter((k) => !(k in en));
  assert.deepEqual(missingEn, [], 'missing in en-US');
  for (const l of LOCALES) {
    const d = resolvedStrings(l);
    assert.deepEqual([...keys].filter((k) => placeholders(d[k]) !== placeholders(en[k])), [], `placeholder mismatch in ${l}`);
  }
});

for (const locale of LOCALES.filter((l) => !l.startsWith('en'))) {
  test(`${locale}: every authored content string is translated with the same placeholders`, () => {
    const dict = CONTENT[locale];
    const keys = [...contentKeys()];
    assert.ok(keys.length > 140);
    assert.deepEqual(keys.filter((k) => !Object.prototype.hasOwnProperty.call(dict, k)), [], `missing in ${locale}`);
    assert.deepEqual(keys.filter((k) => placeholders(dict[k]) !== placeholders(k)), [], 'placeholder mismatch');
  });
}

test('no content table carries stale keys', () => {
  const all = contentKeys();
  for (const l of LOCALES) assert.deepEqual(Object.keys(CONTENT[l]).filter((k) => !all.has(k)), [], l);
});

test('tc() and t() follow the locale; regional variants inherit', () => {
  setLocale('de-DE');
  assert.equal(tc('First Contact'), 'Erster Kontakt');
  assert.equal(t('hud.go'), 'LOS');
  setLocale('es-ES');
  assert.equal(tc('Long Court'), 'Pista larga');
  assert.equal(tc('First Contact'), 'Primer contacto');
  setLocale('fr-CA');
  assert.equal(tc('Pinball'), 'Machine à boules');
  assert.equal(tc('Slice'), 'Coupé');
  setLocale('en-GB');
  assert.equal(tc('Force the corners, own the center.'), 'Force the corners, own the centre.');
  setLocale('en-US');
  assert.equal(tc('Not content'), 'Not content');
});

test("the engine client's own strings (js/ui/i18n-native.js) exist in every language with the same placeholders", async () => {
  const { NATIVE } = await import('../js/ui/i18n-native.js');
  const en = Object.keys(NATIVE.en).sort();
  for (const lang of ['es', 'de', 'fr', 'pt', 'it']) {
    assert.deepEqual(Object.keys(NATIVE[lang]).sort(), en, lang);
    for (const k of en) assert.equal(placeholders(NATIVE[lang][k]), placeholders(NATIVE.en[k]), `${lang} ${k}`);
  }
});

// Content validation tests (spec §2/§9): 40+ authored stages, five themes,
// tutorial sequence, daily rotation — all proven legal, winnable, bounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JOURNEY_LEVELS, CHALLENGES, PRACTICE_DIFFICULTIES, AI_LEVELS, getJourneyLevel } from '../js/content/levels.js';
import { THEMES } from '../js/content/themes.js';
import { LESSONS } from '../js/content/tutorials.js';
import { ACHIEVEMENTS } from '../js/content/achievements.js';
import { dailyContent, utcDateString } from '../js/content/daily.js';
import { validateAllContent, simulateToTerminal } from '../js/content/validate.js';

test('launch scope: ≥40 authored stages, 5 themes, 6 challenges, 5 lessons', () => {
  assert.ok(JOURNEY_LEVELS.length >= 40);
  assert.equal(Object.keys(THEMES).length, 5);
  assert.ok(CHALLENGES.length >= 5);
  assert.ok(LESSONS.length >= 5);
  assert.ok(JOURNEY_LEVELS.filter((l) => l.mastery).length >= 5, 'periodic mastery stages');
});

test('journey ids are unique, ordered, and addressable', () => {
  const ids = new Set(JOURNEY_LEVELS.map((l) => l.id));
  assert.equal(ids.size, JOURNEY_LEVELS.length);
  assert.equal(getJourneyLevel(1).id, 'j01');
  assert.equal(getJourneyLevel(40).id, 'j40');
  assert.equal(getJourneyLevel('j40').index, 40);
  assert.equal(getJourneyLevel(41), null);
});

test('achievement set covers the five mandated categories', () => {
  const keys = ACHIEVEMENTS.map((a) => a.key);
  for (const required of ['first-win', 'angle-master', 'streak-5', 'mastery-all', 'centurion']) {
    assert.ok(keys.includes(required), `missing ${required}`);
  }
  assert.ok(keys.every((k) => /^[a-z0-9-]+$/.test(k)), 'stable lowercase keys');
});

test('daily content is immutable per UTC date and rotates', () => {
  const d1 = dailyContent('2026-08-16');
  const d1again = dailyContent('2026-08-16');
  const d2 = dailyContent('2026-08-17');
  assert.equal(d1.seed, d1again.seed, 'same day → same seed');
  assert.notEqual(d1.seed, d2.seed, 'different day → different seed');
  assert.equal(d1.version, 1);
  assert.equal(d1.excluded, false);
  assert.match(utcDateString(), /^\d{4}-\d{2}-\d{2}$/);
});

test('every daily card in the rotation is winnable and bounded', () => {
  for (let i = 0; i < 7; i++) {
    const date = new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10);
    const d = dailyContent(date);
    const sim = simulateToTerminal({ seed: d.seed, ruleset: d.ruleset, ai: d.ai });
    assert.ok(sim.ok, `daily ${date} (${d.name}): ${sim.reason}`);
  }
});

test('all shipped content passes offline validators (slow, exhaustive)', { timeout: 120000 }, () => {
  const report = validateAllContent();
  const failures = [];
  for (const [group, entries] of Object.entries({ level: report.levels, challenge: report.challenges, lesson: report.lessons })) {
    for (const [id, r] of Object.entries(entries)) {
      if (r.shape.length) failures.push(`${group} ${id}: shape ${r.shape.join(',')}`);
      if (!r.sim.ok) failures.push(`${group} ${id}: sim ${r.sim.reason}`);
    }
  }
  assert.deepEqual(failures, [], failures.join('\n'));
  assert.ok(report.ok);
});

test('practice difficulties map to valid AI levels', () => {
  for (const d of PRACTICE_DIFFICULTIES) {
    assert.ok(d.ai >= 0 && d.ai < AI_LEVELS.length);
  }
});

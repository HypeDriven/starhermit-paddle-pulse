// Property test (spec §9): the same version, seed, and commands produce
// identical state hashes. Golden tests for representative sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stateHash, verifyReplay, PHASE, TICK_RATE } from '../js/rules/engine.js';
import { LocalMatch } from '../js/session/match.js';

test('same seed + same commands → identical hashes (replay property)', () => {
  // Deterministic AI seats issue the identical command stream in both runs,
  // so the property "same version + seed + commands → same hashes" is exact.
  const run = () => {
    const m = new LocalMatch({
      seats: [
        { kind: 'ai', level: 2, id: 'a' },
        { kind: 'ai', level: 3, id: 'b' },
      ],
      seed: 123,
      ruleset: { targetScore: 3, winMargin: 1, ballSpeed: 16 },
      sessionId: 'fixed',
      build: 'test',
    });
    let guard = 0;
    while (!m.finished && guard < TICK_RATE * 300) {
      m.step();
      guard++;
    }
    return m;
  };
  const a = run();
  const b = run();
  assert.ok(a.finished && b.finished, 'both runs terminate');
  assert.equal(stateHash(a.state), stateHash(b.state));
  assert.deepEqual(a.replay.hashes, b.replay.hashes);
});

test('replay envelope verifies end-to-end (verifyReplay)', () => {
  const m = new LocalMatch({
    seats: [
      { kind: 'ai', level: 2, id: 'bot-a' },
      { kind: 'ai', level: 3, id: 'bot-b' },
    ],
    seed: 99,
    ruleset: { targetScore: 4, winMargin: 2 },
    sessionId: 'verify-me',
    build: 'test',
  });
  let guard = 0;
  while (!m.finished && guard < TICK_RATE * 300) {
    m.step();
    guard++;
  }
  assert.ok(m.finished);
  const res = verifyReplay(m.replay);
  assert.equal(res.ok, true, `mismatch at tick ${res.mismatchTick}`);
});

test('golden: easy, hard, and terminal sessions match stored expectations', () => {
  const goldens = [];
  for (const [name, seed, ruleset] of [
    ['easy', 11, { targetScore: 2, winMargin: 1, ballSpeed: 12 }],
    ['hard', 22, { targetScore: 3, winMargin: 2, ballSpeed: 20, obstacles: [{ type: 'bumper', id: 'b1', x: 0, y: 0, r: 1.1 }] }],
  ]) {
    const m = new LocalMatch({
      seats: [
        { kind: 'ai', level: 1, id: 'a' },
        { kind: 'ai', level: 2, id: 'b' },
      ],
      seed,
      ruleset,
      sessionId: name,
      build: 'test',
    });
    let guard = 0;
    while (!m.finished && guard < TICK_RATE * 300) {
      m.step();
      guard++;
    }
    assert.ok(m.finished, `${name} should terminate`);
    goldens.push({ name, hash: stateHash(m.state), score: [...m.state.score], ticks: m.state.tick });
  }
  // Golden property: re-running produces the exact same triple.
  const again = [];
  for (const [name, seed, ruleset] of [
    ['easy', 11, { targetScore: 2, winMargin: 1, ballSpeed: 12 }],
    ['hard', 22, { targetScore: 3, winMargin: 2, ballSpeed: 20, obstacles: [{ type: 'bumper', id: 'b1', x: 0, y: 0, r: 1.1 }] }],
  ]) {
    const m = new LocalMatch({
      seats: [
        { kind: 'ai', level: 1, id: 'a' },
        { kind: 'ai', level: 2, id: 'b' },
      ],
      seed,
      ruleset,
      sessionId: name,
      build: 'test',
    });
    let guard = 0;
    while (!m.finished && guard < TICK_RATE * 300) {
      m.step();
      guard++;
    }
    again.push({ name, hash: stateHash(m.state), score: [...m.state.score], ticks: m.state.tick });
  }
  assert.deepEqual(again, goldens);
});

test('golden: interrupted + resumed session equals uninterrupted', () => {
  const full = () => {
    const m = new LocalMatch({
      seats: [
        { kind: 'ai', level: 2, id: 'a' },
        { kind: 'ai', level: 2, id: 'b' },
      ],
      seed: 55,
      ruleset: { targetScore: 3, winMargin: 1 },
      sessionId: 'resume',
      build: 'test',
    });
    let guard = 0;
    while (!m.finished && guard < TICK_RATE * 300) {
      m.step();
      guard++;
    }
    return stateHash(m.state);
  };

  const m = new LocalMatch({
    seats: [
      { kind: 'ai', level: 2, id: 'a' },
      { kind: 'ai', level: 2, id: 'b' },
    ],
    seed: 55,
    ruleset: { targetScore: 3, winMargin: 1 },
    sessionId: 'resume',
    build: 'test',
  });
  for (let i = 0; i < TICK_RATE * 5 && !m.finished; i++) m.step();
  const snap = m.snapshot(); // simulate backgrounding / disconnect
  const restored = LocalMatch.restore(snap, 'test');
  let guard = 0;
  while (!restored.finished && guard < TICK_RATE * 300) {
    restored.step();
    guard++;
  }
  assert.equal(stateHash(restored.state), full());
});

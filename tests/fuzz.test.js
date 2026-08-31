// Fuzz tests (spec §9): malformed commands and generated content must not
// hang, produce NaN physics, reach impossible mandatory states, or loop
// without bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, step, applyCommand, PHASE, TICK_RATE, stateHash } from '../js/rules/engine.js';
import { createRng, next, range } from '../js/rules/rng.js';
import { AiController } from '../js/session/ai.js';

test('fuzz: 20k malformed commands never throw, NaN, or hang', () => {
  const rng = createRng(0xf00d);
  const s = createMatch({ seed: 1, ruleset: { targetScore: 5, winMargin: 2 } });
  const bots = [new AiController(2, 0, { seed: 3 }), new AiController(2, 1, { seed: 4 })];
  const garbage = () => {
    const kind = Math.floor(next(rng) * 8);
    switch (kind) {
      case 0: return null;
      case 1: return {};
      case 2: return { player: next(rng) * 10 - 5, type: 'move', x: 'banana' };
      case 3: return { player: 0, type: 'move', x: next(rng) * 1e9 - 5e8 };
      case 4: return { player: 1, type: 'serve', extra: { deep: [1, 2, 3] } };
      case 5: return { player: 0, type: ['move'], x: NaN };
      case 6: return { player: 0, type: 'move', x: Infinity };
      default: return { player: Math.floor(next(rng) * 2), type: 'concede' };
    }
  };
  let ops = 0;
  let lastTick = 0;
  while (ops < 20000 && s.phase !== PHASE.OVER) {
    const cmd = garbage();
    try {
      applyCommand(s, cmd);
    } catch (e) {
      assert.fail(`applyCommand threw on ${JSON.stringify(cmd)}: ${e.message}`);
    }
    for (const b of bots) {
      const cmds = b.update(s);
      if (cmds) for (const c of cmds) applyCommand(s, c);
    }
    if (s.phase === PHASE.OVER) break; // terminal no-ops keep the tick frozen
    step(s);
    assert.ok(s.tick > lastTick, 'tick must be monotonic');
    lastTick = s.tick;
    assert.ok(Number.isFinite(s.ball.x) && Number.isFinite(s.ball.y), 'ball must stay finite');
    assert.ok(Number.isFinite(s.paddles[0].x) && Number.isFinite(s.paddles[1].x));
    assert.ok(s.score[0] >= 0 && s.score[1] >= 0 && Number.isInteger(s.score[0]) && Number.isInteger(s.score[1]));
    assert.ok(s.tick < TICK_RATE * 60 * 30, 'no unbounded loops');
    ops++;
  }
});

test('fuzz: generated rulesets normalize to safe, terminating matches', () => {
  const rng = createRng(0xbeef);
  for (let iter = 0; iter < 30; iter++) {
    const ruleset = {
      targetScore: Math.floor(range(rng, -5, 200)),
      winMargin: Math.floor(range(rng, -3, 50)),
      ballSpeed: range(rng, -10, 500),
      paddleWidth: range(rng, 0, 100),
      arena: { w: range(rng, -50, 500), h: range(rng, -50, 500) },
      obstacles: [
        { type: 'bumper', id: 'f1', x: range(rng, -20, 20), y: range(rng, -8, 8), r: range(rng, 0.2, 3) },
        { type: 'block', id: 'f2', x: range(rng, -10, 10), y: range(rng, -6, 6), hw: range(rng, 0.2, 3), hh: 0.35, move: { axis: 'x', amp: range(rng, 0, 6), period: Math.floor(range(rng, 60, 900)) } },
      ],
      maxTicks: TICK_RATE * 120,
    };
    const seed = Math.floor(next(rng) * 1e9);
    const s = createMatch({ seed, ruleset });
    const bots = [new AiController(2, 0, { seed }), new AiController(2, 1, { seed: seed ^ 9 })];
    let guard = 0;
    while (s.phase !== PHASE.OVER && guard < TICK_RATE * 150) {
      for (const b of bots) {
        const cmds = b.update(s);
        if (cmds) for (const c of cmds) applyCommand(s, c);
      }
      step(s);
      guard++;
    }
    assert.equal(s.phase, PHASE.OVER, `iter ${iter} must terminate (maxTicks bound)`);
    assert.ok(stateHash(s), 'hashable terminal state');
  }
});

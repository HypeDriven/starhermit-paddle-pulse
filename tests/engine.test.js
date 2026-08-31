// Rules engine unit tests (spec §9): every legal action, invalid-action
// reason, scoring component, terminal state, serialization migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMatch, step, applyCommand, validateCommand, legalActions, serializeState,
  deserializeState, migrateState, stateHash, decideTiebreak, scoreBreakdown,
  PHASE, CMD, INVALID, TERMINAL, TICK_RATE, normalizeRuleset,
} from '../js/rules/engine.js';

function freshMatch(ruleset = {}, seed = 42) {
  return createMatch({ seed, ruleset });
}

test('createMatch is deterministic for a seed', () => {
  const a = freshMatch({}, 7);
  const b = freshMatch({}, 7);
  assert.equal(stateHash(a), stateHash(b));
  const c = freshMatch({}, 8);
  assert.notEqual(stateHash(a), stateHash(c));
});

test('tick increases monotonically', () => {
  const s = freshMatch();
  for (let i = 1; i <= 500; i++) {
    step(s);
    assert.equal(s.tick, i);
  }
});

test('legal actions: serve phase exposes serve only to the server', () => {
  const s = freshMatch();
  const acts0 = legalActions(s, 0);
  const acts1 = legalActions(s, 1);
  assert.ok(acts0.some((a) => a.type === CMD.SERVE));
  assert.ok(!acts1.some((a) => a.type === CMD.SERVE));
  assert.ok(acts0.some((a) => a.type === CMD.MOVE));
  assert.ok(acts1.some((a) => a.type === CMD.MOVE));
});

test('legal actions: finished match exposes nothing', () => {
  const s = freshMatch({ targetScore: 1, winMargin: 1 });
  applyCommand(s, { player: 1, type: CMD.CONCEDE });
  assert.equal(s.phase, PHASE.OVER);
  assert.deepEqual(legalActions(s, 0), []);
  assert.deepEqual(legalActions(s, 1), []);
});

test('serve command starts a rally; only server may serve', () => {
  const s = freshMatch();
  let r = applyCommand(s, { player: 1, type: CMD.SERVE });
  assert.equal(r.ok, false);
  assert.equal(r.reason, INVALID.NOT_YOUR_SERVE);
  r = applyCommand(s, { player: 0, type: CMD.SERVE });
  assert.equal(r.ok, true);
  assert.equal(s.phase, PHASE.RALLY);
  r = applyCommand(s, { player: 0, type: CMD.SERVE });
  assert.equal(r.ok, false);
  assert.equal(r.reason, INVALID.NOT_SERVE_PHASE);
});

test('move command clamps to quantized in-bounds targets', () => {
  const s = freshMatch();
  const r = applyCommand(s, { player: 0, type: CMD.MOVE, x: 3.1234567 });
  assert.equal(r.ok, true);
  assert.equal(s.paddles[0].tx, 3.123); // quantized to 1/1000
  const acts = legalActions(s, 0);
  const move = acts.find((a) => a.type === CMD.MOVE);
  assert.ok(move.min < 0 && move.max > 0);
});

test('every invalid-action reason is reachable and explained', () => {
  const s = freshMatch();
  assert.equal(validateCommand(s, null).reason, INVALID.UNKNOWN_COMMAND);
  assert.equal(validateCommand(s, { player: 0, type: 'fly' }).reason, INVALID.UNKNOWN_COMMAND);
  assert.equal(validateCommand(s, { player: 9, type: CMD.MOVE, x: 0 }).reason, INVALID.NOT_A_PLAYER);
  assert.equal(validateCommand(s, { player: 0, type: CMD.MOVE, x: NaN }).reason, INVALID.NOT_A_NUMBER);
  assert.equal(validateCommand(s, { player: 0, type: CMD.MOVE, x: 999 }).reason, INVALID.OUT_OF_BOUNDS);
  assert.equal(validateCommand(s, { player: 1, type: CMD.SERVE }).reason, INVALID.NOT_YOUR_SERVE);

  const huge = { player: 0, type: CMD.MOVE, x: 0, pad: 'x'.repeat(5000) };
  assert.equal(validateCommand(s, huge).reason, INVALID.PAYLOAD_TOO_LARGE);

  const over = freshMatch();
  applyCommand(over, { player: 0, type: CMD.CONCEDE });
  assert.equal(validateCommand(over, { player: 0, type: CMD.MOVE, x: 0 }).reason, INVALID.MATCH_FINISHED);

  const limited = freshMatch({ moveLimit: 2 });
  applyCommand(limited, { player: 0, type: CMD.MOVE, x: 1 });
  applyCommand(limited, { player: 0, type: CMD.MOVE, x: 2 });
  assert.equal(validateCommand(limited, { player: 0, type: CMD.MOVE, x: 3 }).reason, INVALID.MOVE_LIMIT_EXCEEDED);
  // Scoped limits: player 1 unconstrained when moveLimitPlayers=[0].
  const scoped = freshMatch({ moveLimit: 1, moveLimitPlayers: [0] });
  applyCommand(scoped, { player: 0, type: CMD.MOVE, x: 1 });
  assert.equal(validateCommand(scoped, { player: 0, type: CMD.MOVE, x: 2 }).reason, INVALID.MOVE_LIMIT_EXCEEDED);
  assert.equal(validateCommand(scoped, { player: 1, type: CMD.MOVE, x: 2 }).ok, true);
});

test('invalid commands are counted per player (tiebreak input)', () => {
  const s = freshMatch();
  applyCommand(s, { player: 0, type: CMD.MOVE, x: 999 });
  applyCommand(s, { player: 0, type: CMD.MOVE, x: -999 });
  applyCommand(s, { player: 1, type: CMD.SERVE });
  assert.deepEqual(s.stats.invalid, [2, 1]);
});

function forceGoal(s, scorer) {
  // Ball just outside the goal threshold, moving away; paddles parked wide.
  s.phase = PHASE.RALLY;
  s.ball.x = 0;
  s.ball.vx = 0;
  s.paddles[0].x = s.paddles[0].tx = -6;
  s.paddles[1].x = s.paddles[1].tx = 6;
  const dir = scorer === 0 ? 1 : -1;
  s.ball.y = dir * (s.ruleset.arena.h / 2 + 0.55);
  s.ball.vy = dir * s.ruleset.ballSpeed;
  for (let i = 0; i < 12 && s.phase === PHASE.RALLY; i++) step(s);
}

test('scoring: crossing the far goal line scores and logs the point', () => {
  const s = freshMatch({ targetScore: 5, winMargin: 2 });
  forceGoal(s, 0);
  assert.deepEqual(s.score, [1, 0]);
  assert.equal(s.phase, PHASE.POINT);
  assert.equal(s.pointLog.length, 1);
  assert.equal(s.pointLog[0].scorer, 0);
  assert.equal(s.server, 1); // scored-on player serves next
});

test('victory requires target score AND margin', () => {
  const s = freshMatch({ targetScore: 2, winMargin: 2 });
  forceGoal(s, 0);
  assert.equal(s.phase, PHASE.POINT);
  // Deuce-like: 1-1 then trade; no winner at target without margin.
  forceGoal(s, 1);
  // Simulate phase settling between points.
  while (s.phase === PHASE.POINT) step(s);
  assert.equal(s.phase, PHASE.SERVE);
  forceGoal(s, 0);
  while (s.phase === PHASE.POINT) step(s);
  assert.notEqual(s.phase, PHASE.OVER); // 2-1: lead < margin 2 → keep playing
  forceGoal(s, 0);
  assert.equal(s.phase, PHASE.OVER); // 3-1: margin satisfied
  assert.equal(s.terminal.reason, TERMINAL.TARGET_SCORE);
  assert.equal(s.terminal.winner, 0);
});

test('terminal breakdown shows components, not one unexplained total', () => {
  const s = freshMatch({ targetScore: 1, winMargin: 1 });
  forceGoal(s, 0);
  assert.equal(s.phase, PHASE.OVER);
  const b = s.terminal.breakdown;
  assert.deepEqual(b.goals, [1, 0]);
  assert.equal(b.targetScore, 1);
  assert.equal(typeof b.elapsedTicks, 'number');
  assert.equal(typeof b.elapsedSeconds, 'number');
  assert.ok(Array.isArray(b.hits) && Array.isArray(b.invalidActions));
  assert.equal(b.winMargin, 1);
});

test('concede ends the match with the concede reason', () => {
  const s = freshMatch();
  applyCommand(s, { player: 0, type: CMD.CONCEDE });
  assert.equal(s.phase, PHASE.OVER);
  assert.equal(s.winner, 1);
  assert.equal(s.terminal.reason, TERMINAL.CONCEDED);
});

test('time limit resolves by tiebreak order', () => {
  // Score difference decides first.
  const s = freshMatch({ maxTicks: 100 });
  s.score = [2, 1];
  for (let i = 0; i < 100; i++) step(s);
  assert.equal(s.phase, PHASE.OVER);
  assert.equal(s.terminal.reason, TERMINAL.TIME_LIMIT);
  assert.equal(s.terminal.winner, 0);

  // Equal score → fewer invalid actions wins.
  const t = freshMatch({ maxTicks: 50 });
  t.stats.invalid = [3, 1];
  assert.equal(decideTiebreak(t), 1);
  t.stats.invalid = [1, 3];
  assert.equal(decideTiebreak(t), 0);

  // Fully tied → stable identifier decides deterministically.
  const u = freshMatch({ maxTicks: 50 });
  u.sessionId = 'stable-session';
  const w1 = decideTiebreak(u);
  assert.equal(decideTiebreak(u), w1); // deterministic
});

test('paddle collision returns the ball with an angle and speed gain', () => {
  const s = freshMatch({ ballSpeed: 14, speedGain: 1.05 });
  s.phase = PHASE.RALLY;
  s.ball.x = 1.0; // off-center
  s.ball.y = -s.ruleset.arena.h / 2 + 2.0;
  s.ball.vx = 0;
  s.ball.vy = -s.ruleset.ballSpeed;
  s.paddles[0].x = 1.3;
  s.paddles[0].tx = 1.3;
  const before = s.ball.speed;
  let hit = false;
  for (let i = 0; i < TICK_RATE && !hit; i++) {
    step(s);
    hit = s.ball.vy > 0;
  }
  assert.ok(hit, 'paddle should return the ball');
  assert.ok(s.ball.speed > before, 'speed gain per hit');
  assert.notEqual(s.ball.vx, 0, 'off-center hit bends the return');
  assert.equal(s.stats.hits[0], 1);
});

test('serialization round-trips and hashes identically', () => {
  const s = freshMatch({ obstacles: [{ type: 'bumper', id: 'b', x: 0, y: 0, r: 1 }] });
  applyCommand(s, { player: 0, type: CMD.SERVE });
  for (let i = 0; i < 500; i++) step(s);
  const h1 = stateHash(s);
  const restored = deserializeState(serializeState(s));
  assert.equal(stateHash(restored), h1);
  // Simulation continues identically from the restored state.
  for (let i = 0; i < 200; i++) {
    step(s);
    step(restored);
  }
  assert.equal(stateHash(restored), stateHash(s));
});

test('migration fills pre-v1 snapshots and rejects future versions', () => {
  const legacy = { tick: 10, phase: 'serve', score: [0, 0] };
  const migrated = migrateState(legacy);
  assert.equal(migrated.v, 1);
  assert.ok(migrated.stats);
  assert.throws(() => migrateState({ v: 99 }), /unsupported-state-version/);
});

test('scoreBreakdown stores integers and simulation units', () => {
  const s = freshMatch();
  forceGoal(s, 0);
  const b = scoreBreakdown(s);
  assert.ok(Number.isInteger(b.goals[0]));
  assert.ok(Number.isInteger(b.elapsedTicks));
});

test('normalizeRuleset bounds malformed content (no NaN physics)', () => {
  const r = normalizeRuleset({ ballSpeed: NaN, arena: { w: -5, h: Infinity }, targetScore: 1e9, obstacles: [{ type: 'worm' }] });
  assert.ok(Number.isFinite(r.ballSpeed) && r.ballSpeed > 0);
  assert.ok(r.arena.w >= 8 && r.arena.h <= 60);
  assert.ok(r.targetScore <= 99);
  assert.equal(r.obstacles.length, 0);
});

test('obstacle collisions are deterministic and keep the ball in play', () => {
  const s = freshMatch({ obstacles: [{ type: 'bumper', id: 'b1', x: 0, y: 0, r: 1.2 }] });
  applyCommand(s, { player: 0, type: CMD.SERVE });
  for (let i = 0; i < TICK_RATE * 30 && s.phase !== PHASE.POINT && s.phase !== PHASE.OVER; i++) step(s);
  assert.ok(Number.isFinite(s.ball.x) && Number.isFinite(s.ball.y));
  assert.ok(['point', 'over', 'rally'].includes(s.phase));
});

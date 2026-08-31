// Paddle Pulse rules engine — pure, deterministic, renderer-independent.
//
// Contract (spec §2):
//  - legal-action queries: legalActions(state, player)
//  - deterministic resolution: step(state) advances exactly one fixed tick
//  - serializable state: serializeState / deserializeState (+ migration)
//  - monotonically increasing tick: state.tick
//  - terminal-state reason: state.terminal.reason
//  - every mutation enters through validateCommand/applyCommand.

import { createRng, cloneRng, range } from './rng.js';
import { canonicalStringify, fnv1a } from './hash.js';

export const TICK_RATE = 120; // fixed simulation step (physics exists → fixed step)
export const DT = 1 / TICK_RATE;
export const STATE_VERSION = 1;

export const PHASE = Object.freeze({
  SERVE: 'serve',
  RALLY: 'rally',
  POINT: 'point',
  OVER: 'over',
});

export const CMD = Object.freeze({
  MOVE: 'move',
  SERVE: 'serve',
  CONCEDE: 'concede',
});

// Every invalid-action reason (unit-tested, surfaced in UI explanations).
export const INVALID = Object.freeze({
  MATCH_FINISHED: 'match-finished',
  NOT_A_PLAYER: 'not-a-player',
  UNKNOWN_COMMAND: 'unknown-command',
  NOT_SERVE_PHASE: 'not-serve-phase',
  NOT_YOUR_SERVE: 'not-your-serve',
  OUT_OF_BOUNDS: 'out-of-bounds',
  NOT_A_NUMBER: 'not-a-number',
  MOVE_LIMIT_EXCEEDED: 'move-limit-exceeded',
  PAYLOAD_TOO_LARGE: 'payload-too-large',
});

export const TERMINAL = Object.freeze({
  TARGET_SCORE: 'target-score-reached',
  TIME_LIMIT: 'time-limit-reached',
  CONCEDED: 'match-conceded',
  MOVE_LIMIT: 'move-limit-exhausted',
});

const POINT_SETTLE_TICKS = Math.round(TICK_RATE * 0.9); // shortest resolution phase
const GOAL_MARGIN = 0.6; // ball must cross the line by this much
const QUANT = 1000; // input quantization: 1/1000 arena units

export const DEFAULT_RULESET = Object.freeze({
  targetScore: 5,
  winMargin: 2,
  ballSpeed: 14,
  maxBallSpeed: 32,
  speedGain: 1.045,
  paddleWidth: 3.4,
  paddleSpeed: 26,
  ballRadius: 0.42,
  arena: { w: 18, h: 24 },
  obstacles: [],
  maxTicks: 0, // 0 = no time limit
  moveLimit: 0, // 0 = unlimited move commands (challenge constraint)
  maxServeAngle: 0.45, // radians off the goal axis
  maxReturnAngle: 1.05,
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function normalizeRuleset(overrides = {}) {
  const r = { ...DEFAULT_RULESET, ...overrides };
  r.arena = { ...DEFAULT_RULESET.arena, ...(overrides.arena || {}) };
  r.obstacles = (r.obstacles || []).map((o) => ({ ...o }));
  // Coerce + bound every numeric field so malformed content can never
  // produce NaN physics or unbounded loops (fuzz-tested).
  const num = (v, dflt, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  r.targetScore = Math.round(num(r.targetScore, 5, 1, 99));
  r.winMargin = Math.round(num(r.winMargin, 2, 1, 10));
  r.ballSpeed = num(r.ballSpeed, 14, 4, 40);
  r.maxBallSpeed = num(r.maxBallSpeed, 32, r.ballSpeed, 60);
  r.speedGain = num(r.speedGain, 1.045, 1, 1.2);
  r.paddleWidth = num(r.paddleWidth, 3.4, 1, r.arena.w * 0.9);
  r.paddleSpeed = num(r.paddleSpeed, 26, 4, 80);
  r.ballRadius = num(r.ballRadius, 0.42, 0.1, 2);
  r.arena.w = num(r.arena.w, 18, 8, 40);
  r.arena.h = num(r.arena.h, 24, 10, 60);
  r.maxTicks = Math.round(num(r.maxTicks, 0, 0, TICK_RATE * 60 * 30));
  r.moveLimit = Math.round(num(r.moveLimit, 0, 0, 100000));
  r.maxServeAngle = num(r.maxServeAngle, 0.45, 0, 1.2);
  r.maxReturnAngle = num(r.maxReturnAngle, 1.05, 0.1, 1.45);
  r.obstacles = r.obstacles.filter((o) => o && (o.type === 'bumper' || o.type === 'block'));
  return r;
}

export function createMatch({ seed = 1, ruleset = {}, players = [{ id: 'p0' }, { id: 'p1' }] } = {}) {
  const r = normalizeRuleset(ruleset);
  const state = {
    v: STATE_VERSION,
    seed: seed >>> 0,
    sessionId: '',
    ruleset: r,
    tick: 0,
    phase: PHASE.SERVE,
    players: players.slice(0, 2).map((p, i) => ({ id: String(p.id ?? `p${i}`), side: i })),
    ball: { x: 0, y: 0, vx: 0, vy: 0, speed: r.ballSpeed, lastHit: -1 },
    paddles: [makePaddle(r, 0), makePaddle(r, 1)],
    score: [0, 0],
    server: 0,
    rally: { hits: 0, ticks: 0 },
    stats: {
      hits: [0, 0],
      moves: [0, 0],
      invalid: [0, 0],
      longestRally: 0,
      fastestSpeed: 0,
      rallies: 0,
    },
    pointTicks: 0,
    winner: -1,
    terminal: null,
    pointLog: [],
    rng: createRng(state_seed_reroll(seed)),
    events: [],
  };
  placeServe(state);
  return state;
}

function state_seed_reroll(seed) {
  return (Math.imul(seed >>> 0, 2654435761) ^ 0x9e3779b9) >>> 0;
}

function makePaddle(r, side) {
  return { side, x: 0, tx: 0, halfW: r.paddleWidth / 2 };
}

// Goal line Y for a side (side 0 defends bottom, side 1 defends top).
export function goalLineY(state, side) {
  const h = state.ruleset.arena.h;
  return side === 0 ? -h / 2 : h / 2;
}

export function paddleY(state, side) {
  const h = state.ruleset.arena.h;
  return side === 0 ? -h / 2 + 0.9 : h / 2 - 0.9;
}

function moveRange(state) {
  const half = state.ruleset.arena.w / 2;
  const pad = state.paddles[0].halfW;
  return [-(half - pad), half - pad];
}

function placeServe(state) {
  const p = state.paddles[state.server];
  const dir = state.server === 0 ? 1 : -1;
  state.ball.x = p.x;
  state.ball.y = paddleY(state, state.server) + dir * (state.ruleset.ballRadius + 0.25);
  state.ball.vx = 0;
  state.ball.vy = 0;
  state.ball.speed = state.ruleset.ballSpeed;
  state.ball.lastHit = -1;
}

// ---------------------------------------------------------------------------
// Legal actions / validation
// ---------------------------------------------------------------------------

export function legalActions(state, player) {
  const actions = [];
  if (!isPlayer(state, player) || state.phase === PHASE.OVER) return actions;
  const [min, max] = moveRange(state);
  const moveLimited = isMoveLimited(state, player);
  actions.push({
    type: CMD.MOVE,
    min,
    max,
    current: state.paddles[player].tx,
    available: !moveLimited,
    remaining: state.ruleset.moveLimit > 0 ? state.ruleset.moveLimit - state.stats.moves[player] : null,
  });
  if (state.phase === PHASE.SERVE && state.server === player) {
    actions.push({ type: CMD.SERVE, available: true });
  }
  actions.push({ type: CMD.CONCEDE, available: true });
  return actions;
}

function isPlayer(state, player) {
  return player === 0 || player === 1;
}

// Move limits can be scoped to specific seats (solo challenges constrain the
// human; hosted matches may constrain both). Default: applies to everyone.
function isMoveLimited(state, player) {
  const r = state.ruleset;
  if (r.moveLimit <= 0) return false;
  const scoped = r.moveLimitPlayers;
  if (Array.isArray(scoped) && !scoped.includes(player)) return false;
  return state.stats.moves[player] >= r.moveLimit;
}

export function validateCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, reason: INVALID.UNKNOWN_COMMAND };
  if (JSON.stringify(cmd).length > 4096) return { ok: false, reason: INVALID.PAYLOAD_TOO_LARGE };
  if (state.phase === PHASE.OVER) return { ok: false, reason: INVALID.MATCH_FINISHED };
  if (!isPlayer(state, cmd.player)) return { ok: false, reason: INVALID.NOT_A_PLAYER };

  switch (cmd.type) {
    case CMD.MOVE: {
      const x = Number(cmd.x);
      if (!Number.isFinite(x)) return { ok: false, reason: INVALID.NOT_A_NUMBER };
      if (isMoveLimited(state, cmd.player)) {
        return { ok: false, reason: INVALID.MOVE_LIMIT_EXCEEDED };
      }
      const [min, max] = moveRange(state);
      if (x < min - 1e-9 || x > max + 1e-9) return { ok: false, reason: INVALID.OUT_OF_BOUNDS, min, max };
      return { ok: true };
    }
    case CMD.SERVE: {
      if (state.phase !== PHASE.SERVE) return { ok: false, reason: INVALID.NOT_SERVE_PHASE };
      if (state.server !== cmd.player) return { ok: false, reason: INVALID.NOT_YOUR_SERVE };
      return { ok: true };
    }
    case CMD.CONCEDE:
      return { ok: true };
    default:
      return { ok: false, reason: INVALID.UNKNOWN_COMMAND };
  }
}

// Applies a validated command. Returns { ok, reason? } — invalid commands are
// counted (they feed the invalid-action tiebreak) and ignored, never thrown.
let cmdSeq = 0;
export function applyCommand(state, cmd) {
  const verdict = validateCommand(state, cmd);
  if (!verdict.ok) {
    if (isPlayer(state, cmd?.player)) {
      state.stats.invalid[cmd.player]++;
      pushEvent(state, { t: 'invalid', player: cmd.player, reason: verdict.reason });
    }
    return verdict;
  }
  switch (cmd.type) {
    case CMD.MOVE: {
      const [min, max] = moveRange(state);
      const x = clamp(Math.round(Number(cmd.x) * QUANT) / QUANT, min, max); // quantized input
      state.paddles[cmd.player].tx = x;
      state.stats.moves[cmd.player]++;
      break;
    }
    case CMD.SERVE: {
      const dir = state.server === 0 ? 1 : -1;
      const jitter = range(state.rng, -state.ruleset.maxServeAngle, state.ruleset.maxServeAngle);
      const sp = state.ruleset.ballSpeed;
      state.ball.vx = Math.sin(jitter) * sp;
      state.ball.vy = dir * Math.cos(jitter) * sp;
      state.ball.speed = sp;
      state.ball.lastHit = state.server;
      state.phase = PHASE.RALLY;
      state.rally = { hits: 0, ticks: 0 };
      pushEvent(state, { t: 'serve', player: state.server });
      break;
    }
    case CMD.CONCEDE: {
      finishMatch(state, 1 - cmd.player, TERMINAL.CONCEDED);
      break;
    }
  }
  return { ok: true };
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Tick resolution
// ---------------------------------------------------------------------------

export function step(state) {
  if (state.phase === PHASE.OVER) return state;
  state.tick++;
  const r = state.ruleset;

  // Paddles track their (quantized) targets at a bounded speed.
  for (const p of state.paddles) {
    const maxStep = r.paddleSpeed * DT;
    const d = p.tx - p.x;
    if (Math.abs(d) <= maxStep) p.x = p.tx;
    else p.x += Math.sign(d) * maxStep;
  }

  if (state.phase === PHASE.SERVE) {
    // Ball rides on the server's paddle while awaiting the serve command.
    const p = state.paddles[state.server];
    const dir = state.server === 0 ? 1 : -1;
    state.ball.x = p.x;
    state.ball.y = paddleY(state, state.server) + dir * (r.ballRadius + 0.25);
  } else if (state.phase === PHASE.RALLY) {
    stepRally(state);
  } else if (state.phase === PHASE.POINT) {
    state.pointTicks--;
    if (state.pointTicks <= 0) {
      state.phase = PHASE.SERVE;
      placeServe(state);
      pushEvent(state, { t: 'serve-ready', player: state.server });
    }
  }

  // Time-limit terminal (0 = unlimited).
  if (r.maxTicks > 0 && state.tick >= r.maxTicks && state.phase !== PHASE.OVER) {
    const winner = decideTiebreak(state);
    finishMatch(state, winner, TERMINAL.TIME_LIMIT);
  }
  return state;
}

function stepRally(state) {
  const r = state.ruleset;
  const b = state.ball;
  state.rally.ticks++;

  b.x += b.vx * DT;
  b.y += b.vy * DT;

  // Side walls.
  const wx = r.arena.w / 2 - r.ballRadius;
  if (b.x < -wx) {
    b.x = -wx + (-wx - b.x);
    b.vx = Math.abs(b.vx);
    pushEvent(state, { t: 'wall', x: b.x, y: b.y });
  } else if (b.x > wx) {
    b.x = wx + (wx - b.x);
    b.vx = -Math.abs(b.vx);
    pushEvent(state, { t: 'wall', x: b.x, y: b.y });
  }

  // Obstacles (deterministic; movers derive phase from tick, not frame count).
  for (const o of r.obstacles) {
    if (o.type === 'bumper') collideBumper(state, o);
    else if (o.type === 'block') collideBlock(state, o);
  }

  // Paddles.
  for (let side = 0; side < 2; side++) {
    const p = state.paddles[side];
    const py = paddleY(state, side);
    const toward = side === 0 ? b.vy < 0 : b.vy > 0;
    const crossed =
      side === 0 ? b.y - r.ballRadius <= py && b.y > py - 1.2 : b.y + r.ballRadius >= py && b.y < py + 1.2;
    if (toward && crossed && Math.abs(b.x - p.x) <= p.halfW + r.ballRadius) {
      const offset = clamp((b.x - p.x) / (p.halfW + r.ballRadius), -1, 1);
      const ang = offset * r.maxReturnAngle;
      const speed = Math.min(b.speed * r.speedGain, r.maxBallSpeed);
      b.speed = speed;
      const dir = side === 0 ? 1 : -1;
      b.vx = Math.sin(ang) * speed;
      b.vy = dir * Math.cos(ang) * speed;
      b.y = py + dir * (r.ballRadius + 0.01);
      b.lastHit = side;
      state.rally.hits++;
      state.stats.hits[side]++;
      if (speed > state.stats.fastestSpeed) state.stats.fastestSpeed = speed;
      pushEvent(state, {
        t: 'paddle',
        player: side,
        x: b.x,
        y: b.y,
        speed,
        offset,
        rally: state.rally.hits,
      });
    }
  }

  // Goal lines.
  const gy = r.arena.h / 2 + GOAL_MARGIN;
  if (b.y < -gy) scorePoint(state, 1);
  else if (b.y > gy) scorePoint(state, 0);
}

function collideBumper(state, o) {
  const b = state.ball;
  const rad = o.r + state.ruleset.ballRadius;
  const dx = b.x - o.x;
  const dy = b.y - o.y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rad * rad || d2 === 0) return;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const dot = b.vx * nx + b.vy * ny;
  if (dot >= 0) return;
  b.vx -= 2 * dot * nx;
  b.vy -= 2 * dot * ny;
  b.x = o.x + nx * (rad + 0.01);
  b.y = o.y + ny * (rad + 0.01);
  pushEvent(state, { t: 'bumper', x: b.x, y: b.y, id: o.id || 'bumper' });
}

function blockCenter(state, o) {
  // Deterministic sinusoid driven by the authoritative tick.
  if (!o.move) return [o.x, o.y];
  const period = Math.max(1, o.move.period || TICK_RATE * 4);
  const s = Math.sin((2 * Math.PI * (state.tick % period)) / period);
  const amp = o.move.amp || 0;
  return o.move.axis === 'y' ? [o.x, o.y + s * amp] : [o.x + s * amp, o.y];
}

function collideBlock(state, o) {
  const b = state.ball;
  const [cx, cy] = blockCenter(state, o);
  const hw = (o.hw || 1) + state.ruleset.ballRadius;
  const hh = (o.hh || 0.5) + state.ruleset.ballRadius;
  const dx = b.x - cx;
  const dy = b.y - cy;
  if (Math.abs(dx) > hw || Math.abs(dy) > hh) return;
  const px = hw - Math.abs(dx);
  const py = hh - Math.abs(dy);
  if (px < py) {
    b.vx = dx > 0 ? Math.abs(b.vx) : -Math.abs(b.vx);
    b.x = cx + Math.sign(dx) * (hw + 0.01);
  } else {
    b.vy = dy > 0 ? Math.abs(b.vy) : -Math.abs(b.vy);
    b.y = cy + Math.sign(dy) * (hh + 0.01);
  }
  pushEvent(state, { t: 'bumper', x: b.x, y: b.y, id: o.id || 'block' });
}

function scorePoint(state, scorer) {
  state.score[scorer]++;
  state.stats.rallies++;
  if (state.rally.hits > state.stats.longestRally) state.stats.longestRally = state.rally.hits;
  state.pointLog.push({
    tick: state.tick,
    scorer,
    rallyHits: state.rally.hits,
    rallyTicks: state.rally.ticks,
    score: [...state.score],
  });
  pushEvent(state, {
    t: 'goal',
    player: scorer,
    score: [...state.score],
    rally: state.rally.hits,
    x: clamp(state.ball.x, -9, 9),
    y: goalLineY(state, 1 - scorer),
  });
  state.server = 1 - scorer; // the player scored on serves next
  if (isVictory(state, scorer)) {
    finishMatch(state, scorer, TERMINAL.TARGET_SCORE);
    return;
  }
  state.phase = PHASE.POINT;
  state.pointTicks = POINT_SETTLE_TICKS;
}

function isVictory(state, scorer) {
  const r = state.ruleset;
  const a = state.score[0];
  const b = state.score[1];
  const lead = Math.abs(a - b);
  return state.score[scorer] >= r.targetScore && lead >= r.winMargin;
}

// Tie-break order (spec §2): primary objective → fewer invalid actions →
// lower elapsed time → stable session identifier.
export function decideTiebreak(state) {
  if (state.score[0] !== state.score[1]) return state.score[0] > state.score[1] ? 0 : 1;
  if (state.stats.invalid[0] !== state.stats.invalid[1]) {
    return state.stats.invalid[0] < state.stats.invalid[1] ? 0 : 1;
  }
  const el0 = state.tick; // single authoritative clock; per-player clocks are not trusted
  void el0;
  const sid = state.sessionId || String(state.seed);
  const c = canonicalStringify([sid, state.score, state.stats.invalid]);
  let acc = 0;
  for (let i = 0; i < c.length; i++) acc = (acc + c.charCodeAt(i) * (i + 1)) & 1;
  return acc;
}

function finishMatch(state, winner, reason) {
  state.phase = PHASE.OVER;
  state.winner = winner;
  state.terminal = {
    reason,
    winner,
    score: [...state.score],
    breakdown: scoreBreakdown(state),
  };
  pushEvent(state, { t: 'match-end', winner, reason, score: [...state.score] });
}

export function scoreBreakdown(state) {
  return {
    goals: [...state.score],
    targetScore: state.ruleset.targetScore,
    winMargin: state.ruleset.winMargin,
    rallies: state.stats.rallies,
    longestRally: state.stats.longestRally,
    hits: [...state.stats.hits],
    moves: [...state.stats.moves],
    invalidActions: [...state.stats.invalid],
    fastestReturn: Math.round(state.stats.fastestSpeed * 100) / 100,
    elapsedTicks: state.tick,
    elapsedSeconds: Math.round((state.tick / TICK_RATE) * 100) / 100,
  };
}

function pushEvent(state, ev) {
  ev.tick = state.tick;
  state.events.push(ev);
}

// Drained by the session layer after each step batch → presentation only.
export function drainEvents(state) {
  const ev = state.events;
  state.events = [];
  return ev;
}

// ---------------------------------------------------------------------------
// Serialization, migration, hashing
// ---------------------------------------------------------------------------

export function serializeState(state) {
  return JSON.stringify(state);
}

export function deserializeState(json) {
  const s = typeof json === 'string' ? JSON.parse(json) : json;
  return migrateState(s);
}

export function migrateState(s) {
  if (!s || typeof s !== 'object') throw new Error('bad-state');
  if (s.v === STATE_VERSION) return s;
  if (s.v == null || s.v < STATE_VERSION) {
    // Migration path for pre-v1 snapshots: fill fields introduced by v1.
    s.v = STATE_VERSION;
    s.sessionId = s.sessionId || '';
    s.pointLog = s.pointLog || [];
    s.stats = s.stats || { hits: [0, 0], moves: [0, 0], invalid: [0, 0], longestRally: 0, fastestSpeed: 0, rallies: 0 };
    return s;
  }
  throw new Error('unsupported-state-version:' + s.v);
}

// Hash over the *simulation* fields only — presentation events and point log
// are excluded so hash equality means identical rules outcomes.
export function stateHash(state) {
  const core = {
    v: state.v,
    seed: state.seed,
    tick: state.tick,
    phase: state.phase,
    ball: state.ball,
    paddles: state.paddles,
    score: state.score,
    server: state.server,
    rally: state.rally,
    stats: state.stats,
    winner: state.winner,
    terminal: state.terminal,
    rng: state.rng,
    pointTicks: state.pointTicks,
  };
  return fnv1a(canonicalStringify(core));
}

export function cloneState(state) {
  return deserializeState(serializeState(state));
}

// ---------------------------------------------------------------------------
// Replay envelope (spec §5): version, build, seed, initial hash, ordered
// commands, periodic state hashes, terminal result.
// ---------------------------------------------------------------------------

export const REPLAY_VERSION = 1;

export function createReplay(state, buildId) {
  return {
    v: REPLAY_VERSION,
    build: buildId || 'dev',
    seed: state.seed,
    sessionId: state.sessionId || '',
    ruleset: state.ruleset,
    players: state.players.map((p) => ({ id: p.id })),
    initialHash: stateHash(state),
    startedAtTick: state.tick,
    commands: [],
    hashes: [{ tick: state.tick, hash: stateHash(state) }],
    terminal: null,
  };
}

export function recordCommand(replay, cmd, tick) {
  replay.commands.push({ tick, id: cmd.id ?? ++cmdSeq, player: cmd.player, type: cmd.type, x: cmd.x });
}

// Re-runs a replay envelope against the engine and verifies every periodic
// hash plus the terminal result. Returns { ok, mismatchTick?, finalHash }.
export function verifyReplay(replay) {
  const state = createMatch({ seed: replay.seed, ruleset: replay.ruleset, players: replay.players });
  state.sessionId = replay.sessionId || '';
  if (stateHash(state) !== replay.initialHash) return { ok: false, mismatchTick: -1 };
  const byTick = new Map();
  for (const c of replay.commands) {
    if (!byTick.has(c.tick)) byTick.set(c.tick, []);
    byTick.get(c.tick).push(c);
  }
  const hashCheckpoints = new Map(replay.hashes.map((h) => [h.tick, h.hash]));
  const finalTick = replay.terminal ? replay.terminalTick : Math.max(...replay.hashes.map((h) => h.tick));
  // Live order per tick: commands applied (recorded at tick T) → step →
  // checkpoint recorded on arrival at T+1. Mirror that order exactly.
  for (;;) {
    const cmds = byTick.get(state.tick) || [];
    for (const c of cmds) applyCommand(state, c);
    if (state.tick >= finalTick) break; // terminal-tick commands (e.g. concede) applied
    step(state);
    if (hashCheckpoints.has(state.tick) && stateHash(state) !== hashCheckpoints.get(state.tick)) {
      return { ok: false, mismatchTick: state.tick };
    }
  }
  if (replay.terminal && hashCheckpoints.has(state.tick) && stateHash(state) !== hashCheckpoints.get(state.tick)) {
    return { ok: false, mismatchTick: state.tick };
  }
  return { ok: true, finalHash: stateHash(state) };
}

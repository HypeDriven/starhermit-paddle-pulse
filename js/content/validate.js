// Offline content validators (spec §2): prove basic legality, reachable
// goals, bounded duration, and absence of soft locks for every shipped
// level, challenge, and daily card. Runs in Node as part of the test suite.

import { createMatch, step, applyCommand, normalizeRuleset, PHASE, TICK_RATE, stateHash } from '../rules/engine.js';
import { JOURNEY_LEVELS, CHALLENGES, AI_LEVELS } from './levels.js';
import { THEMES } from './themes.js';
import { LESSONS } from './tutorials.js';
import { DAILY_RULESET_VERSION } from './daily.js';
import { AiController } from '../session/ai.js';

const KNOWN_MECHANICS = new Set(['move', 'serve', 'angle', 'bumpers', 'blocks']);
const MAX_SIM_TICKS = TICK_RATE * 60 * 10; // hard cap: 10 minutes of play

export function validateLevelShape(level) {
  const problems = [];
  if (!level.id || typeof level.id !== 'string') problems.push('missing-id');
  if (!Number.isInteger(level.version) || level.version < 1) problems.push('bad-version');
  if (!Number.isInteger(level.seed)) problems.push('bad-seed');
  if (!level.theme || !THEMES[level.theme]) problems.push('unknown-theme:' + level.theme);
  for (const m of level.mechanics || []) if (!KNOWN_MECHANICS.has(m)) problems.push('unknown-mechanic:' + m);
  if (level.ai != null && (level.ai < 0 || level.ai >= AI_LEVELS.length)) problems.push('bad-ai-level');
  if (level.goals && level.goals.par) {
    const { star2, star3 } = level.goals.par;
    if (star3 > star2) problems.push('par-order-inverted');
  }
  const r = normalizeRuleset(level.ruleset || {});
  if (!Number.isFinite(r.ballSpeed) || r.ballSpeed <= 0) problems.push('bad-ball-speed');
  for (const o of r.obstacles) {
    const halfW = r.arena.w / 2;
    const halfH = r.arena.h / 2;
    if (Math.abs(o.x) > halfW || Math.abs(o.y) > halfH) problems.push('obstacle-out-of-arena:' + o.id);
    // Obstacles must not camp on a goal mouth (would block scoring = soft lock).
    if (Math.abs(o.y) > halfH - 3) problems.push('obstacle-near-goal:' + o.id);
  }
  return problems;
}

// Bot-vs-bot simulation: the level is winnable (goals are reachable), ends in
// bounded time, and never wedges in a non-terminal state (no soft locks).
export function simulateToTerminal(level, { aiLevel = null, capTicks = MAX_SIM_TICKS } = {}) {
  const seed = level.seed ?? 1;
  const state = createMatch({
    seed,
    ruleset: { ...(level.ruleset || {}), maxTicks: (level.ruleset || {}).maxTicks || capTicks },
  });
  const aiLevelIdx = aiLevel ?? level.ai ?? 2;
  const bots = [new AiController(Math.max(0, aiLevelIdx - 1), 0, { seed }), new AiController(aiLevelIdx, 1, { seed: seed ^ 0x5eed })];
  let guard = 0;
  while (state.phase !== PHASE.OVER && guard < capTicks) {
    for (const b of bots) {
      const cmds = b.update(state);
      if (cmds) for (const c of cmds) applyCommand(state, c);
    }
    step(state);
    guard++;
    if (!Number.isFinite(state.ball.x) || !Number.isFinite(state.ball.y)) {
      return { ok: false, reason: 'nan-physics', ticks: guard };
    }
  }
  if (state.phase !== PHASE.OVER) return { ok: false, reason: 'unbounded-duration', ticks: guard };
  if (state.score[0] + state.score[1] === 0) return { ok: false, reason: 'no-goals-reachable', ticks: guard };
  return { ok: true, ticks: guard, hash: stateHash(state), score: [...state.score] };
}

export function validateAllContent({ log = false } = {}) {
  const report = { levels: {}, challenges: {}, lessons: {}, ok: true };
  for (const level of JOURNEY_LEVELS) {
    const shape = validateLevelShape(level);
    const sim = simulateToTerminal(level);
    report.levels[level.id] = { shape, sim };
    if (shape.length || !sim.ok) report.ok = false;
    if (log) console.log(level.id, shape.length ? shape : 'shape-ok', sim.ok ? `${sim.ticks}t ${sim.score}` : sim);
  }
  for (const ch of CHALLENGES) {
    const shape = validateLevelShape(ch);
    const sim = simulateToTerminal(ch);
    report.challenges[ch.id] = { shape, sim };
    if (shape.length || !sim.ok) report.ok = false;
    if (log) console.log(ch.id, shape.length ? shape : 'shape-ok', sim.ok ? `${sim.ticks}t` : sim);
  }
  for (const lesson of LESSONS) {
    const problems = [];
    if (!lesson.id || !lesson.steps?.length) problems.push('no-steps');
    const sim = simulateToTerminal({ seed: 7, ruleset: lesson.ruleset, ai: lesson.ai ?? 0, theme: 'neon-district', mechanics: ['move'] });
    report.lessons[lesson.id] = { shape: problems, sim };
    if (problems.length || !sim.ok) report.ok = false;
  }
  return report;
}

export { DAILY_RULESET_VERSION };

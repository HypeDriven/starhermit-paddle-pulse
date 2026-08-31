// AI opponent. Lives in the session layer and drives the rules engine through
// the same validated command path as humans — no privileged state access.
// Deterministic per match seed so replays/goldens are reproducible.

import { CMD, TICK_RATE, paddleY } from '../rules/engine.js';
import { createRng, next } from '../rules/rng.js';
import { AI_LEVELS } from '../content/levels.js';

export class AiController {
  constructor(levelIndex = 2, player = 1, { idle = false, seed = 1 } = {}) {
    const lvl = AI_LEVELS[Math.max(0, Math.min(AI_LEVELS.length - 1, levelIndex))];
    this.level = lvl;
    this.player = player;
    this.idle = idle;
    this.rng = createRng(seed ^ 0xa11ce);
    this.cool = 0;
    this.serveIn = -1;
    this.lastIssued = null;
    this.cmdSeq = 0;
    this.errKey = -1;
    this.errValue = 0;
  }

  // Called once per tick before engine.step. Returns commands (usually none).
  update(state) {
    if (state.phase === 'over') return null;
    const cmds = [];
    const me = state.paddles[this.player];
    const r = state.ruleset;

    if (state.phase === 'serve' && state.server === this.player) {
      if (this.serveIn < 0) this.serveIn = Math.floor(TICK_RATE * (0.6 + next(this.rng) * 0.8));
      if (--this.serveIn <= 0) {
        cmds.push({ id: `ai-${this.player}-${++this.cmdSeq}`, player: this.player, type: CMD.SERVE });
        this.serveIn = -1;
      }
      // Also drift with the held ball for a less predictable serve.
      if (this.cool-- <= 0) cmds.push(this.moveCmd(state, this.serveTarget(state)));
      return cmds.filter(Boolean);
    }

    if (state.phase !== 'rally') return null;
    if (this.idle) return null;
    if (this.cool-- > 0) return null;
    this.cool = this.level.reactTicks;

    const b = state.ball;
    const toward = this.player === 1 ? b.vy > 0 : b.vy < 0;
    let target;
    if (toward) {
      const intercept = predictIntercept(state, this.player);
      const blended = b.x + (intercept - b.x) * (0.35 + 0.65 * this.level.anticipate);
      // The aiming error is sampled ONCE per incoming shot (not continuously):
      // re-sampling would self-correct over the flight. Fast, long shots
      // carry the largest persistent misjudgment.
      const shotKey = state.rally.hits * 2 + (b.lastHit === this.player ? 1 : 0);
      if (this.errKey !== shotKey) {
        this.errKey = shotKey;
        const t = timeToReach(state, this.player);
        const distFactor = Math.min(2.6, (b.speed * Math.max(0, t)) / r.arena.h * 2.4);
        const speedFactor = 0.4 + 2.2 * (b.speed / r.maxBallSpeed) ** 2;
        // 1.7x gives the distribution a tail beyond paddle reach — even the
        // best AI whiffs occasionally on fast, long shots.
        this.errValue = (next(this.rng) * 2 - 1) * this.level.error * (speedFactor + distFactor) * 1.7;
      }
      target = blended + (this.errValue || 0);
    } else {
      // Recover toward center, weighted to the ball side slightly.
      target = b.x * 0.15;
    }
    const cmd = this.moveCmd(state, target);
    return cmd ? [cmd] : null;
  }

  serveTarget(state) {
    const me = state.paddles[this.player];
    return me.x + (next(this.rng) * 2 - 1) * 1.5;
  }

  moveCmd(state, target) {
    const half = state.ruleset.arena.w / 2 - state.paddles[this.player].halfW;
    const clamped = Math.max(-half, Math.min(half, target));
    if (this.lastIssued != null && Math.abs(clamped - this.lastIssued) < 0.3) return null;
    this.lastIssued = clamped;
    return { id: `ai-${this.player}-${++this.cmdSeq}`, player: this.player, type: CMD.MOVE, x: clamped };
  }

  // AI state is session state — serialized so resumed/reconnected sessions
  // continue bit-exactly (spec §5: last safe local snapshot).
  serialize() {
    return {
      rngN: this.rng.n,
      cool: this.cool,
      serveIn: this.serveIn,
      lastIssued: this.lastIssued,
      cmdSeq: this.cmdSeq,
      errKey: this.errKey,
      errValue: this.errValue,
    };
  }

  restore(saved) {
    if (!saved) return;
    this.rng.n = saved.rngN >>> 0;
    this.cool = saved.cool;
    this.serveIn = saved.serveIn;
    this.lastIssued = saved.lastIssued;
    this.cmdSeq = saved.cmdSeq;
    this.errKey = saved.errKey ?? -1;
    this.errValue = saved.errValue ?? 0;
  }
}

// Seconds until the ball reaches the player's paddle plane (0 if receding).
export function timeToReach(state, player) {
  const b = state.ball;
  if (player === 1 ? b.vy <= 0 : b.vy >= 0) return 0;
  const py = paddleY(state, player);
  const t = (py - b.y) / b.vy;
  return Number.isFinite(t) && t > 0 ? t : 0;
}

// Mirrors the ball with wall bounces until it reaches the AI's paddle plane.
export function predictIntercept(state, player) {
  const r = state.ruleset;
  const b = state.ball;
  const py = paddleY(state, player);
  const vy = b.vy || 1e-6;
  const t = (py - b.y) / vy;
  if (t <= 0 || !Number.isFinite(t)) return b.x;
  const wx = r.arena.w / 2 - r.ballRadius;
  let x = b.x + b.vx * t;
  // Reflect into [-wx, wx] via triangle wave.
  const period = 4 * wx;
  let m = ((x + wx) % period + period) % period;
  if (m > 2 * wx) m = period - m;
  return m - wx;
}

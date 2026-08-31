// Session layer: wraps the rules engine with command intake, dedupe, replay
// recording, AI seats, snapshots/undo, and interpolation data for rendering.
// No module may mutate rules state except through a validated command — this
// is the only place applyCommand/step are called on behalf of players.

import {
  createMatch, step, applyCommand, drainEvents, cloneState, createReplay,
  recordCommand, stateHash, serializeState, deserializeState, PHASE, TICK_RATE,
} from '../rules/engine.js';
import { AiController } from './ai.js';

let cmdCounter = 0;
export function nextCmdId(player) {
  return `c${player}-${(++cmdCounter).toString(36)}-${Date.now().toString(36)}`;
}

export class LocalMatch {
  /**
   * seats: [{ kind:'human', name }, { kind:'ai', level, name }] — player 0/1.
   * opts: { mode, contentId, ruleset, seed, allowUndo, sessionId, build }
   */
  constructor({ seats, mode = 'practice', contentId = '', ruleset = {}, seed = 1, allowUndo = false, sessionId = '', build = 'dev', aiIdle = false }) {
    this.mode = mode;
    this.contentId = contentId;
    this.seats = seats;
    this.allowUndo = allowUndo;
    this.state = createMatch({ seed, ruleset, players: seats.map((s, i) => ({ id: s.id || `p${i}` })) });
    this.state.sessionId = sessionId || `${seed.toString(36)}-${Date.now().toString(36)}`;
    this.replay = createReplay(this.state, build);
    this.replay.mode = mode;
    this.replay.contentId = contentId;
    this.ai = seats.map((s, i) => (s.kind === 'ai' ? new AiController(s.level ?? 2, i, { idle: aiIdle && i === 1, seed }) : null));
    this.seenCmds = new Set();
    this.snapshots = [];
    this.lastServePhase = true;
    this._prev = cloneState(this.state);
  }

  get finished() {
    return this.state.phase === PHASE.OVER;
  }

  get result() {
    return this.state.terminal;
  }

  // Idempotent by command id; invalid commands are counted and explained.
  submit(cmd) {
    if (!cmd.id) cmd.id = nextCmdId(cmd.player);
    if (this.seenCmds.has(cmd.id)) return { ok: true, duplicate: true };
    this.seenCmds.add(cmd.id);
    const res = applyCommand(this.state, cmd);
    if (res.ok) recordCommand(this.replay, cmd, this.state.tick);
    else if (this.seenCmds.size > 4096) this.seenCmds.clear(); // bound memory
    return res;
  }

  // Advance exactly one tick; returns drained presentation events.
  step() {
    if (this.finished) return [];
    copySimInto(this._prev, this.state); // previous tick, for render interpolation
    for (const ctl of this.ai) {
      if (!ctl) continue;
      const cmds = ctl.update(this.state);
      if (cmds) for (const c of cmds) this.submit(c);
    }
    step(this.state);
    const events = drainEvents(this.state);

    // Undo restore point: whenever we (re)enter the serve phase.
    const servePhase = this.state.phase === PHASE.SERVE;
    if (this.allowUndo && servePhase && !this.lastServePhase) {
      this.snapshots.push(serializeState(this.state));
      if (this.snapshots.length > 24) this.snapshots.shift();
    }
    this.lastServePhase = servePhase;

    // Periodic replay checkpoints (~1/s) + terminal record.
    if (this.state.tick % TICK_RATE === 0) {
      this.replay.hashes.push({ tick: this.state.tick, hash: stateHash(this.state) });
    }
    if (this.finished && !this.replay.terminal) {
      this.replay.terminal = this.state.terminal;
      this.replay.terminalTick = this.state.tick;
      this.replay.hashes.push({ tick: this.state.tick, hash: stateHash(this.state) });
    }
    return events;
  }

  // Interpolation alpha data for rendering: previous + current ball/paddles.
  interpolation(alpha) {
    return { prev: this._prev, cur: this.state, alpha };
  }

  undo() {
    if (!this.allowUndo || this.snapshots.length === 0) return false;
    const snap = this.snapshots.pop();
    this.state = deserializeState(snap);
    this._prev = cloneState(this.state);
    this.lastServePhase = true;
    // Replay continuity: start a fresh envelope from the restored state.
    this.replay = createReplay(this.state, this.replay.build);
    this.replay.mode = this.mode;
    this.replay.contentId = this.contentId;
    this.replay.undoFrom = true;
    return true;
  }

  snapshot() {
    return JSON.stringify({
      state: JSON.parse(serializeState(this.state)),
      replay: this.replay,
      mode: this.mode,
      contentId: this.contentId,
      seats: this.seats.map((s) => ({ ...s })),
      ai: this.ai.map((a) => (a ? a.serialize() : null)),
      allowUndo: this.allowUndo,
    });
  }

  static restore(json, build = 'dev') {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const m = Object.create(LocalMatch.prototype);
    m.mode = data.mode;
    m.contentId = data.contentId;
    m.seats = data.seats;
    m.allowUndo = data.allowUndo;
    m.state = deserializeState(JSON.stringify(data.state));
    m.replay = data.replay || createReplay(m.state, build);
    m.ai = data.seats.map((s, i) => {
      if (s.kind !== 'ai') return null;
      const ctl = new AiController(s.level ?? 2, i, { seed: m.state.seed });
      ctl.restore(data.ai?.[i]);
      return ctl;
    });
    m.seenCmds = new Set();
    m.snapshots = [];
    m.lastServePhase = m.state.phase === PHASE.SERVE;
    m._prev = cloneState(m.state);
    return m;
  }
}

function copySimInto(dst, src) {
  dst.tick = src.tick;
  dst.phase = src.phase;
  dst.ball = { ...src.ball };
  dst.paddles = src.paddles.map((p) => ({ ...p }));
  dst.score = [...src.score];
  dst.server = src.server;
}

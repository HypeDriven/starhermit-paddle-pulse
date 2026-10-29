// Writes the play scripts that play whole matches through the real UI
// (tests/native/journey-1.play): a bot plays Journey stage 1 on the browser
// build's own rules and session (js/session/match.js) exactly as
// native/main.ts drives them — the key-held paddle target (pollInputs: the
// target runs at the paddle speed while ← / → is held, a move is sent when it
// is 0.25 off), Space serving on the press, the fixed 120 Hz steps — and the
// key changes become hold / release lines timed in fixed steps.
//
// Timing (measured on the 1.23.0 render check, one fixed step a frame): after
// `until =GO` (the countdown's GO label, 78 steps before tick 0), a key line
// after `frames N` acts on tick N − 74; each hold / release line takes one
// step and `frames N` takes N + 1. Decisions are taken every 4 ticks, one key
// change at a time. The bot aims each point's returns off the paddle's centre
// and searches the aim per point until it wins the match.
//
//   node tools/gen-plays.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalMatch } from '../js/session/match.js';
import { CMD, PHASE, DT } from '../js/rules/engine.js';
import { predictIntercept } from '../js/session/ai.js';
import { getJourneyLevel } from '../js/content/levels.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GO_OFFSET = 74;
const DEC = 4;
const AIMS = [0.55, -0.55, 0.8, -0.8, 0.3, -0.3, 0, 0.95, -0.95];

/** One match on the journey level; `aims[i]` is the aim of the i-th point. Returns the result and the key log. */
export function simulate(level, aims, maxTicks = 120 * 60 * 6) {
  const seats = [{ kind: 'human', name: 'Guest' }, { kind: 'ai', level: level.ai, name: 'AI' }];
  const m = new LocalMatch({ seats, mode: 'journey', contentId: level.id, ruleset: { ...level.ruleset }, seed: level.seed, allowUndo: false, build: 'gen' });
  const held = new Set();
  const log = []; // { tick, op: 'hold'|'release', key }
  let keyTarget = 0, lastMoveSent = 0, served = -1, spaceDown = false;
  const change = (op, key) => { log.push({ tick: m.state.tick, op, key }); if (op === 'hold') held.add(key); else held.delete(key); };
  while (!m.finished && m.state.tick < maxTicks) {
    const s = m.state;
    const point = s.score[0] + s.score[1];
    if (point >= aims.length) return { m, log, point, open: true };
    // decisions (one key change per decision tick), applied as the frame's key events before the step
    if (s.tick % DEC === 0) {
      let want = null;
      // (tick 0: the countdown's last timer turns the match active after the frame's key events, so a press there is not play yet)
      if (s.tick > 0 && s.phase === PHASE.SERVE && s.server === 0 && served !== point) want = 'serve';
      let dirWant = 0;
      if (s.phase === PHASE.RALLY && s.ball.vy < 0) {
        const p = s.paddles[0];
        const x = predictIntercept(s, 0) - aims[point] * p.halfW;
        const half = s.ruleset.arena.w / 2 - p.halfW;
        const goal = Math.max(-half, Math.min(half, x));
        if (goal > keyTarget + 0.35) dirWant = 1; else if (goal < keyTarget - 0.35) dirWant = -1;
      }
      if (spaceDown) { change('release', 'Space'); spaceDown = false; }
      else if (want === 'serve' && !held.has('ArrowLeft') && !held.has('ArrowRight')) {
        change('hold', 'Space'); spaceDown = true; served = point;
        const r = m.submit({ player: 0, type: CMD.SERVE }); // onAction: before the step
        void r;
      } else {
        const cur = held.has('ArrowRight') ? 1 : held.has('ArrowLeft') ? -1 : 0;
        if (cur !== dirWant) {
          if (cur !== 0) change('release', cur > 0 ? 'ArrowRight' : 'ArrowLeft');
          else change('hold', dirWant > 0 ? 'ArrowRight' : 'ArrowLeft');
        }
      }
    }
    // pollInputs (native/main.ts)
    const p0 = s.paddles[0];
    const half = s.ruleset.arena.w / 2 - p0.halfW;
    const dir = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0);
    if (dir !== 0) {
      keyTarget = Math.max(-half, Math.min(half, keyTarget + dir * s.ruleset.paddleSpeed * DT));
      if (Math.abs(keyTarget - p0.tx) > 0.25 && Math.abs(keyTarget - lastMoveSent) >= 0.05) {
        lastMoveSent = keyTarget;
        m.submit({ player: 0, type: CMD.MOVE, x: keyTarget });
      }
    } else keyTarget = p0.tx;
    m.step();
  }
  return { m, log, point: m.state.score[0] + m.state.score[1], open: false };
}

/** Searches each point's aim until the match is won. */
export function winningPlan(level) {
  const aims = [];
  for (let guard = 0; guard < 60; guard++) {
    let best = null;
    for (const a of AIMS) {
      const r = simulate(level, [...aims, a]);
      const before = aims.length;
      if (!r.open && r.m.finished) { if (r.m.result.winner === 0) return { aims: [...aims, a], run: r }; continue; }
      // the point decided: prefer an aim that won it
      const sc = r.m.state.pointLog[before];
      if (sc && sc.scorer === 0) { best = a; break; }
      if (best === null) best = a;
    }
    aims.push(best);
  }
  throw new Error('no winning plan');
}

function script(level, run) {
  const { log, m } = run;
  const first = log[0].tick;
  // a hold line takes one step: `frames gap-2` + the next line puts it gap steps after the one before
  const out = [];
  let tk = first;
  for (let i = 0; i < log.length; i++) {
    const e = log[i];
    if (i > 0) { const gap = e.tick - tk; out.push(`frames ${gap - 2}`); }
    out.push(`${e.op} ${e.key}`);
    tk = e.tick;
  }
  const r = m.result;
  return {
    head: [`until 400 =GO`, `frames ${first + GO_OFFSET}`],
    body: out,
    result: r,
  };
}

const level = getJourneyLevel(1);
const plan = winningPlan(level);
const sc = script(level, plan.run);
const r = sc.result;
const text = [
  '# Journey stage 1 (First Contact) won through the real UI: generated by tools/gen-plays.mjs (do not edit).',
  `# The bot's aims per point: ${plan.aims.join(', ')}; the match ends ${r.score[0]}–${r.score[1]} after ${r.breakdown.elapsedTicks} ticks`,
  `# (longest rally ${r.breakdown.longestRally}). Verify replay re-runs it; then Next opens stage 2's setup and the Journey map shows the stage cleared.`,
  'until 300 Paddle Pulse',
  'frames 30',
  'click =Journey',
  'until 60 cleared',
  'frames 10',
  'click =Stage 1: First Contact',
  'until 60 Ball speed',
  'frames 10',
  'save setup',
  'click =Start',
  ...sc.head,
  ...sc.body,
  'until 1200 Score breakdown',
  'frames 30',
  'expect Victory',
  `expect ${r.score[0]} – ${r.score[1]}`,
  `expect ${r.breakdown.longestRally} hits`,
  'save results',
  // Verify replay sits below the fold of the 960 × 540 view: Tab from the focused Next (Tab scrolls it into view)
  'key Tab 2', 'frames 5', 'key Tab 2', 'frames 5', 'key Enter 2',
  'until 1200 Replay verified',
  'frames 10',
  'click =Next: Return Form',
  'until 60 Hold your ground',
  'frames 10',
  'save next-setup',
  'click =Back',
  'until 60 cleared',
  'frames 10',
  'expect 1/40 cleared',
  'save journey',
  '',
].join('\n');
writeFileSync(join(root, 'tests/native/journey-1.play'), text);
console.log(`journey-1.play: ${r.score[0]}–${r.score[1]}, ${plan.run.log.length} key changes, ${r.breakdown.elapsedTicks} ticks`);

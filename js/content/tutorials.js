// Learn mode — interactive lessons introduce one rule at a time and require
// the player to perform the action. Steps are checked against the same
// legal-action API and engine events used by play (spec §2).

export const LESSONS = [
  {
    id: 't-move',
    title: 'Lesson 1 — Move',
    objective: 'Slide your paddle left and right.',
    ruleset: { targetScore: 1, winMargin: 1, ballSpeed: 9 },
    ai: 0,
    aiIdle: true, // opponent holds still
    steps: [
      {
        id: 'move-left',
        text: 'Move your paddle toward the left wall. Drag, use ← →, or tap the left side.',
        require: { type: 'move-dir', dir: -1 },
        hint: 'Your paddle is the bright bar on your goal line.',
      },
      {
        id: 'move-right',
        text: 'Now move it toward the right wall.',
        require: { type: 'move-dir', dir: 1 },
        hint: 'The paddle follows your pointer or arrow keys.',
      },
    ],
  },
  {
    id: 't-serve',
    title: 'Lesson 2 — Serve',
    objective: 'Put the ball in play.',
    ruleset: { targetScore: 1, winMargin: 1, ballSpeed: 10 },
    ai: 0,
    aiIdle: true,
    steps: [
      {
        id: 'serve',
        text: 'The ball is yours. Press Space, tap the ball, or use the Serve button.',
        require: { type: 'serve' },
        hint: 'Serving sends the ball toward the far goal line.',
      },
    ],
  },
  {
    id: 't-return',
    title: 'Lesson 3 — Return',
    objective: 'Meet the ball with your paddle.',
    ruleset: { targetScore: 1, winMargin: 1, ballSpeed: 10 },
    ai: 0,
    steps: [
      {
        id: 'hit',
        text: 'Return the ball once. Get your paddle under it before it crosses your line.',
        require: { type: 'hit', player: 0 },
        hint: 'Watch the trail — meet the ball, don’t chase it.',
      },
    ],
  },
  {
    id: 't-angle',
    title: 'Lesson 4 — Angle',
    objective: 'Strike off-center to bend your return.',
    ruleset: { targetScore: 1, winMargin: 1, ballSpeed: 10, maxReturnAngle: 1.3 },
    ai: 0,
    steps: [
      {
        id: 'angled-hit',
        text: 'Hit the ball with the outer half of your paddle to send it wide.',
        require: { type: 'hit', player: 0, minOffset: 0.45 },
        hint: 'Edge hits bend the return; center hits go straight.',
      },
    ],
  },
  {
    id: 't-score',
    title: 'Lesson 5 — Score & Win',
    objective: 'Score through the far goal line to win.',
    ruleset: { targetScore: 1, winMargin: 1, ballSpeed: 12 },
    ai: 0,
    steps: [
      {
        id: 'score',
        text: 'Score one point — send the ball past the far paddle, over the far line.',
        require: { type: 'goal', player: 0 },
        hint: 'Angled returns are harder to catch.',
      },
      {
        id: 'win',
        text: 'Finish it — win the match.',
        require: { type: 'match-win' },
        hint: 'First point wins this one.',
      },
    ],
  },
];

export function getLesson(id) {
  return LESSONS.find((l) => l.id === id) || null;
}

// Checks a drained engine event (or command acknowledgment) against a step.
export function stepSatisfied(step, evt) {
  const r = step.require;
  switch (r.type) {
    case 'move-dir':
      return evt.t === 'cmd' && evt.type === 'move' && Math.sign(evt.dx || 0) === r.dir && Math.abs(evt.dx) > 0.5;
    case 'serve':
      return evt.t === 'serve';
    case 'hit':
      return evt.t === 'paddle' && evt.player === (r.player ?? 0) && (r.minOffset == null || Math.abs(evt.offset) >= r.minOffset);
    case 'goal':
      return evt.t === 'goal' && evt.player === (r.player ?? 0);
    case 'match-win':
      return evt.t === 'match-end' && evt.winner === 0;
    default:
      return false;
  }
}

// Authored journey content — versioned data per spec §2:
// identifier, seed, initial state (ruleset), goals, allowed mechanics,
// par values, tutorial flags, presentation theme.
//
// Difficulty is measured from solution depth (return precision), time pressure
// (ball speed), motor precision (paddle width), hidden information (moving
// obstacles), and recovery options — not merely larger numbers.

import { hashSeed } from '../rules/rng.js';

export const CONTENT_VERSION = 1;

// AI ladder: reaction delay, tracking speed, aiming error, anticipation.
export const AI_LEVELS = [
  { name: 'Drift', reactTicks: 26, speed: 11, error: 1.5, anticipate: 0.0 },
  { name: 'Glide', reactTicks: 20, speed: 14, error: 1.1, anticipate: 0.15 },
  { name: 'Flow', reactTicks: 15, speed: 17, error: 0.8, anticipate: 0.3 },
  { name: 'Surge', reactTicks: 11, speed: 20, error: 0.55, anticipate: 0.5 },
  { name: 'Pulse', reactTicks: 8, speed: 24, error: 0.4, anticipate: 0.7 },
  { name: 'Zenith', reactTicks: 6, speed: 28, error: 0.3, anticipate: 0.85 },
];

const CHAPTERS = [
  { name: 'Ignition', theme: 'neon-district' },
  { name: 'Angles', theme: 'solar-flare' },
  { name: 'Bumpers', theme: 'deep-current' },
  { name: 'Crossfire', theme: 'verdant-pulse' },
  { name: 'Overdrive', theme: 'violet-zenith' },
  { name: 'Mastery', theme: 'neon-district' },
];

function L(n, opts) {
  const chapter = Math.min(Math.floor((n - 1) / 7), CHAPTERS.length - 1);
  const mastery = n % 8 === 0 || n === 40;
  return {
    id: 'j' + String(n).padStart(2, '0'),
    version: CONTENT_VERSION,
    index: n,
    chapter: CHAPTERS[chapter].name,
    title: opts.title,
    brief: opts.brief,
    seed: hashSeed('paddle-pulse:journey:' + n),
    theme: opts.theme || CHAPTERS[chapter].theme,
    mechanics: opts.mechanics || ['move', 'serve', 'angle'],
    mastery,
    tutorialFlags: opts.tutorialFlags || [],
    ruleset: opts.ruleset || {},
    ai: opts.ai,
    goals: {
      win: true,
      // Par values: stars awarded for winning while conceding few goals.
      par: { star2: opts.par2 ?? 3, star3: opts.par3 ?? 1, maxTicks: opts.maxTicks || 0 },
    },
  };
}

export const JOURNEY_LEVELS = [
  L(1, { title: 'First Contact', brief: 'Learn the arena. First to 3, slow ball.', ai: 0, ruleset: { targetScore: 3, winMargin: 1, ballSpeed: 10, paddleWidth: 4.4 }, tutorialFlags: ['move'] }),
  L(2, { title: 'Return Form', brief: 'Hold your ground and return cleanly.', ai: 0, ruleset: { targetScore: 3, winMargin: 1, ballSpeed: 11, paddleWidth: 4.2 }, tutorialFlags: ['serve'] }),
  L(3, { title: 'Wide Guard', brief: 'A wider arena demands anticipation.', ai: 0, ruleset: { targetScore: 4, winMargin: 1, ballSpeed: 12, arena: { w: 22, h: 24 } } }),
  L(4, { title: 'Edge Work', brief: 'Use the paddle edge to bend returns.', ai: 1, ruleset: { targetScore: 4, winMargin: 1, ballSpeed: 12, maxReturnAngle: 1.2 }, tutorialFlags: ['angle'] }),
  L(5, { title: 'Tempo', brief: 'The ball gains pace with every hit.', ai: 1, ruleset: { targetScore: 4, winMargin: 1, ballSpeed: 13, speedGain: 1.06 } }),
  L(6, { title: 'Pressure Line', brief: 'Opponent tracks faster. Stay calm.', ai: 1, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 13 } }),
  L(7, { title: 'Ignition Trial', brief: 'Prove the basics under margin rules.', ai: 1, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 14, paddleWidth: 3.6 }, par2: 2, par3: 0 }),

  L(8, { title: 'Mastery: Ignition', brief: 'Mastery stage — win by 3 against Glide.', ai: 1, ruleset: { targetScore: 5, winMargin: 3, ballSpeed: 14 }, par2: 2, par3: 0 }),
  L(9, { title: 'Slice', brief: 'Sharper returns, sharper angles.', ai: 2, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 14, maxReturnAngle: 1.25 } }),
  L(10, { title: 'Narrow Margin', brief: 'A slimmer paddle, a slimmer path.', ai: 2, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 14, paddleWidth: 3.0 } }),
  L(11, { title: 'Long Court', brief: 'A longer court rewards deep angles.', ai: 2, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 15, arena: { w: 18, h: 30 } } }),
  L(12, { title: 'Quickstep', brief: 'Faster exchanges. Read the rebound.', ai: 2, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 16, speedGain: 1.05 } }),
  L(13, { title: 'Corner Trap', brief: 'Force the corners, own the center.', ai: 2, ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 15, arena: { w: 24, h: 26 } } }),
  L(14, { title: 'Angles Gate', brief: 'Win with pace against Flow.', ai: 2, ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 16 }, par2: 2, par3: 0 }),

  L(15, { title: 'First Bumper', brief: 'A single deflector changes the map.', ai: 2, mechanics: ['move', 'serve', 'angle', 'bumpers'], ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 14, obstacles: [{ type: 'bumper', id: 'b1', x: 0, y: 0, r: 1.1 }] } }),
  L(16, { title: 'Mastery: Angles', brief: 'Mastery stage — angled returns, no cheap points.', ai: 2, ruleset: { targetScore: 6, winMargin: 3, ballSpeed: 15, maxReturnAngle: 1.3 }, par2: 2, par3: 0 }),
  L(17, { title: 'Twin Deflectors', brief: 'Two bumpers guard the middle.', ai: 3, mechanics: ['move', 'serve', 'angle', 'bumpers'], ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 15, obstacles: [{ type: 'bumper', id: 'b1', x: -4, y: 0, r: 1.0 }, { type: 'bumper', id: 'b2', x: 4, y: 0, r: 1.0 }] } }),
  L(18, { title: 'Offset Lanes', brief: 'Asymmetric deflectors. Re-read every rebound.', ai: 3, mechanics: ['move', 'serve', 'angle', 'bumpers'], ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 15, obstacles: [{ type: 'bumper', id: 'b1', x: -3, y: 3, r: 1.0 }, { type: 'bumper', id: 'b2', x: 3.5, y: -4, r: 1.2 }] } }),
  L(19, { title: 'Pinball', brief: 'Four deflectors. Chaos is a pattern.', ai: 3, mechanics: ['move', 'serve', 'angle', 'bumpers'], ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 14, obstacles: [{ type: 'bumper', id: 'b1', x: -4, y: 4, r: 0.9 }, { type: 'bumper', id: 'b2', x: 4, y: 4, r: 0.9 }, { type: 'bumper', id: 'b3', x: -4, y: -4, r: 0.9 }, { type: 'bumper', id: 'b4', x: 4, y: -4, r: 0.9 }] } }),
  L(20, { title: 'Bumper Trial', brief: 'Hold the line amid deflections.', ai: 3, mechanics: ['move', 'serve', 'angle', 'bumpers'], ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 16, obstacles: [{ type: 'bumper', id: 'b1', x: 0, y: 0, r: 1.3 }] } }),
  L(21, { title: 'Crosswind', brief: 'A moving blocker sweeps mid-court.', ai: 3, mechanics: ['move', 'serve', 'angle', 'blocks'], ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 15, obstacles: [{ type: 'block', id: 'w1', x: 0, y: 0, hw: 2.2, hh: 0.35, move: { axis: 'x', amp: 4, period: 480 } }] } }),
  L(22, { title: 'Double Sweep', brief: 'Two blockers, alternating pressure.', ai: 3, mechanics: ['move', 'serve', 'angle', 'blocks'], ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 15, obstacles: [{ type: 'block', id: 'w1', x: -3, y: 3, hw: 1.8, hh: 0.35, move: { axis: 'x', amp: 3, period: 480 } }, { type: 'block', id: 'w2', x: 3, y: -3, hw: 1.8, hh: 0.35, move: { axis: 'x', amp: 3, period: 640 } }] } }),

  L(23, { title: 'Crossfire Gate', brief: 'Survive the sweep against Surge.', ai: 3, mechanics: ['move', 'serve', 'angle', 'blocks'], ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 16, obstacles: [{ type: 'block', id: 'w1', x: 0, y: 0, hw: 2.0, hh: 0.35, move: { axis: 'x', amp: 5, period: 420 } }] } }),
  L(24, { title: 'Mastery: Crossfire', brief: 'Mastery stage — blockers and margin pressure.', ai: 3, mechanics: ['move', 'serve', 'angle', 'blocks'], ruleset: { targetScore: 6, winMargin: 3, ballSpeed: 16, obstacles: [{ type: 'block', id: 'w1', x: 0, y: 2, hw: 2.0, hh: 0.35, move: { axis: 'x', amp: 4, period: 480 } }, { type: 'bumper', id: 'b1', x: 0, y: -5, r: 1.0 }] }, par2: 2, par3: 0 }),
  L(25, { title: 'Overdrive', brief: 'The pace climbs. So do you.', ai: 4, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 18, speedGain: 1.05, maxBallSpeed: 36 } }),
  L(26, { title: 'Razor', brief: 'Slim paddle, full speed.', ai: 4, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 18, paddleWidth: 2.8 } }),
  L(27, { title: 'Deep Court', brief: 'The longest court at full pace.', ai: 4, ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 18, arena: { w: 20, h: 32 } } }),
  L(28, { title: 'Reactor', brief: 'Deflectors at overdrive pace.', ai: 4, mechanics: ['move', 'serve', 'angle', 'bumpers'], ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 18, obstacles: [{ type: 'bumper', id: 'b1', x: -3, y: 0, r: 1.0 }, { type: 'bumper', id: 'b2', x: 3, y: 0, r: 1.0 }] } }),
  L(29, { title: 'Blitz', brief: 'Short target, sudden pressure.', ai: 4, ruleset: { targetScore: 4, winMargin: 1, ballSpeed: 20, speedGain: 1.06 } }),
  L(30, { title: 'Ion Storm', brief: 'Blockers sweep a fast court.', ai: 4, mechanics: ['move', 'serve', 'angle', 'blocks'], ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 18, obstacles: [{ type: 'block', id: 'w1', x: 0, y: 4, hw: 1.8, hh: 0.35, move: { axis: 'x', amp: 5, period: 400 } }, { type: 'block', id: 'w2', x: 0, y: -4, hw: 1.8, hh: 0.35, move: { axis: 'x', amp: 5, period: 520 } }] } }),
  L(31, { title: 'Overdrive Gate', brief: 'Hold pace against Pulse.', ai: 4, ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 19, maxBallSpeed: 38 } }),

  L(32, { title: 'Mastery: Overdrive', brief: 'Mastery stage — full speed, win by 3.', ai: 4, ruleset: { targetScore: 6, winMargin: 3, ballSpeed: 19, maxBallSpeed: 38 }, par2: 2, par3: 0 }),
  L(33, { title: 'Zenith Approach', brief: 'The final chapter opens at pace.', ai: 5, ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 19, paddleWidth: 3.2 } }),
  L(34, { title: 'Mirror Maze', brief: 'Symmetric deflectors, asymmetric outcomes.', ai: 5, mechanics: ['move', 'serve', 'angle', 'bumpers'], ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 18, obstacles: [{ type: 'bumper', id: 'b1', x: -4, y: 5, r: 0.9 }, { type: 'bumper', id: 'b2', x: 4, y: 5, r: 0.9 }, { type: 'bumper', id: 'b3', x: -4, y: -5, r: 0.9 }, { type: 'bumper', id: 'b4', x: 4, y: -5, r: 0.9 }] } }),
  L(35, { title: 'Swept Court', brief: 'Everything moves. Including you.', ai: 5, mechanics: ['move', 'serve', 'angle', 'blocks'], ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 19, obstacles: [{ type: 'block', id: 'w1', x: 0, y: 0, hw: 2.4, hh: 0.35, move: { axis: 'x', amp: 5, period: 360 } }] } }),
  L(36, { title: 'Thin Ice', brief: 'Slim paddle against the best tracker.', ai: 5, ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 19, paddleWidth: 2.8 } }),
  L(37, { title: 'Full Court Press', brief: 'A wide court, a fast ball, no excuses.', ai: 5, ruleset: { targetScore: 7, winMargin: 2, ballSpeed: 20, arena: { w: 24, h: 28 } } }),
  L(38, { title: 'Chaos Theory', brief: 'Every mechanic, one arena.', ai: 5, mechanics: ['move', 'serve', 'angle', 'bumpers', 'blocks'], ruleset: { targetScore: 6, winMargin: 2, ballSpeed: 19, obstacles: [{ type: 'bumper', id: 'b1', x: 0, y: 0, r: 1.1 }, { type: 'block', id: 'w1', x: 0, y: 6, hw: 1.8, hh: 0.35, move: { axis: 'x', amp: 4, period: 420 } }, { type: 'block', id: 'w2', x: 0, y: -6, hw: 1.8, hh: 0.35, move: { axis: 'x', amp: 4, period: 540 } }] } }),
  L(39, { title: 'The Long Rally', brief: 'A marathon to seven against Zenith.', ai: 5, ruleset: { targetScore: 7, winMargin: 2, ballSpeed: 20, maxBallSpeed: 40 } }),
  L(40, { title: 'Mastery: Zenith', brief: 'Final mastery — everything combined, win by 3.', ai: 5, mechanics: ['move', 'serve', 'angle', 'bumpers', 'blocks'], ruleset: { targetScore: 7, winMargin: 3, ballSpeed: 20, maxBallSpeed: 40, obstacles: [{ type: 'bumper', id: 'b1', x: -3.5, y: 0, r: 1.0 }, { type: 'bumper', id: 'b2', x: 3.5, y: 0, r: 1.0 }, { type: 'block', id: 'w1', x: 0, y: 5, hw: 2.0, hh: 0.35, move: { axis: 'x', amp: 4, period: 400 } }] }, par2: 2, par3: 0 }),
];

// Challenge mode (spec §2): constrained goals — move limits, speed targets,
// altered layouts, restricted tools.
export const CHALLENGES = [
  {
    id: 'c-economy',
    version: CONTENT_VERSION,
    title: 'Economy of Motion',
    brief: 'Win 5–2 or better using at most 40 paddle commands. Every move counts.',
    seed: hashSeed('paddle-pulse:challenge:economy'),
    theme: 'deep-current',
    mechanics: ['move', 'serve', 'angle'],
    ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 14, moveLimit: 40, moveLimitPlayers: [0] },
    ai: 2,
    goals: { win: true, constraint: 'move-limit' },
  },
  {
    id: 'c-overclock',
    version: CONTENT_VERSION,
    title: 'Overclocked',
    brief: 'The ball never drops below 22 units/s. Survive to 5.',
    seed: hashSeed('paddle-pulse:challenge:overclock'),
    theme: 'solar-flare',
    mechanics: ['move', 'serve', 'angle'],
    ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 22, maxBallSpeed: 44, speedGain: 1.03 },
    ai: 3,
    goals: { win: true, constraint: 'speed-target' },
  },
  {
    id: 'c-pinball-alley',
    version: CONTENT_VERSION,
    title: 'Pinball Alley',
    brief: 'Six deflectors own the court. First to 6 in the chaos.',
    seed: hashSeed('paddle-pulse:challenge:pinball'),
    theme: 'violet-zenith',
    mechanics: ['move', 'serve', 'angle', 'bumpers'],
    ruleset: {
      targetScore: 6, winMargin: 2, ballSpeed: 15,
      obstacles: [
        { type: 'bumper', id: 'b1', x: -5, y: 5, r: 0.9 }, { type: 'bumper', id: 'b2', x: 5, y: 5, r: 0.9 },
        { type: 'bumper', id: 'b3', x: 0, y: 0, r: 1.1 },
        { type: 'bumper', id: 'b4', x: -5, y: -5, r: 0.9 }, { type: 'bumper', id: 'b5', x: 5, y: -5, r: 0.9 },
        { type: 'bumper', id: 'b6', x: 0, y: 8, r: 0.8 },
      ],
    },
    ai: 3,
    goals: { win: true, constraint: 'altered-layout' },
  },
  {
    id: 'c-toothpick',
    version: CONTENT_VERSION,
    title: 'Toothpick',
    brief: 'Restricted tools: your paddle is a sliver. Win anyway.',
    seed: hashSeed('paddle-pulse:challenge:toothpick'),
    theme: 'verdant-pulse',
    mechanics: ['move', 'serve', 'angle'],
    ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 14, paddleWidth: 2.0 },
    ai: 3,
    goals: { win: true, constraint: 'restricted-tools' },
  },
  {
    id: 'c-sudden-death',
    version: CONTENT_VERSION,
    title: 'Sudden Death',
    brief: 'One point decides it. Full pace. No margin for error.',
    seed: hashSeed('paddle-pulse:challenge:sudden-death'),
    theme: 'neon-district',
    mechanics: ['move', 'serve', 'angle'],
    ruleset: { targetScore: 1, winMargin: 1, ballSpeed: 24, maxBallSpeed: 46, paddleWidth: 3.0 },
    ai: 4,
    goals: { win: true, constraint: 'speed-target' },
  },
  {
    id: 'c-the-gauntlet',
    version: CONTENT_VERSION,
    title: 'The Gauntlet',
    brief: 'Blockers, bumpers, a slim paddle, and a relentless opponent. Win by 3.',
    seed: hashSeed('paddle-pulse:challenge:gauntlet'),
    theme: 'violet-zenith',
    mechanics: ['move', 'serve', 'angle', 'bumpers', 'blocks'],
    ruleset: {
      targetScore: 6, winMargin: 3, ballSpeed: 18, paddleWidth: 2.8,
      obstacles: [
        { type: 'bumper', id: 'b1', x: 0, y: 0, r: 1.0 },
        { type: 'block', id: 'w1', x: 0, y: 5, hw: 1.8, hh: 0.35, move: { axis: 'x', amp: 4, period: 400 } },
        { type: 'block', id: 'w2', x: 0, y: -5, hw: 1.8, hh: 0.35, move: { axis: 'x', amp: 4, period: 560 } },
      ],
    },
    ai: 5,
    goals: { win: true, constraint: 'altered-layout' },
  },
];

export const PRACTICE_DIFFICULTIES = [
  { id: 'calm', name: 'Calm', ai: 0, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 11 } },
  { id: 'steady', name: 'Steady', ai: 1, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 13 } },
  { id: 'brisk', name: 'Brisk', ai: 2, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 15 } },
  { id: 'fierce', name: 'Fierce', ai: 3, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 17 } },
  { id: 'zenith', name: 'Zenith', ai: 4, ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 19 } },
];

export function getJourneyLevel(idOrIndex) {
  if (typeof idOrIndex === 'number') return JOURNEY_LEVELS[idOrIndex - 1] || null;
  return JOURNEY_LEVELS.find((l) => l.id === idOrIndex) || null;
}

export function getChallenge(id) {
  return CHALLENGES.find((c) => c.id === id) || null;
}

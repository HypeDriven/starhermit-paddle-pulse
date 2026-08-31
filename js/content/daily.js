// Daily mode — one shared seed and ruleset per UTC day (spec §2).
// Seeds are immutable after publication: the seed derives purely from the
// UTC date string, so every player on the same day gets identical content.
// Defective days are marked excluded from ranking, never silently replaced.

import { hashSeed } from '../rules/rng.js';

export const DAILY_RULESET_VERSION = 1;

// Rotating (but deterministic) daily rule card — varies by weekday so the
// daily feels alive while remaining reproducible for a given date.
const DAILY_CARDS = [
  { name: 'Standard', ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 15 } },
  { name: 'Quickfire', ruleset: { targetScore: 3, winMargin: 1, ballSpeed: 18, speedGain: 1.05 } },
  { name: 'Deflector', ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 15, obstacles: [{ type: 'bumper', id: 'b1', x: 0, y: 0, r: 1.1 }] } },
  { name: 'Sweep', ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 15, obstacles: [{ type: 'block', id: 'w1', x: 0, y: 0, hw: 2.0, hh: 0.35, move: { axis: 'x', amp: 4, period: 480 } }] } },
  { name: 'Slimline', ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 15, paddleWidth: 2.8 } },
  { name: 'Marathon', ruleset: { targetScore: 8, winMargin: 2, ballSpeed: 15 } },
  { name: 'Twin Deflectors', ruleset: { targetScore: 5, winMargin: 2, ballSpeed: 15, obstacles: [{ type: 'bumper', id: 'b1', x: -4, y: 0, r: 1.0 }, { type: 'bumper', id: 'b2', x: 4, y: 0, r: 1.0 }] } },
];

export function utcDateString(now = Date.now()) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function dailyContent(utcDate = utcDateString()) {
  const seed = hashSeed('paddle-pulse:daily:' + utcDate);
  const dayNum = Math.floor(Date.parse(utcDate + 'T00:00:00Z') / 86400000);
  const card = DAILY_CARDS[((dayNum % DAILY_CARDS.length) + DAILY_CARDS.length) % DAILY_CARDS.length];
  return {
    id: 'daily-' + utcDate,
    version: DAILY_RULESET_VERSION,
    date: utcDate,
    name: card.name,
    seed,
    ruleset: card.ruleset,
    ai: 2 + (dayNum % 3), // 2..4 deterministic
    theme: ['neon-district', 'solar-flare', 'deep-current', 'verdant-pulse', 'violet-zenith'][dayNum % 5],
    excluded: false, // a defective day would be flagged here, never replaced
  };
}

export function msUntilNextDaily(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
  return next - now;
}

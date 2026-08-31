// Seeded, serializable random streams (mulberry32). Pure and deterministic.
// Rules, content decoration, and audiovisual variants each use their own stream
// so cosmetic randomness can never alter rules outcomes.

export function hashSeed(str) {
  // FNV-1a 32-bit — stable across engines; used for daily seeds and ids.
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createRng(seed) {
  return { n: (seed >>> 0) || 0x9e3779b9 };
}

// Advance the stream; returns float in [0, 1).
export function next(rng) {
  rng.n = (rng.n + 0x6d2b79f5) >>> 0;
  let t = rng.n;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function range(rng, min, max) {
  return min + (max - min) * next(rng);
}

export function pick(rng, arr) {
  return arr[Math.floor(next(rng) * arr.length) % arr.length];
}

export function cloneRng(rng) {
  return { n: rng.n >>> 0 };
}

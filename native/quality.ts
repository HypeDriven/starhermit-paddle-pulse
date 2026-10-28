// The look per graphics level: the browser build's four presets and budgets
// (js/render/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest
// GPU its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the particle pool and the dust motes scaled within the tier by the
// level (frame().levelIndex, at most 2×), as the browser build scaled them by
// its hardware level. The runtime owns the rest of what the old Graphics panel
// did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The old panel's
// per-effect overrides are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Lit-surface shading: Lambert (Low), Standard (Balanced), clear-coated Physical (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Ball sphere segments [width, height]; rounded-bevel segments (rails, blockers; paddles +1). */
  ballSeg: [number, number];
  roundSeg: number;
  /** Floor-panel texture (detailed look): the baked size in px. */
  texture: 128 | 256 | 512;
  /** Floor-mirror resolution as a share of the window. */
  reflectRes: number;
  /** Surround pillars (detailed; plain ×0.35). */
  pillars: number;
  /** Particle pool at Particles high, and dust motes. */
  sparks: number;
  motes: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map (0 = off; the soft contact blobs instead on the detailed look). */
  shadows: 0 | 512 | 1024 | 2048;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  /** The planar floor mirror under the semi-transparent floor. */
  reflections: boolean;
  particles: "low" | "medium" | "high";
  /** Animated background: pillar shimmer, grid breath, dust motes. */
  animated: boolean;
  /** Detailed look: environment reflections, bevels, panel floor out into the fog, neon tubes, pillar strips, blobs. */
  detailed: boolean;
  budget: Budget;
}

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { shadows: 512, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: false, particles: "medium", animated: true, detailed: true },
  high: { shadows: 1024, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { shadows: 2048, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", ballSeg: [16, 12], roundSeg: 1, texture: 128, reflectRes: 0.5, pillars: 10, sparks: 600, motes: 40, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", ballSeg: [24, 18], roundSeg: 2, texture: 256, reflectRes: 0.5, pillars: 14, sparks: 1200, motes: 90, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", ballSeg: [32, 24], roundSeg: 2, texture: 256, reflectRes: 0.5, pillars: 18, sparks: 2400, motes: 160, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", ballSeg: [48, 32], roundSeg: 3, texture: 512, reflectRes: 1, pillars: 28, sparks: 3600, motes: 240, bloomRes: 1, aoRes: 1 },
};
export const SPARK_MAX = 7200;
export const MOTE_MAX = 480;
const PARTICLE_SHARE = { low: 1 / 6, medium: 0.5, high: 1 };
const MOTE_SHARE = { low: 0.4, medium: 0.7, high: 1 };
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const row = TABLE[preset];
  // Levels are about 1.64× apart in GPU throughput: counts grow with the level above the tier's first, at most 2×.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k * PARTICLE_SHARE[row.particles]));
  b.motes = row.animated ? Math.min(MOTE_MAX, Math.round(b.motes * k * MOTE_SHARE[row.particles])) : 0;
  return { preset, ...row, budget: b };
}

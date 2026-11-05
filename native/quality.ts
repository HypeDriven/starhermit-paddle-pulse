// The look per graphics level. The engine's effects come from levelSettings() for
// the frame's level: shadows and their map size, ambient occlusion, bloom, the
// grade and anti-aliasing. The game's own art (materials, segments, pillars, the
// floor mirror, particle and mote budgets) stays keyed by the runtime's quality
// tier (frame().quality), the browser build's four presets (js/render/gfx.js),
// with particles and motes scaled within the tier by the level's particle budget
// over the tier's anchor level (at most 2×). The runtime owns the rest of what
// the old Graphics panel did: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution, the frame-rate limit and readout. The old
// panel's per-effect overrides are not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Lit-surface shading: Lambert (Low), Standard (Balanced), clear-coated Physical (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Ball sphere segments [width, height]; rounded-bevel segments (rails, blockers; paddles +1). */
  ballSeg: [number, number];
  roundSeg: number;
  /** Floor-panel texture (detailed look): the baked size in px. */
  texture: number;
  /** Floor-mirror resolution as a share of the window. */
  reflectRes: number;
  /** Surround pillars (detailed; plain ×0.35). */
  pillars: number;
  /** Particle pool at Particles high, and dust motes. */
  sparks: number;
  motes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map: the level's size (0 = off; the soft contact blobs instead on the detailed look). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
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

const ART: Record<QualityTier, Pick<Look, "reflections" | "particles" | "animated" | "detailed">> = {
  low: { reflections: false, particles: "low", animated: false, detailed: false },
  balanced: { reflections: false, particles: "medium", animated: true, detailed: true },
  high: { reflections: true, particles: "high", animated: true, detailed: true },
  ultra: { reflections: true, particles: "high", animated: true, detailed: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", ballSeg: [16, 12], roundSeg: 1, texture: 128, reflectRes: 0.5, pillars: 10, sparks: 600, motes: 40 },
  balanced: { material: "standard", ballSeg: [24, 18], roundSeg: 2, texture: 256, reflectRes: 0.5, pillars: 14, sparks: 1200, motes: 90 },
  high: { material: "physical", ballSeg: [32, 24], roundSeg: 2, texture: 256, reflectRes: 0.5, pillars: 18, sparks: 2400, motes: 160 },
  ultra: { material: "physical", ballSeg: [48, 32], roundSeg: 3, texture: 512, reflectRes: 1, pillars: 28, sparks: 3600, motes: 240 },
};
export const SPARK_MAX = 7200;
export const MOTE_MAX = 480;
const PARTICLE_SHARE = { low: 1 / 6, medium: 0.5, high: 1 };
const MOTE_SHARE = { low: 0.4, medium: 0.7, high: 1 };
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const art = ART[preset];
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.texture = Math.min(b.texture, s.maxTextureSize);
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k * PARTICLE_SHARE[art.particles]));
  b.motes = art.animated ? Math.min(MOTE_MAX, Math.round(b.motes * k * MOTE_SHARE[art.particles])) : 0;
  return {
    preset, ...art,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}

// Graphics quality model (spec §4 performance budgets): presets, per-category
// overrides, StarHermit hardware-level detection, per-preset asset/effect budgets and a cost summary. Pure (no three.js), so the
// settings panel, the renderer and the unit tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],
  particles: ['low', 'medium', 'high'],
  background: ['static', 'animated'],
  detail: ['plain', 'detailed'],
};

// Each preset is a row of tiers, a render scale (multiplies the capped device
// pixel ratio) and a device-pixel-ratio cap.
const TABLE = {
  low: { scale: 0.85, dprCap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'off', reflections: 'off', particles: 'low', background: 'static', detail: 'plain' },
  balanced: { scale: 1, dprCap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'off', particles: 'medium', background: 'animated', detail: 'detailed' },
  high: { scale: 1, dprCap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
  ultra: { scale: 1.25, dprCap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', particles: 'high', background: 'animated', detail: 'detailed' },
};

export const SHADOW_MAP = { off: 0, low: 512, medium: 1024, high: 2048 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; js/render/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). Arena, paddles,
 * ball, physics and hit areas are identical on every preset — only visuals change.
 *   material  lit-surface shading: lambert (Low) / standard (Balanced) / physical clear-coated (High,
 *             Ultra; Material detail Detailed)
 *   ballSeg   ball sphere segments [width, height]; roundSeg rounded-box segments (rails, paddles, blocks)
 *   texture   procedural floor-panel texture size in px (Detailed)
 *   reflectRes  floor-mirror resolution as a fraction of the frame (Floor reflections on)
 *   pillars   instanced pillars in the surrounding ring
 *   sparks    particle-pool size at Particles High (Medium: half, Low: a sixth), scaled with the level
 *   motes     drifting dust motes (Background animated), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 *   hudBlur   frosted (backdrop-filter) HUD pill and menu screens over the live arena
 */
export const BUDGETS = {
  low: { material: 'lambert', ballSeg: [16, 12], roundSeg: 1, texture: 128, reflectRes: 0.5, pillars: 10, sparks: 600, motes: 40, bloomRes: 0.5, aoRes: 0.5, hudBlur: false },
  balanced: { material: 'standard', ballSeg: [24, 18], roundSeg: 2, texture: 256, reflectRes: 0.5, pillars: 14, sparks: 1200, motes: 90, bloomRes: 0.5, aoRes: 0.5, hudBlur: false },
  high: { material: 'physical', ballSeg: [32, 24], roundSeg: 2, texture: 256, reflectRes: 0.5, pillars: 18, sparks: 2400, motes: 160, bloomRes: 0.5, aoRes: 0.5, hudBlur: true },
  ultra: { material: 'physical', ballSeg: [48, 32], roundSeg: 3, texture: 512, reflectRes: 1, pillars: 28, sparks: 3600, motes: 240, bloomRes: 1, aoRes: 1, hudBlur: true },
};
export const SPARK_MAX = 7200;
export const MOTE_MAX = 480;
const PARTICLE_SHARE = { low: 1 / 6, medium: 0.5, high: 1 };

/** A preset's concrete budget for a hardware level (particle counts scale ≤ 2× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return b;
}

/** Live particle-pool size for resolved settings (Particles tier share of the preset's budget). */
export function sparkCap(r) {
  return Math.max(1, Math.round(r.budget.sparks * (PARTICLE_SHARE[r.particles] ?? 0.5)));
}

/** Dust motes for resolved settings (Particles tier scales them too, as before). */
export function moteCount(r) {
  return Math.round(r.budget.motes * ({ low: 0.4, medium: 0.7, high: 1 }[r.particles] ?? 0.7));
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const out = {
    preset,
    auto,
    dprCap: row.dprCap,
    scale: row.scale * clamp(Number(s.render_scale) || 1, 0.5, 2),
  };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // The composer runs only when something needs it; otherwise the canvas is drawn directly.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias !== 'off';
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Choosing a preset clears every per-category override. */
export function withPreset(saved, preset) {
  const out = { ...(saved || {}), preset };
  for (const cat of Object.keys(CATEGORIES)) delete out[cat];
  return out;
}

const SUMMARY_EN = {
  'gfx.sum.noShadows': 'no shadows',
  'gfx.sum.shadows': '{n}² shadows',
  'gfx.sum.ao': 'ambient occlusion',
  'gfx.sum.aoFull': 'full ambient occlusion',
  'gfx.sum.bloom': 'bloom',
  'gfx.sum.reflections': 'floor reflections',
  'gfx.sum.noAA': 'no anti-aliasing',
};

function enT(key, vars) {
  let s = SUMMARY_EN[key] ?? key;
  for (const [k, v] of Object.entries(vars || {})) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Cost summary; `tr` is the UI translator (keys above), English by default. */
export function describe(r, pixels, tr = enT) {
  const parts = [
    r.shadows === 'off' ? tr('gfx.sum.noShadows') : tr('gfx.sum.shadows', { n: SHADOW_MAP[r.shadows] }),
    r.ao === 'off' ? null : r.ao === 'high' ? tr('gfx.sum.aoFull') : tr('gfx.sum.ao'),
    r.bloom === 'on' ? tr('gfx.sum.bloom') : null,
    r.reflections === 'on' ? tr('gfx.sum.reflections') : null,
    r.antialias === 'off' ? tr('gfx.sum.noAA') : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

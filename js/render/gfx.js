// Graphics quality model (spec §4 performance budgets): presets, per-category
// overrides, GPU detection and a cost summary. Pure (no three.js), so the
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

/** Best preset for this GPU, from the unmasked renderer string when the browser exposes it. */
export function detectPreset(gpu, { touch = false } = {}) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
  // Phones and tablets cap Auto at Balanced (heat and battery).
  if (touch && p === 'high') p = 'balanced';
  return p;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected) {
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

// Graphics quality model (js/render/gfx.js): GPU detection, preset
// resolution, overrides, render-scale clamping, and preset-clears-overrides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// js/render/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../js/render/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
const { PRESETS, CATEGORIES, detectPreset, detectLevel, presetForLevel, budgetFor, sparkCap, moteCount, resolve, presetTier, withPreset, describe, LEVELS, BUDGETS, SPARK_MAX, MOTE_MAX } = await import('../js/render/gfx.js');
const { migrateSettings } = await import('../js/session/storage.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('', DESK), 'low', 'no WebGL');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('Apple M2', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'ballSeg', 'roundSeg', 'texture', 'reflectRes', 'pillars', 'sparks', 'motes', 'bloomRes', 'aoRes', 'hudBlur'];
  for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) for (const k of keys) {
    if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].hudBlur), [false, false, true, true], 'frosted HUD only on High/Ultra');
  assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, BUDGETS.high, 'floor level = the tuned budget');
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget);
  assert.ok(budgetFor('balanced', 9).motes > budgetFor('balanced', 4).motes, 'counts scale up within the preset');
  assert.ok(budgetFor('ultra', 20).sparks <= SPARK_MAX && budgetFor('ultra', 20).motes <= MOTE_MAX);
  assert.equal(sparkCap(resolve({ preset: 'high' }, 'low', 10)), BUDGETS.high.sparks);
  assert.equal(sparkCap(resolve({ preset: 'balanced' }, 'low', 4)), BUDGETS.balanced.sparks / 2, 'Particles Medium: half');
  assert.equal(moteCount(resolve({ preset: 'high' }, 'low', 10)), BUDGETS.high.motes);
  assert.equal(resolve({}, 'low', 0).budget.material, 'lambert', 'headless SwiftShader: Low, Lambert');
});

test('resolve: auto follows the detected preset, explicit preset wins', () => {
  const auto = resolve({ preset: 'auto' }, 'low');
  assert.equal(auto.preset, 'low');
  assert.equal(auto.auto, true);
  assert.equal(auto.post, false, 'Low draws without a post chain');
  assert.equal(auto.shadows, 'off');
  const high = resolve({ preset: 'high' }, 'low');
  assert.equal(high.preset, 'high');
  assert.equal(high.auto, false);
  assert.equal(high.post, true);
  for (const cat of Object.keys(CATEGORIES)) assert.equal(high[cat], presetTier('high', cat));
  assert.equal(resolve({}, undefined).preset, 'balanced', 'unknown detection falls back to balanced');
});

test('resolve: per-category overrides and invalid values', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'high', ao: 'bogus' }, 'high');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'high');
  assert.equal(r.ao, 'off', 'invalid override falls back to the preset tier');
  assert.equal(r.post, true, 'bloom override turns the post chain on');
  assert.equal(resolve({ preset: 'low', antialias: 'msaa' }, 'low').post, true, 'MSAA uses a multisampled post target');
});

test('resolve: render scale multiplies the preset scale and clamps to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 1.5 }).scale, 1.5);
  assert.equal(resolve({ preset: 'high', render_scale: 9 }).scale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).scale, 0.5);
  assert.equal(resolve({ preset: 'low', render_scale: 1 }).scale, 0.85);
  assert.equal(resolve({ preset: 'high' }).adaptive, true, 'adaptive defaults on');
  assert.equal(resolve({ preset: 'high' }).showFps, false, 'fps readout defaults off');
  assert.equal(resolve({ preset: 'high', adaptive: false, show_fps: true }).adaptive, false);
});

test('choosing a preset clears overrides but keeps scale and toggles', () => {
  const saved = { preset: 'low', bloom: 'on', detail: 'detailed', render_scale: 1.2, adaptive: false, trails: true };
  const next = withPreset(saved, 'ultra');
  assert.equal(next.preset, 'ultra');
  for (const cat of Object.keys(CATEGORIES)) assert.equal(next[cat], undefined, `${cat} cleared`);
  assert.equal(next.render_scale, 1.2);
  assert.equal(next.adaptive, false);
  assert.equal(next.trails, true);
  assert.deepEqual(PRESETS, ['low', 'balanced', 'high', 'ultra']);
});

test('describe summarises cost with pixel size', () => {
  assert.equal(describe(resolve({ preset: 'low' }), [640, 400]), 'no shadows · no anti-aliasing · 640×400 px');
  assert.match(describe(resolve({ preset: 'ultra' })), /2048² shadows · full ambient occlusion · bloom · floor reflections · MSAA/);
});

test('settings migration maps the old single quality tier', () => {
  assert.equal(migrateSettings({ graphics: { tier: 'medium', bloom: true, trails: false } }).graphics.preset, 'balanced');
  const m = migrateSettings({ graphics: { tier: 'high' } }).graphics;
  assert.equal(m.preset, 'high');
  assert.equal(m.tier, undefined);
  assert.equal(migrateSettings({ graphics: { tier: 'auto' } }).graphics.preset, 'auto');
  assert.equal(migrateSettings(null).graphics.preset, 'auto');
});

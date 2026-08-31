// Bounded, pooled VFX (spec §4): pooled particles, trails, impact accents,
// event hierarchy. Cosmetic particles never intercept raycasts (separate
// layer), counts are capped per quality tier, and everything is allocated
// once at init — no per-frame allocation in the render loop.

import * as THREE from 'three';

export const LAYER_ENV = 0;
export const LAYER_GAME = 1;
export const LAYER_FX = 2;
export const LAYER_UI_ANCHOR = 3;

const TIER_PARTICLES = { low: 400, medium: 1200, high: 2400 };

export class ParticlePool {
  constructor(tier = 'medium') {
    this.capacity = TIER_PARTICLES[tier] || TIER_PARTICLES.medium;
    const n = this.capacity;
    this.positions = new Float32Array(n * 3);
    this.velocities = new Float32Array(n * 3);
    this.colors = new Float32Array(n * 3);
    this.life = new Float32Array(n); // remaining
    this.span = new Float32Array(n); // total
    this.sizes = new Float32Array(n);
    this.head = 0;
    this.alive = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      size: 0.22,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_FX);
    this.points.raycast = () => {}; // never intercept picking
    this._color = new THREE.Color();
    this.budgetScale = 1; // reduced-motion / hidden lowers this
  }

  spawn(x, y, z, { count = 12, color = 0xffffff, speed = 6, spread = 1, up = 2, life = 0.6, gravity = -6 } = {}) {
    const n = Math.min(count, Math.floor(count * this.budgetScale));
    if (n <= 0) return;
    this._color.set(color);
    for (let i = 0; i < n; i++) {
      const idx = this.head;
      this.head = (this.head + 1) % this.capacity;
      const a = Math.random() * Math.PI * 2;
      const r = (0.3 + 0.7 * Math.random()) * speed * spread;
      this.positions[idx * 3] = x;
      this.positions[idx * 3 + 1] = y;
      this.positions[idx * 3 + 2] = z;
      this.velocities[idx * 3] = Math.cos(a) * r;
      this.velocities[idx * 3 + 1] = up * (0.4 + Math.random());
      this.velocities[idx * 3 + 2] = Math.sin(a) * r;
      this.colors[idx * 3] = this._color.r;
      this.colors[idx * 3 + 1] = this._color.g;
      this.colors[idx * 3 + 2] = this._color.b;
      this.life[idx] = this.span[idx] = life * (0.6 + Math.random() * 0.8);
      this.sizes[idx] = 0.14 + Math.random() * 0.2;
      this._gravity = gravity;
    }
  }

  update(dt) {
    const g = this._gravity ?? -6;
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        this.sizes[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      alive++;
      const k = i * 3;
      this.velocities[k + 1] += g * dt;
      this.positions[k] += this.velocities[k] * dt;
      this.positions[k + 1] += this.velocities[k + 1] * dt;
      this.positions[k + 2] += this.velocities[k + 2] * dt;
      const f = Math.max(0, this.life[i] / this.span[i]);
      this.sizes[i] = 0.22 * f;
      const dim = 0.25 + 0.75 * f;
      this.colors[k] *= dim < 1 ? 0.995 : 1;
    }
    this.alive = alive;
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
  }

  setTier(tier) {
    // Shrink logical capacity without reallocating GPU buffers.
    this.capacity = Math.min(TIER_PARTICLES[tier] || TIER_PARTICLES.medium, this.positions.length / 3);
    for (let i = 0; i < this.life.length; i++) this.life[i] = 0;
  }

  dispose() {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

// Restrained ribbon trail behind the ball: ring buffer of recent positions,
// fading vertex colors. Deterministic from simulation positions.
export class Trail {
  constructor({ points = 36, color = 0xffffff, width = 0.1 } = {}) {
    this.n = points;
    this.ring = new Float32Array(this.n * 3);
    this.positions = new Float32Array(this.n * 3);
    this.colors = new Float32Array(this.n * 3);
    this.head = 0;
    this.count = 0;
    this._base = new THREE.Color(color);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.line = new THREE.Line(geo, mat);
    this.line.frustumCulled = false;
    this.line.layers.set(LAYER_FX);
    this.line.raycast = () => {};
    this.enabled = true;
  }

  push(x, y, z) {
    this.ring[this.head * 3] = x;
    this.ring[this.head * 3 + 1] = y;
    this.ring[this.head * 3 + 2] = z;
    this.head = (this.head + 1) % this.n;
    if (this.count < this.n) this.count++;
    this._rebuild();
  }

  clear() {
    this.count = 0;
    this._rebuild();
  }

  _rebuild() {
    const m = this.count;
    const pad = this.n - m;
    for (let i = 0; i < this.n; i++) {
      // Map i (oldest→newest) into the ring; unused slots repeat the oldest
      // point at zero alpha so the line never renders garbage.
      const j = Math.max(0, i - pad);
      const idx = m === 0 ? 0 : (this.head - m + j + this.n * 2) % this.n;
      this.positions[i * 3] = this.ring[idx * 3];
      this.positions[i * 3 + 1] = this.ring[idx * 3 + 1];
      this.positions[i * 3 + 2] = this.ring[idx * 3 + 2];
      const f = m <= 1 ? 0 : j / (m - 1);
      const a = this.enabled && i >= pad ? f * f * 0.85 : 0;
      this.colors[i * 3] = this._base.r * a;
      this.colors[i * 3 + 1] = this._base.g * a;
      this.colors[i * 3 + 2] = this._base.b * a;
    }
    this.line.geometry.attributes.position.needsUpdate = true;
    this.line.geometry.attributes.color.needsUpdate = true;
    this.line.geometry.setDrawRange(0, this.n);
  }

  setColor(color) {
    this._base.set(color);
  }

  dispose() {
    this.line.geometry.dispose();
    this.line.material.dispose();
  }
}

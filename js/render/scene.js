// Three.js presentation layer (spec §4). Consumes immutable simulation
// snapshots + interpolation alpha; never mutates rules state.
//
// Acceptance-gate notes (threejs skill principles, applied directly):
//  - deterministic visual seed: all layout derives from ruleset+theme, and
//    decorative randomness comes from its own seeded stream
//  - readable no-post baseline: hierarchy/selection/state read without any
//    post-processing (there is no post chain; glow comes from emissive
//    materials, so UI whites never feed bloom)
//  - quality tiers are mechanism-backed (shadows, particles, DPR, render
//    scale, environment detail) and never alter rules or hazard visibility
//  - debug views: fixed captures via ?debugcam=orbit|top|rail|broadcast

import * as THREE from 'three';
import { ParticlePool, Trail, LAYER_ENV, LAYER_GAME, LAYER_FX } from './vfx.js';
import { getTheme, CVD_PALETTES } from '../content/themes.js';
import { createRng, range } from '../rules/rng.js';
import { paddleY } from '../rules/engine.js';

export const QUALITY_TIERS = {
  low: { dpr: 1.0, shadows: false, particles: 'low', envDetail: 0.35, renderScale: 0.85 },
  medium: { dpr: 1.5, shadows: false, particles: 'medium', envDetail: 0.7, renderScale: 1.0 },
  high: { dpr: 2.0, shadows: true, particles: 'high', envDetail: 1.0, renderScale: 1.0 },
};

// Authored camera framing constants (no magic offsets — these are the
// composition contract; expose and tune here only).
export const CAMERA_VIEWS = {
  broadcast: { dir: [0, 0.58, 0.8], lookAhead: 0.1, margin: 1.22, fov: 38 },
  behind: { dir: [0, 0.34, 0.62], lookAhead: -0.06, margin: 1.3, fov: 42 },
  top: { dir: [0, 1.0, 0.001], lookAhead: 0, margin: 1.15, fov: 34 }, // debug
  rail: { dir: [0.85, 0.4, 0.35], lookAhead: 0, margin: 1.25, fov: 36 }, // debug
  orbit: { dir: [0.6, 0.5, 0.62], lookAhead: 0, margin: 1.3, fov: 38 }, // debug
};

const SHAKE_BY_EVENT = { wall: 0.02, paddle: 0.05, bumper: 0.07, goal: 0.2, 'match-end': 0.3 };

export class ArenaRenderer {
  constructor(canvas, { tier = 'medium', reducedMotion = false, trails = true, onContextLost = null } = {}) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.trailsEnabled = trails;
    this.onContextLost = onContextLost;
    this.tierName = tier in QUALITY_TIERS ? tier : 'medium';
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this._initRenderer();
    this._fpsSamples = [];
    this._shake = 0;
    this._shakeSeed = 0;
    this._camPos = new THREE.Vector3();
    this._camVel = new THREE.Vector3();
    this._camTarget = new THREE.Vector3();
    this._camLook = new THREE.Vector3();
    this._camLookVel = new THREE.Vector3();
    this._viewName = 'broadcast';
    this._side = 0;
    this._elapsed = 0;
  }

  _initRenderer() {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._contextLost = true;
      this.onContextLost?.(true);
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this._contextLost = false;
      // Rebuild GPU resources from retained CPU descriptors.
      this._createRenderer();
      if (this._lastBuild) this.build(this._lastBuild.ruleset, this._lastBuild.themeId, this._lastBuild.opts);
      this.onContextLost?.(false);
    });
    this._createRenderer();
  }

  _createRenderer() {
    this.renderer?.dispose();
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.tierName !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = true; // explicit color ownership: one clear path
    this.renderer.setClearColor(0x030408, 1);
  }

  static supported() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  // (Re)build the whole arena for a match. Everything derives from the
  // ruleset + theme id, so a rebuild after context loss is exact.
  build(ruleset, themeId, { side = 0, cvd = 'none', view = 'broadcast', obstacles = null } = {}) {
    this._lastBuild = { ruleset, themeId, opts: { side, cvd, view, obstacles } };
    this._side = side;
    this._viewName = view in CAMERA_VIEWS ? view : 'broadcast';
    const theme = getTheme(themeId);
    const pal = CVD_PALETTES[cvd] || null;
    this.theme = { ...theme, ...(pal ? { paddleA: pal.paddleA, paddleB: pal.paddleB, ball: pal.ball, accent: pal.accent } : {}) };
    this.ruleset = ruleset;

    this.scene?.traverse(disposeObject);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(this.theme.fog, 40, 110);
    this.camera = new THREE.PerspectiveCamera(CAMERA_VIEWS[this._viewName].fov, 1, 0.1, 220);
    this.camera.layers.enable(LAYER_GAME);
    this.camera.layers.enable(LAYER_FX);
    this.camera.layers.enable(LAYER_ENV);

    this._buildLights();
    this._buildFloor();
    this._buildRails();
    this._buildGoalLines();
    this._buildObstacles(obstacles ?? ruleset.obstacles ?? []);
    this._buildActors();
    this._buildSurround();

    this.fx = new ParticlePool(QUALITY_TIERS[this.tierName].particles);
    this.scene.add(this.fx.points);
    this.trail = new Trail({ color: this.theme.ball });
    this.trail.enabled = this.trailsEnabled && !this.reducedMotion;
    this.scene.add(this.trail.line);

    this._applyTier();
    this._snapCamera();
    // Prewarm shader variants before play so active play never compiles.
    this.renderer.compile(this.scene, this.camera);
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(this.theme.wall, this.theme.floor, 0.55);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.35); // one dominant key
    key.position.set(12, 26, 10);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -16;
    key.shadow.camera.right = 16;
    key.shadow.camera.top = 20;
    key.shadow.camera.bottom = -20;
    key.shadow.bias = -0.0005;
    key.layers.enable(LAYER_ENV);
    this.scene.add(key);
    this.keyLight = key;
    const fill = new THREE.AmbientLight(this.theme.accent, 0.14); // soft fill
    this.scene.add(fill);
  }

  _buildFloor() {
    const { w, h } = this.ruleset.arena;
    const mat = new THREE.MeshStandardMaterial({ color: this.theme.floor, roughness: 0.85, metalness: 0.25 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w + 8, h + 10), mat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.layers.set(LAYER_ENV);
    this.scene.add(floor);

    // Grid: one LineSegments draw call, dim theme color.
    const pts = [];
    const gx = w / 2;
    const gz = h / 2;
    for (let x = -Math.ceil(gx); x <= gx; x += 1) pts.push(x, 0.01, -gz - 1, x, 0.01, gz + 1);
    for (let z = -Math.ceil(gz); z <= gz; z += 1) pts.push(-gx - 1, 0.01, z, gx + 1, 0.01, z);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const grid = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: this.theme.grid, transparent: true, opacity: 0.35 })
    );
    grid.layers.set(LAYER_ENV);
    this.scene.add(grid);

    // Center line, slightly brighter.
    const cl = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.02, 0.08),
      new THREE.MeshBasicMaterial({ color: this.theme.wall, transparent: true, opacity: 0.5 })
    );
    cl.position.y = 0.02;
    cl.layers.set(LAYER_ENV);
    this.scene.add(cl);
  }

  _buildRails() {
    const { w, h } = this.ruleset.arena;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a0d1a,
      roughness: 0.4,
      metalness: 0.7,
      emissive: this.theme.wallEmissive,
      emissiveIntensity: 0.9,
    });
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.5, h + 0.6), mat);
      rail.position.set(s * (w / 2 + 0.15), 0.25, 0);
      rail.castShadow = true;
      rail.layers.set(LAYER_ENV);
      this.scene.add(rail);
    }
  }

  _buildGoalLines() {
    const { w, h } = this.ruleset.arena;
    this.goalMats = [];
    for (const s of [0, 1]) {
      const color = s === 0 ? this.theme.paddleA : this.theme.paddleB;
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
      const line = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, 0.18), mat);
      line.position.set(0, 0.04, (s === 0 ? 1 : -1) * (h / 2 + 0.35));
      line.layers.set(LAYER_ENV);
      this.scene.add(line);
      this.goalMats.push({ mat, pulse: 0, base: color });
    }
  }

  _buildObstacles(obstacles) {
    this.obstacleMeshes = [];
    for (const o of obstacles) {
      let mesh;
      if (o.type === 'bumper') {
        mesh = new THREE.Group();
        const core = new THREE.Mesh(
          new THREE.CylinderGeometry(o.r * 0.72, o.r * 0.85, 0.7, 24),
          new THREE.MeshStandardMaterial({ color: 0x101425, roughness: 0.35, metalness: 0.8, emissive: this.theme.obstacle, emissiveIntensity: 0.35 })
        );
        core.position.y = 0.35;
        core.castShadow = true;
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(o.r, 0.06, 10, 40),
          new THREE.MeshBasicMaterial({ color: this.theme.obstacle })
        );
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.72;
        mesh.add(core, ring);
      } else {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry((o.hw || 1) * 2, 0.55, (o.hh || 0.5) * 2),
          new THREE.MeshStandardMaterial({ color: 0x101425, roughness: 0.4, metalness: 0.7, emissive: this.theme.obstacle, emissiveIntensity: 0.55 })
        );
        mesh.position.y = 0.3;
        mesh.castShadow = true;
      }
      mesh.traverse((m) => m.layers?.set(LAYER_GAME));
      mesh.position.x = o.x;
      mesh.position.z = -o.y;
      this.scene.add(mesh);
      this.obstacleMeshes.push({ def: o, mesh });
    }
  }

  _buildActors() {
    const r = this.ruleset;
    this.paddleMeshes = [0, 1].map((side) => {
      const color = side === 0 ? this.theme.paddleA : this.theme.paddleB;
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(r.paddleWidth, 0.42, 0.72),
        new THREE.MeshStandardMaterial({ color: 0x0c1020, roughness: 0.3, metalness: 0.75, emissive: color, emissiveIntensity: 0.55 })
      );
      body.position.y = 0.32;
      body.castShadow = true;
      const edge = new THREE.Mesh(new THREE.BoxGeometry(r.paddleWidth + 0.06, 0.08, 0.78), new THREE.MeshBasicMaterial({ color }));
      edge.position.y = 0.56;
      // Shape reinforces color (accessibility): side 0 bar, side 1 diamond.
      const marker =
        side === 0
          ? new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.34), new THREE.MeshBasicMaterial({ color: 0xffffff }))
          : new THREE.Mesh(new THREE.OctahedronGeometry(0.2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      marker.position.y = 0.66;
      group.add(body, edge, marker);
      group.traverse((m) => m.layers?.set(LAYER_GAME));
      this.scene.add(group);
      return group;
    });

    this.ballMesh = new THREE.Group();
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(r.ballRadius, 24, 18),
      new THREE.MeshStandardMaterial({ color: 0x101018, roughness: 0.25, metalness: 0.4, emissive: this.theme.ball, emissiveIntensity: 1.6 })
    );
    ball.castShadow = true;
    this.ballMesh.add(ball);
    this.ballLight = new THREE.PointLight(this.theme.ball, 12, 12, 2);
    this.ballLight.position.y = 0.4;
    this.ballMesh.add(this.ballLight);
    this.ballMesh.traverse((m) => m.layers?.set(LAYER_GAME));
    this.scene.add(this.ballMesh);
    this._ballCore = ball;
  }

  _buildSurround() {
    // Restrained environmental storytelling: a dim ring of instanced pillars
    // (deterministic decorative seed, instanced in one draw call).
    const detail = QUALITY_TIERS[this.tierName].envDetail;
    const count = Math.max(6, Math.round(18 * detail));
    // Decorative stream is seeded from the theme, never from rules randomness.
    const rng = createRng(0xdec0 ^ String(this.theme.id).length ^ (this.theme.wall & 0xffff));
    const geo = new THREE.BoxGeometry(0.5, 1, 0.5);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a0e1c,
      roughness: 0.6,
      metalness: 0.5,
      emissive: this.theme.wall,
      emissiveIntensity: 0.22,
    });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const m4 = new THREE.Matrix4();
    const { w, h } = this.ruleset.arena;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + range(rng, -0.08, 0.08);
      const rad = Math.max(w, h) * range(rng, 0.85, 1.15);
      const height = range(rng, 2.5, 9) * detail + 1;
      m4.makeScale(1, height, 1);
      m4.setPosition(Math.cos(a) * rad, height / 2 - 0.5, Math.sin(a) * rad);
      inst.setMatrixAt(i, m4);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.layers.set(LAYER_ENV);
    this.scene.add(inst);
  }

  // -------------------------------------------------------------------------

  _applyTier() {
    const t = QUALITY_TIERS[this.tierName];
    this.keyLight.castShadow = t.shadows;
    this.renderer.shadowMap.enabled = t.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.fx?.setTier(t.particles);
    this._renderScale = t.renderScale;
    this.resize();
  }

  setQuality(tier) {
    if (!(tier in QUALITY_TIERS)) return;
    this.tierName = tier;
    this._applyTier();
  }

  setReducedMotion(on) {
    this.reducedMotion = on;
    if (this.trail) this.trail.enabled = this.trailsEnabled && !on;
    if (this.fx) this.fx.budgetScale = on ? 0.35 : 1;
  }

  setView(name) {
    if (name in CAMERA_VIEWS) this._viewName = name; // transition is sprung, interruptible
  }

  // Fit framing to the viewport: distance derives from arena bounds and FOV.
  resize() {
    if (!this.renderer || !this.camera) return;
    const w = this.canvas.clientWidth || 1;
    const hgt = this.canvas.clientHeight || 1;
    const dpr = Math.min(window.devicePixelRatio || 1, QUALITY_TIERS[this.tierName].dpr);
    this.renderer.setPixelRatio(dpr * this._renderScale);
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
  }

  _frameTargets(out) {
    const view = CAMERA_VIEWS[this._viewName];
    const { w, h } = this.ruleset.arena;
    const flip = this._side === 1 ? -1 : 1;
    const aspect = this.camera.aspect || 1;
    const vFov = (view.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const needH = (h / 2 + 1.5) * view.margin;
    const needW = (w / 2 + 1.5) * view.margin;
    const dist = Math.max(needH / Math.tan(vFov / 2), needW / Math.tan(hFov / 2));
    const dir = new THREE.Vector3(view.dir[0], view.dir[1], view.dir[2] * flip).normalize();
    out.pos.copy(dir.multiplyScalar(dist));
    out.pos.y = Math.max(out.pos.y, 2.5);
    out.look.set(0, 0, view.lookAhead * h * flip);
    return out;
  }

  _snapCamera() {
    const t = this._frameTargets({ pos: new THREE.Vector3(), look: new THREE.Vector3() });
    this._camPos.copy(t.pos);
    this._camLook.copy(t.look);
    this._camVel.set(0, 0, 0);
    this._camLookVel.set(0, 0, 0);
    this.camera.position.copy(t.pos);
    this.camera.lookAt(t.look);
  }

  // Critically damped spring — interruptible, never cumulative lerp.
  _springCamera(dt) {
    const t = this._frameTargets({ pos: new THREE.Vector3(), look: new THREE.Vector3() });
    const omega = 3.2;
    const k = omega * omega;
    const c = 2 * omega;
    for (const [cur, vel, tgt] of [
      [this._camPos, this._camVel, t.pos],
      [this._camLook, this._camLookVel, t.look],
    ]) {
      for (const axis of ['x', 'y', 'z']) {
        const a = k * (tgt[axis] - cur[axis]) - c * vel[axis];
        vel[axis] += a * dt;
        cur[axis] += vel[axis] * dt;
      }
    }
    this.camera.position.copy(this._camPos);
    if (this._shake > 0.001 && !this.reducedMotion) {
      // Low-amplitude, event-tiered shake; never affects raycast truth.
      this._shake *= Math.exp(-5.2 * dt);
      this._shakeSeed += dt * 37;
      const s = this._shake;
      this.camera.position.x += Math.sin(this._shakeSeed * 1.3) * s * 0.12;
      this.camera.position.y += Math.sin(this._shakeSeed * 1.7 + 2) * s * 0.09;
    }
    this.camera.lookAt(this._camLook);
  }

  kick(amount) {
    if (!this.reducedMotion) this._shake = Math.min(0.35, this._shake + amount);
  }

  // -------------------------------------------------------------------------

  // interp: { prev, cur, alpha } — gameplay animation derives from
  // simulation state + interpolation alpha, never from frame count.
  update(interp, dt) {
    if (!this.scene || this._contextLost) return;
    const { prev, cur, alpha } = interp;
    const lerp = (a, b) => a + (b - a) * alpha;

    const bx = lerp(prev.ball.x, cur.ball.x);
    const by = lerp(prev.ball.y, cur.ball.y);
    this.ballMesh.position.set(bx, 0.42, -by);
    const spd = cur.ball.speed / cur.ruleset.maxBallSpeed;
    this._ballCore.material.emissiveIntensity = 1.2 + spd * 1.4;
    this.ballLight.intensity = 8 + spd * 14;
    if (cur.phase === 'rally') this.trail?.push(bx, 0.42, -by);
    else if (cur.phase === 'serve') this.trail?.clear();

    for (let side = 0; side < 2; side++) {
      const px = lerp(prev.paddles[side].x, cur.paddles[side].x);
      const mesh = this.paddleMeshes[side];
      mesh.position.set(px, 0, -paddleY(cur, side));
      // Selection/state readability without bloom: server paddle glows.
      const isServer = cur.phase === 'serve' && cur.server === side;
      mesh.children[1].material.color.set(isServer ? 0xffffff : side === 0 ? this.theme.paddleA : this.theme.paddleB);
    }

    // Moving blockers derive phase from the authoritative tick.
    for (const { def, mesh } of this.obstacleMeshes) {
      if (def.type === 'block' && def.move) {
        const period = Math.max(1, def.move.period || 480);
        const s = Math.sin((2 * Math.PI * ((cur.tick % period) + alpha)) / period);
        if (def.move.axis === 'y') mesh.position.z = -(def.y + s * (def.move.amp || 0));
        else mesh.position.x = def.x + s * (def.move.amp || 0);
      }
    }

    // Goal-line pulse decay.
    for (const g of this.goalMats) {
      if (g.pulse > 0.01) {
        g.pulse *= Math.exp(-3.5 * dt);
        g.mat.opacity = 0.85 + g.pulse * 0.15;
        g.mat.color.set(g.base).lerp(new THREE.Color(0xffffff), g.pulse);
      }
    }

    this.fx?.update(this.reducedMotion ? dt * 0.6 : dt);
    this._springCamera(Math.min(dt, 0.05));
  }

  handleEvents(events, { onAudioEvent = null } = {}) {
    for (const e of events) {
      const z = -(e.y ?? 0);
      switch (e.t) {
        case 'paddle':
          this.fx?.spawn(e.x, 0.5, z, { count: 10, color: e.player === 0 ? this.theme.paddleA : this.theme.paddleB, speed: 4.5, life: 0.45 });
          break;
        case 'wall':
          this.fx?.spawn(e.x, 0.4, z, { count: 6, color: this.theme.wall, speed: 3, life: 0.35 });
          break;
        case 'bumper':
          this.fx?.spawn(e.x, 0.6, z, { count: 12, color: this.theme.obstacle, speed: 5, life: 0.5 });
          break;
        case 'goal': {
          const side = 1 - e.player;
          this.goalMats[side].pulse = 1;
          this.fx?.spawn(e.x ?? 0, 0.5, -(e.y ?? 0), { count: 46, color: e.player === 0 ? this.theme.paddleA : this.theme.paddleB, speed: 8, life: 0.9 });
          break;
        }
        case 'match-end':
          this.fx?.spawn(0, 1, this._side === e.winner ? 6 : -6, { count: 70, color: this.theme.accent, speed: 9, up: 5, life: 1.2 });
          break;
      }
      if (SHAKE_BY_EVENT[e.t]) this.kick(SHAKE_BY_EVENT[e.t]);
      onAudioEvent?.(e);
    }
  }

  render(dt) {
    if (!this.renderer || !this.scene || this._contextLost) return;
    this._elapsed += dt;
    this.renderer.render(this.scene, this.camera);
    this._trackFps(dt);
  }

  _trackFps(dt) {
    // Dynamically lower render scale before ever touching simulation rate.
    this._fpsSamples.push(dt);
    if (this._fpsSamples.length < 240) return;
    const avg = this._fpsSamples.reduce((a, b) => a + b, 0) / this._fpsSamples.length;
    this._fpsSamples.length = 0;
    if (avg > 0.02 && this._renderScale > 0.6) {
      this._renderScale = Math.max(0.6, this._renderScale - 0.15);
      this.resize();
    } else if (avg > 0.024 && this.tierName !== 'low') {
      this.setQuality(this.tierName === 'high' ? 'medium' : 'low');
    }
  }

  // DOM labels align with projected Three.js targets (single layout model).
  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height, behind: v.z > 1 };
  }

  screenToArenaX(clientX) {
    // Map a pointer x to an arena x at the near paddle plane — the only
    // raycast the game needs, against the explicit gameplay plane.
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, 0), this.camera);
    ray.layers.set(LAYER_GAME);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.4);
    const hit = new THREE.Vector3();
    ray.ray.intersectPlane(plane, hit);
    return hit ? hit.x : 0;
  }

  counts() {
    return {
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      particles: this.fx?.alive ?? 0,
    };
  }

  dispose() {
    this.scene?.traverse(disposeObject);
    this.fx?.dispose();
    this.trail?.dispose();
    this.renderer?.dispose();
  }
}

function disposeObject(obj) {
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      for (const v of Object.values(m)) {
        if (v && v.isTexture) v.dispose();
      }
      m.dispose();
    }
  }
}

// Three.js presentation layer (spec §4). Consumes immutable simulation
// snapshots + interpolation alpha; never mutates rules state.
//
// Acceptance-gate notes (threejs skill principles, applied directly):
//  - deterministic visual seed: all layout derives from ruleset+theme, and
//    decorative randomness comes from its own seeded stream
//  - readable no-post baseline: hierarchy/selection/state read without any
//    post-processing; the post chain (GTAO → bloom → grade → output → AA)
//    only runs when a Graphics setting asks for it, and bloom is fed by HDR
//    emissive accents (ball, neon strips), never by UI or gameplay whites
//  - quality is mechanism-backed (gfx.js): shadows, AO, bloom, grade,
//    anti-aliasing, floor reflections, particles, background motion,
//    material detail, render scale — never rules or hazard visibility
//  - debug views: fixed captures via ?debugcam=orbit|top|rail|broadcast

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ParticlePool, Trail, LAYER_ENV, LAYER_GAME, LAYER_FX } from './vfx.js';
import { detectPreset, describe, resolve, SHADOW_MAP } from './gfx.js';
import { getTheme, CVD_PALETTES } from '../content/themes.js';
import { createRng, range, next } from '../rules/rng.js';
import { paddleY, DEFAULT_RULESET } from '../rules/engine.js';

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

// HDR multipliers for neon strips in the detailed look: values above 1.0
// feed the bloom threshold; plain look keeps display-range colours.
const NEON_HDR = 2.4;
const ENV_INTENSITY = 0.45;

// Colour grade + vignette (display-space colours in, display-space out).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.28 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 hdr = src.rgb;
      vec3 c = clamp(hdr, 0.0, 1.0);
      // Gentle S-curve, a touch more saturation, cool shadows / neutral highlights.
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.12);
      s *= mix(vec3(0.95, 0.98, 1.06), vec3(1.0), smoothstep(0.15, 0.7, l));
      s = s * 0.985 + 0.012; // keep the darkest arena detail legible
      // Grade the display range; over-range (HDR) energy passes through to tone mapping.
      c = mix(hdr, s + max(hdr - 1.0, 0.0), uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

export class ArenaRenderer {
  constructor(canvas, { gfx = {}, reducedMotion = false, trails = true, onContextLost = null } = {}) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.trailsEnabled = trails;
    this.onContextLost = onContextLost;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    this.pixelRatio = 1;
    this.size = [0, 0];
    this.adaptiveScale = 1;
    this.fps = 0;
    this._frames = [];
    this._buildId = 0;
    this._dirty = true;
    this._initRenderer();
    this.gpu = readGpu(this.renderer);
    this.detected = detectPreset(this.gpu, { touch: isTouchOnly() });
    this.q = resolve({}, this.detected);
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
    this._idleT = 0;
    this._tmpColor = new THREE.Color();
    this._white = new THREE.Color(0xffffff);
    this.setGraphics(gfx);
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
    this.composer?.dispose();
    this.composer = null;
    this.postKey = null;
    this._envTex?.dispose();
    this._envTex = null;
    this.renderer?.dispose();
    // Canvas MSAA is fixed at context creation, so anti-aliasing is done in
    // the post chain (MSAA render target, SMAA or FXAA) and Low draws plain.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = true; // explicit color ownership: one clear path
    this.size = [0, 0];
  }

  static supported() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ graphics settings

  /** Apply saved graphics settings (the `settings.graphics` object); live, no reload. */
  setGraphics(saved) {
    const prev = this.q;
    const g = resolve(saved, this.detected);
    this.q = g;
    this.saved = { ...(saved || {}) };
    const size = SHADOW_MAP[g.shadows];
    this.renderer.shadowMap.enabled = size > 0;
    this.renderer.shadowMap.needsUpdate = true;
    this.fx?.setTier(g.particles);
    this._applyShadows();
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this._fpsVisible(g.showFps);
    document.body.dataset.gfxPreset = g.preset;
    // Scene-shape settings rebuild the arena from its retained descriptors.
    const rebuild = prev && this._lastBuild && (prev.detail !== g.detail || prev.reflections !== g.reflections || prev.background !== g.background || prev.particles !== g.particles);
    if (rebuild) this.build(this._lastBuild.ruleset, this._lastBuild.themeId, this._lastBuild.opts);
    else this._markMaterials();
    this._dirty = true;
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost summary. */
  graphicsInfo(tr) {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px, tr),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _applyShadows() {
    const size = SHADOW_MAP[this.q.shadows];
    const key = this.keyLight;
    if (!key) return;
    key.castShadow = size > 0;
    if (size > 0 && key.shadow.mapSize.x !== size) {
      key.shadow.mapSize.set(size, size);
      key.shadow.map?.dispose();
      key.shadow.map = null;
    }
    if (this.blobs) for (const b of this.blobs) b.visible = size === 0 && this.q.detail === 'detailed';
  }

  _markMaterials() {
    // Materials pick up shadow-map changes on recompile.
    this.scene?.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
    });
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '— fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  setTrails(on) {
    this.trailsEnabled = !!on;
    if (this.trail) this.trail.enabled = this.trailsEnabled && !this.reducedMotion;
  }

  get _animated() {
    return this.q.background === 'animated' && !this.reducedMotion;
  }

  // ------------------------------------------------------------------ scene build

  // (Re)build the whole arena for a match. Everything derives from the
  // ruleset + theme id + graphics settings, so a rebuild is exact.
  build(ruleset, themeId, { side = 0, cvd = 'none', view = 'broadcast', obstacles = null, attract = false } = {}) {
    this._lastBuild = { ruleset, themeId, opts: { side, cvd, view, obstacles, attract } };
    this._attract = attract;
    this._side = side;
    this._viewName = view in CAMERA_VIEWS ? view : 'broadcast';
    const theme = getTheme(themeId);
    const pal = CVD_PALETTES[cvd] || null;
    this.theme = { ...theme, ...(pal ? { paddleA: pal.paddleA, paddleB: pal.paddleB, ball: pal.ball, accent: pal.accent } : {}) };
    this.ruleset = ruleset;
    this.detailed = this.q.detail === 'detailed';

    this.scene?.traverse(disposeObject);
    this.fx?.dispose();
    this.trail?.dispose();
    this.reflector?.getRenderTarget().dispose();
    this.reflector = null;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.theme.fog);
    this.scene.fog = new THREE.Fog(this.theme.fog, 40, 110);
    if (this.detailed) this.scene.environment = this._environment();
    this.camera = new THREE.PerspectiveCamera(CAMERA_VIEWS[this._viewName].fov, 1, 0.1, 320);
    this.camera.layers.enable(LAYER_GAME);
    this.camera.layers.enable(LAYER_FX);
    this.camera.layers.enable(LAYER_ENV);
    this.blobs = [];
    this.strips = null;

    this._buildLights();
    this._buildFloor();
    this._buildRails();
    this._buildGoalLines();
    this._buildObstacles(obstacles ?? ruleset.obstacles ?? []);
    this._buildActors();
    this._buildSurround();
    this._buildMotes();

    this.fx = new ParticlePool(this.q.particles);
    this.fx.budgetScale = this.reducedMotion ? 0.35 : 1;
    this.scene.add(this.fx.points);
    this.trail = new Trail({ color: this.theme.ball });
    this.trail.enabled = this.trailsEnabled && !this.reducedMotion;
    this.scene.add(this.trail.line);

    this._applyShadows();
    this._buildId++;
    this.postKey = null;
    this._dirty = true;
    this.resize();
    this._snapCamera();
    if (attract) this.idle(0);
    // Prewarm shader variants before play so active play never compiles.
    this.renderer.compile(this.scene, this.camera);
  }

  /** Title/menu backdrop: the arena with a cosmetic rally (no rules state). */
  showAttract(themeId = 'neon-district') {
    this.build(DEFAULT_RULESET, themeId, { attract: true, view: 'orbit' });
  }

  _environment() {
    if (!this._envTex) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment(this.renderer);
      this._envTex = pmrem.fromScene(room, 0.04).texture;
      room.traverse(disposeObject);
      pmrem.dispose();
    }
    return this._envTex;
  }

  _std(params) {
    // Detailed look: PBR with clearcoat on glossy pieces and IBL reflections.
    if (this.detailed) {
      return new THREE.MeshPhysicalMaterial({ envMapIntensity: ENV_INTENSITY, ...params });
    }
    const { clearcoat, clearcoatRoughness, ...rest } = params;
    return new THREE.MeshStandardMaterial(rest);
  }

  _neon(color, opacity = 1, hdr = NEON_HDR) {
    const c = new THREE.Color(color);
    if (this.detailed) c.multiplyScalar(hdr);
    return new THREE.MeshBasicMaterial({ color: c, transparent: opacity < 1, opacity, fog: true });
  }

  _buildLights() {
    const hemi = new THREE.HemisphereLight(this.theme.wall, this.theme.floor, this.detailed ? 0.4 : 0.55);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 1.35); // one dominant key
    key.position.set(7, 22, 9);
    key.target.position.set(0, 0, 0);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    key.layers.enable(LAYER_ENV);
    this.scene.add(key, key.target);
    this.keyLight = key;
    this._fitShadow();
    const fill = new THREE.AmbientLight(this.theme.accent, 0.14); // soft fill
    this.scene.add(fill);
  }

  // Fit the shadow frustum tightly around the play area (arena + rails +
  // actor height) as seen from the key light.
  _fitShadow() {
    const key = this.keyLight;
    const { w, h } = this.ruleset.arena;
    const view = new THREE.Matrix4().lookAt(key.position, key.target.position, new THREE.Vector3(0, 1, 0));
    view.setPosition(key.position);
    const inv = view.clone().invert();
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const p = new THREE.Vector3();
    for (const x of [-w / 2 - 0.6, w / 2 + 0.6]) {
      for (const z of [-h / 2 - 1.2, h / 2 + 1.2]) {
        for (const y of [0, 1.2]) {
          p.set(x, y, z).applyMatrix4(inv);
          min.min(p);
          max.max(p);
        }
      }
    }
    const cam = key.shadow.camera;
    Object.assign(cam, { left: min.x, right: max.x, bottom: min.y, top: max.y, near: Math.max(0.5, -max.z - 1), far: -min.z + 1 });
    cam.updateProjectionMatrix();
  }

  _buildFloor() {
    const { w, h } = this.ruleset.arena;
    // Detailed floor runs out into the fog so the arena sits in a space, not on a slab.
    const fw = this.detailed ? Math.max(w, h) * 5 : w + 8;
    const fh = this.detailed ? Math.max(w, h) * 5 : h + 10;
    let mat;
    if (this.detailed) {
      const tex = floorTexture(this.theme);
      tex.repeat.set(fw / 4, fh / 4);
      const reflect = this.q.reflections === 'on';
      mat = new THREE.MeshStandardMaterial({
        color: this.theme.floor,
        map: tex,
        roughnessMap: tex,
        roughness: 0.9,
        metalness: 0.35,
        envMapIntensity: ENV_INTENSITY * 0.35,
        transparent: reflect,
        opacity: reflect ? 0.64 : 1,
      });
      if (reflect) {
        const [rw, rh] = reflectionSize(this.canvas.clientWidth || 800, this.canvas.clientHeight || 600, 1);
        const refl = new Reflector(new THREE.PlaneGeometry(fw, fh), {
          textureWidth: rw,
          textureHeight: rh,
          clipBias: 0.003,
          color: 0x8a8f9a,
          multisample: 0,
        });
        refl.rotation.x = -Math.PI / 2;
        refl.position.y = -0.02;
        refl.layers.set(LAYER_ENV);
        // The glossy floor sits above the mirror; hide it (and its grid)
        // while the mirror draws its reflected view.
        const base = refl.onBeforeRender;
        refl.onBeforeRender = (...args) => {
          const hide = [this._floorMesh, this._gridMesh].filter(Boolean);
          for (const o of hide) o.visible = false;
          base.apply(refl, args);
          for (const o of hide) o.visible = true;
        };
        this.scene.add(refl);
        this.reflector = refl;
      }
    } else {
      mat = new THREE.MeshStandardMaterial({ color: this.theme.floor, roughness: 0.85, metalness: 0.25 });
    }
    // Push the floor's depth back so the grid/centre line on it never z-fight
    // at distance; a see-through (reflective) floor draws first and writes no depth.
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 2;
    mat.polygonOffsetUnits = 2;
    if (mat.transparent) mat.depthWrite = false;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), mat);
    floor.renderOrder = -1;
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    floor.layers.set(LAYER_ENV);
    this.scene.add(floor);
    this._floorMesh = floor;

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
      new THREE.LineBasicMaterial({ color: this.theme.grid, transparent: true, opacity: this.detailed ? 0.5 : 0.35 })
    );
    grid.layers.set(LAYER_ENV);
    this.scene.add(grid);
    this._gridMesh = grid;

    // Center line, slightly brighter.
    const cl = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, 0.08), this._neon(this.theme.wall, 0.5));
    if (this.detailed) cl.material.color.multiplyScalar(0.3);
    cl.position.y = 0.02;
    cl.layers.set(LAYER_ENV);
    this.scene.add(cl);

    // Contact grounding without shadow maps: soft blobs under ball + paddles.
    if (this.detailed) {
      const blobTex = blobTexture();
      for (let i = 0; i < 3; i++) {
        const s = i === 2 ? 1.4 : 1;
        const blob = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, color: 0x000000, opacity: 0.7 })
        );
        blob.rotation.x = -Math.PI / 2;
        blob.position.y = 0.015;
        blob.scale.set(s, s, 1);
        blob.layers.set(LAYER_ENV);
        blob.renderOrder = 1;
        this.scene.add(blob);
        this.blobs.push(blob);
      }
    }
  }

  _buildRails() {
    const { w, h } = this.ruleset.arena;
    const mat = this._std({
      color: 0x0a0d1a,
      roughness: 0.4,
      metalness: 0.7,
      emissive: this.theme.wallEmissive,
      emissiveIntensity: this.detailed ? 0.35 : 0.9,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
    });
    for (const s of [-1, 1]) {
      const geo = this.detailed ? new RoundedBoxGeometry(0.3, 0.5, h + 0.6, 2, 0.08) : new THREE.BoxGeometry(0.3, 0.5, h + 0.6);
      const rail = new THREE.Mesh(geo, mat);
      rail.position.set(s * (w / 2 + 0.15), 0.25, 0);
      rail.castShadow = true;
      rail.receiveShadow = this.detailed;
      rail.layers.set(LAYER_ENV);
      this.scene.add(rail);
      if (this.detailed) {
        // Neon tube along the rail top: the arena's signature light line.
        const tube = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, h + 0.5), this._neon(this.theme.wall));
        tube.position.set(s * (w / 2 + 0.15 - s * 0.1), 0.52, 0);
        tube.layers.set(LAYER_ENV);
        this.scene.add(tube);
      }
    }
  }

  _buildGoalLines() {
    const { w, h } = this.ruleset.arena;
    this.goalMats = [];
    for (const s of [0, 1]) {
      const color = s === 0 ? this.theme.paddleA : this.theme.paddleB;
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
      const base = new THREE.Color(color);
      if (this.detailed) base.multiplyScalar(1.6);
      mat.color.copy(base);
      const line = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, 0.18), mat);
      line.position.set(0, 0.04, (s === 0 ? 1 : -1) * (h / 2 + 0.35));
      line.layers.set(LAYER_ENV);
      this.scene.add(line);
      this.goalMats.push({ mat, pulse: 0, base });
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
          this._std({ color: 0x101425, roughness: 0.35, metalness: 0.8, emissive: this.theme.obstacle, emissiveIntensity: 0.35, clearcoat: 1, clearcoatRoughness: 0.2 })
        );
        core.position.y = 0.35;
        core.castShadow = true;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(o.r, 0.06, 10, 40), this._neon(this.theme.obstacle));
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.72;
        mesh.add(core, ring);
      } else {
        const bw = (o.hw || 1) * 2;
        const bd = (o.hh || 0.5) * 2;
        mesh = new THREE.Mesh(
          this.detailed ? new RoundedBoxGeometry(bw, 0.55, bd, 2, 0.08) : new THREE.BoxGeometry(bw, 0.55, bd),
          this._std({ color: 0x101425, roughness: 0.4, metalness: 0.7, emissive: this.theme.obstacle, emissiveIntensity: 0.55, clearcoat: 0.8, clearcoatRoughness: 0.2 })
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
    this.edgeColors = [];
    this.paddleMeshes = [0, 1].map((side) => {
      const color = side === 0 ? this.theme.paddleA : this.theme.paddleB;
      const group = new THREE.Group();
      const body = new THREE.Mesh(
        this.detailed ? new RoundedBoxGeometry(r.paddleWidth, 0.42, 0.72, 3, 0.12) : new THREE.BoxGeometry(r.paddleWidth, 0.42, 0.72),
        this._std({ color: 0x0c1020, roughness: 0.3, metalness: 0.75, emissive: color, emissiveIntensity: 0.55, clearcoat: 1, clearcoatRoughness: 0.12 })
      );
      body.position.y = 0.32;
      body.castShadow = true;
      const edge = new THREE.Mesh(new THREE.BoxGeometry(r.paddleWidth + 0.06, 0.08, 0.78), this._neon(color, 1, 1.5));
      edge.position.y = 0.56;
      this.edgeColors.push(edge.material.color.clone());
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
      new THREE.SphereGeometry(r.ballRadius, this.detailed ? 32 : 24, this.detailed ? 24 : 18),
      this._std({ color: 0x101018, roughness: 0.25, metalness: 0.4, emissive: this.theme.ball, emissiveIntensity: 1.6, clearcoat: 1, clearcoatRoughness: 0.05 })
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
    const detail = this.detailed ? 1 : 0.35;
    const count = Math.max(6, Math.round(18 * detail));
    // Decorative stream is seeded from the theme, never from rules randomness.
    const rng = createRng(0xdec0 ^ String(this.theme.id).length ^ (this.theme.wall & 0xffff));
    const geo = new THREE.BoxGeometry(0.5, 1, 0.5);
    const mat = this._std({
      color: 0x0a0e1c,
      roughness: 0.6,
      metalness: 0.5,
      emissive: this.theme.wall,
      emissiveIntensity: this.detailed ? 0.08 : 0.22,
    });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const strips = this.detailed ? new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 1, 0.08), new THREE.MeshBasicMaterial({ color: 0xffffff }), count) : null;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const { w, h } = this.ruleset.arena;
    const base = new THREE.Color(this.theme.wall).multiplyScalar(1.4);
    const alt = new THREE.Color(this.theme.accent).multiplyScalar(1.4);
    this.stripPhase = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + range(rng, -0.08, 0.08);
      const rad = Math.max(w, h) * range(rng, 0.85, 1.15);
      const height = range(rng, 2.5, 9) * detail + 1;
      m4.makeScale(1, height, 1);
      m4.setPosition(Math.cos(a) * rad, height / 2 - 0.5, Math.sin(a) * rad);
      inst.setMatrixAt(i, m4);
      if (strips) {
        // Light strip on the pillar face that looks at the arena.
        const inward = new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a)).multiplyScalar(0.27);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
        m4.compose(new THREE.Vector3(Math.cos(a) * rad + inward.x, height / 2 - 0.5, Math.sin(a) * rad + inward.z), q, new THREE.Vector3(1, height * 0.92, 1));
        strips.setMatrixAt(i, m4);
        strips.setColorAt(i, i % 3 === 0 ? alt : base);
        this.stripPhase.push({ phase: range(rng, 0, Math.PI * 2), speed: range(rng, 0.6, 1.4), color: (i % 3 === 0 ? alt : base).clone() });
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.layers.set(LAYER_ENV);
    inst.castShadow = false;
    this.scene.add(inst);
    if (strips) {
      strips.instanceMatrix.needsUpdate = true;
      strips.layers.set(LAYER_ENV);
      this.scene.add(strips);
      this.strips = strips;
    } else {
      this.strips = null;
    }
  }

  _buildMotes() {
    // Drifting dust motes in the arena light (animated background only).
    this.motes = null;
    if (this.q.background !== 'animated') return;
    const n = { low: 60, medium: 140, high: 240 }[this.q.particles] || 140;
    const rng = createRng(0x307e5 ^ (this.theme.accent & 0xffff));
    const pos = new Float32Array(n * 3);
    const { w, h } = this.ruleset.arena;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = range(rng, -w * 0.9, w * 0.9);
      pos[i * 3 + 1] = range(rng, 0.2, 7);
      pos[i * 3 + 2] = range(rng, -h * 0.8, h * 0.8);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      color: new THREE.Color(this.theme.wall).lerp(this._white, 0.4),
      size: 0.07,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.layers.set(LAYER_FX);
    pts.raycast = () => {};
    this.scene.add(pts);
    this.motes = { pts, pos, n, bounds: [w * 0.9, 7, h * 0.8] };
  }

  // ------------------------------------------------------------------ settings

  setReducedMotion(on) {
    this.reducedMotion = on;
    if (this.trail) this.trail.enabled = this.trailsEnabled && !on;
    if (this.fx) this.fx.budgetScale = on ? 0.35 : 1;
    this._dirty = true;
  }

  setView(name) {
    if (name in CAMERA_VIEWS) this._viewName = name; // transition is sprung, interruptible
  }

  // Sizing happens in render(); this only refreshes the projection.
  resize() {
    if (!this.renderer || !this.camera) return;
    const w = this.canvas.clientWidth || 1;
    const hgt = this.canvas.clientHeight || 1;
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
    this._dirty = true;
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
    this._fitFog(t.pos.distanceTo(t.look));
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
    this._fitFog(this._camPos.distanceTo(this._camLook));
  }

  // Fog follows the framing distance so a far portrait camera does not wash
  // the arena's neon into the fog colour.
  _fitFog(dist) {
    if (!this.scene?.fog) return;
    this.scene.fog.near = dist * 0.9 + 8;
    this.scene.fog.far = dist * 2 + 60;
  }

  kick(amount) {
    if (!this.reducedMotion) this._shake = Math.min(0.35, this._shake + amount);
  }

  // ------------------------------------------------------------------ per-frame

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
      this._setEdge(side, isServer);
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

    this._decorate(dt);
    this.fx?.update(this.reducedMotion ? dt * 0.6 : dt);
    this._springCamera(Math.min(dt, 0.05));
  }

  _setEdge(side, highlight) {
    const mat = this.paddleMeshes[side].children[1].material;
    if (highlight) {
      mat.color.copy(this._white);
      if (this.detailed) mat.color.multiplyScalar(NEON_HDR);
    } else {
      mat.color.copy(this.edgeColors[side]);
    }
  }

  // Grounding blobs, goal pulses and ambient background motion.
  _decorate(dt) {
    if (this.blobs.length && this.blobs[0].visible) {
      this.blobs[0].position.set(this.paddleMeshes[0].position.x, 0.015, this.paddleMeshes[0].position.z);
      this.blobs[1].position.set(this.paddleMeshes[1].position.x, 0.015, this.paddleMeshes[1].position.z);
      this.blobs[0].scale.set(this.ruleset.paddleWidth * 1.3, 1.4, 1);
      this.blobs[1].scale.set(this.ruleset.paddleWidth * 1.3, 1.4, 1);
      this.blobs[2].position.set(this.ballMesh.position.x, 0.015, this.ballMesh.position.z);
    }
    // Goal-line pulse decay.
    for (const g of this.goalMats) {
      if (g.pulse > 0.01) {
        g.pulse *= Math.exp(-3.5 * dt);
        g.mat.opacity = 0.85 + g.pulse * 0.15;
        g.mat.color.copy(g.base).lerp(this._white, g.pulse);
      }
    }
    if (!this._animated) return;
    this._elapsed += dt;
    const t = this._elapsed;
    if (this.strips) {
      // Slow light shimmer along the surround pillars.
      for (let i = 0; i < this.stripPhase.length; i++) {
        const s = this.stripPhase[i];
        const k = 0.55 + 0.45 * Math.sin(t * s.speed + s.phase);
        this.strips.setColorAt(i, this._tmpColor.copy(s.color).multiplyScalar(k));
      }
      this.strips.instanceColor.needsUpdate = true;
    }
    if (this.motes) {
      const { pos, n, bounds } = this.motes;
      for (let i = 0; i < n; i++) {
        const k = i * 3;
        pos[k + 1] += dt * (0.12 + (i % 7) * 0.03);
        pos[k] += Math.sin(t * 0.3 + i) * dt * 0.05;
        if (pos[k + 1] > bounds[1]) pos[k + 1] = 0.2;
      }
      this.motes.pts.geometry.attributes.position.needsUpdate = true;
    }
    if (this._gridMesh && this.detailed) this._gridMesh.material.opacity = 0.44 + 0.08 * Math.sin(t * 1.3);
  }

  /** Menu backdrop animation: a cosmetic rally and a slow camera orbit. */
  idle(dt) {
    if (!this.scene || !this._attract || this._contextLost) return;
    const moving = this._animated;
    if (moving) this._idleT += dt;
    const t = this._idleT + 1.7;
    const { w, h } = this.ruleset.arena;
    const zA = h / 2 - 0.9;
    // Ball: triangle wave between the paddles, sinusoidal sideways drift.
    const u = (t * 0.45) % 2;
    const along = u < 1 ? u : 2 - u;
    const bz = -zA + 0.8 + along * (2 * zA - 1.6);
    const bx = Math.sin(t * 1.1) * w * 0.33;
    this.ballMesh.position.set(bx, 0.42, bz);
    this._ballCore.material.emissiveIntensity = 1.6;
    this.paddleMeshes[0].position.set(THREE.MathUtils.clamp(bx * 0.9, -w / 2 + 2, w / 2 - 2), 0, zA);
    this.paddleMeshes[1].position.set(THREE.MathUtils.clamp(bx * 0.85, -w / 2 + 2, w / 2 - 2), 0, -zA);
    this._setEdge(0, false);
    this._setEdge(1, false);
    if (moving && this.trail?.enabled) this.trail.push(bx, 0.42, bz);
    this._decorate(dt);
    this.fx?.update(dt);
    // Orbit: slow, low-amplitude, frozen under reduced motion / static background.
    const a = 0.55 + t * 0.06;
    const r = Math.max(w, h) * 1.35;
    this.camera.position.set(Math.sin(a) * r, h * 0.62, Math.cos(a) * r);
    this.camera.lookAt(0, 0, 0);
    this._fitFog(this.camera.position.length());
    if (moving) this._dirty = true;
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
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    // A still menu backdrop (static background / reduced motion) is drawn
    // once and then left alone until something changes.
    const still = this._attract && !this._animated;
    if (still && !this._dirty && w === this.size[0] && h === this.size[1]) return;
    const rescale = still ? false : this._adapt(dt * 1000);
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale;
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio || rescale) {
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this.reflector) {
        const rt = this.reflector.getRenderTarget();
        rt.setSize(...reflectionSize(w, h, ratio));
      }
    }
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) {
      try {
        this.composer.render(dt);
      } catch {
        this._postFailed();
        this.renderer.render(this.scene, this.camera);
      }
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    this._dirty = false;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post && !this.postFailed ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio, this._buildId].join('|') : 'none';
  }

  _postFailed() {
    this.postFailed = true;
    this.composer?.dispose();
    this.composer = null;
    this.postKey = null;
  }

  _buildPost(w, h) {
    const g = this.q;
    this.composer?.dispose();
    this.composer = null;
    if (!g.post || this.postFailed) return;
    try {
      const pw = Math.max(1, Math.round(w * this.pixelRatio));
      const ph = Math.max(1, Math.round(h * this.pixelRatio));
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType,
        samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only HDR neon strips, the ball and highlights bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.62 * (this.theme?.bloom ?? 1), 0.5, 0.88));
      }
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      composer.addPass(new OutputPass());
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly if the chain
      // cannot be built (the Graphics panel says so).
      this._postFailed();
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow,
  // back up when fast (never touches the simulation rate).
  _adapt(ms) {
    const f = this._frames;
    f.push(ms);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = avg > 0 ? 1000 / avg : 0;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
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
    this.reflector?.getRenderTarget().dispose();
    this.composer?.dispose();
    this._envTex?.dispose();
    this.renderer?.dispose();
  }
}

// ------------------------------------------------------------------ helpers

function readGpu(renderer) {
  try {
    const gl = renderer.getContext();
    let gpu = gl.getParameter(gl.RENDERER);
    // Chromium masks RENDERER; the unmasked string comes from the extension.
    if (!gpu || /^webkit|^mozilla/i.test(gpu)) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    }
    return String(gpu || '');
  } catch {
    return '';
  }
}

// Mirror target at CSS-pixel resolution (thin neon lines alias into dots at
// half resolution), capped so large displays stay affordable.
function reflectionSize(w, h, ratio) {
  const k = Math.min(1, 1600 / Math.max(w * ratio, h * ratio, 1));
  return [Math.max(128, Math.round(w * ratio * k)), Math.max(128, Math.round(h * ratio * k))];
}

function isTouchOnly() {
  try {
    return !!(window.matchMedia?.('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches);
  } catch {
    return false;
  }
}

// Brushed panel tiles: seams + seeded speckle. Red/green channels hold the
// albedo variation; the same texture drives roughness (G) so seams read glossy.
function floorTexture(theme) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const rng = createRng(0xf100 ^ (theme.floor & 0xffff));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const seam = x % 128 < 3 || y % 128 < 3;
      const n = next(rng) * 0.12 + Math.sin((x + y * 0.35) * 0.4) * 0.02;
      const v = seam ? 0.35 : 0.78 + n;
      const r = seam ? 0.45 : 0.72 + n * 1.5;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(255 * Math.min(1, v));
      img.data[i + 1] = Math.round(255 * Math.min(1, r)); // roughness channel
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function blobTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

function disposeObject(obj) {
  if (obj.geometry) obj.geometry.dispose();
  if (obj.material) {
    for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
      for (const v of Object.values(m)) {
        if (v && v.isTexture && !v.isRenderTargetTexture) v.dispose();
      }
      m.dispose();
    }
  }
}

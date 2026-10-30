// The neon arena on starhermit:scene, as the browser build's
// js/render/scene.js and js/render/vfx.js drew it with three.js r160: the
// floor (plain, or on the detailed look the seeded brushed-panel floor running
// out into the fog, over a planar mirror where floor reflections are on), the
// grid as one line set, the centre line, the rails (bevelled and clear-coated
// with a neon tube on top on the detailed look), the two goal lines that
// pulse on a goal, the bumpers (core + neon ring) and blockers (bevelled,
// moving from the rules' tick), the paddles (clear-coated body, neon edge
// that turns white on the server, a cube or diamond marker reinforcing the
// colour), the ball with its point light and its glow following the ball's
// speed, the ring of instanced surround pillars with shimmering light strips,
// the drifting dust motes, the soft contact blobs (detailed look without
// shadow maps), the pooled spark bursts and the ball's trail; one key light
// with a fitted shadow, a hemisphere fill and an accent ambient; the authored
// camera views (broadcast, behind) on a critically damped spring with
// event-tiered shake, and the menu backdrop (the arena with a cosmetic rally
// and a slow orbit; still under reduced motion or a static background).
//
// From three.js r160 (engine.minor 26+): light intensities, normalBias and
// the shadow box fitted around the arena as the page set them; the post chain (GTAOPass, UnrealBloomPass threshold 0.88, the linear
// GradeShader, FXAA / SMAA / MSAA) is renderer.ao / bloom / grade /
// antialias; the Reflector is a render target drawn each frame from the
// mirrored camera and shown by a small WGSL material; the floor's per-pixel canvas is baked
// (tools/bake-floor.mjs); dead sparks are hidden (the browser build left them
// standing where they died, since three's PointsMaterial ignored its size
// attribute). Cosmetic randomness never touches the rules' stream.
import {
  ACESFilmicToneMapping, AdditiveBlending, AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color,
  CylinderGeometry, DirectionalLight, DynamicDrawUsage, Fog, Group, HemisphereLight, InstancedMesh, Line, LineBasicMaterial,
  LineSegments, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, OctahedronGeometry, OrthographicCamera,
  PerspectiveCamera, PlaneGeometry, PMREMGenerator, PointLight, Points, PointsMaterial, Quaternion, Raycaster, RenderTarget,
  RepeatWrapping, RoomEnvironment, RoundedBoxGeometry, ShaderMaterial, SphereGeometry, SRGBColorSpace, TextureLoader, TorusGeometry,
  Vector2, Vector3, renderer, scene, type BufferGeometry as Geo, type Material, type Object3D, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { Rng, Rules, Themes, type Obstacle, type Ruleset, type RulesEvent, type State, type Theme } from "./game.ts";
import { MOTE_MAX, SPARK_MAX, type Look } from "./quality.ts";

const PI = Math.PI;
// Authored camera framing constants (scene.js CAMERA_VIEWS).
export const CAMERA_VIEWS: Record<string, { dir: [number, number, number]; lookAhead: number; margin: number; fov: number }> = {
  broadcast: { dir: [0, 0.58, 0.8], lookAhead: 0.1, margin: 1.22, fov: 38 },
  behind: { dir: [0, 0.34, 0.62], lookAhead: -0.06, margin: 1.3, fov: 42 },
  orbit: { dir: [0.6, 0.5, 0.62], lookAhead: 0, margin: 1.3, fov: 38 },
};
const SHAKE_BY_EVENT: Record<string, number> = { wall: 0.02, paddle: 0.05, bumper: 0.07, goal: 0.2, "match-end": 0.3 };
const NEON_HDR = 2.4;
const ENV_INTENSITY = 0.45;
const TRAIL_POINTS = 36;

renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
const camera = new PerspectiveCamera(38, 16 / 9, 0.1, 320);
renderer.camera = camera;

// -- textures -----------------------------------------------------------------------------------
const loader = new TextureLoader();
const floorTex = new Map<string, Texture>();
function floorTexture(themeId: string, size: number): Texture {
  const key = `${themeId}-${size}`;
  let t = floorTex.get(key);
  if (!t) {
    t = loader.load(`assets/textures/floor-${key}.png`, undefined, undefined, (e: unknown) => console.warn(`floor ${key}: ${e instanceof Error ? e.message : String(e)}`));
    t.colorSpace = SRGBColorSpace;
    t.wrapS = t.wrapT = RepeatWrapping;
    t.anisotropy = 4;
    floorTex.set(key, t);
  }
  return t;
}
let blobTex: Texture | null = null;
function blobTexture(): Texture {
  if (!blobTex) {
    const cv = new OffscreenCanvas(64, 64);
    const x = cv.getContext("2d");
    const g = x.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, 64, 64);
    blobTex = new CanvasTexture(cv);
  }
  return blobTex;
}
let envTex: Texture | null = null;
function environment(): Texture | null {
  if (!envTex) {
    try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return envTex;
}

// -- the floor mirror (three.js Reflector) --------------------------------------------------------
const MIRROR_FRAG = /* wgsl */ `
fn overlay(b: f32, c: f32) -> f32 { return select(1.0 - 2.0 * (1.0 - b) * (1.0 - c), 2.0 * b * c, b < 0.5); }
fn fragment(f: Fragment) -> vec4f {
  let p = uniforms.uTex * vec4f(f.world, 1.0);
  let ndc = p.xy / p.w;
  let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let base = srgb_to_linear(textureSampleLevel(tDiffuse, tDiffuse_sampler, uv, 0.0).rgb);
  let c = uniforms.uColor;
  return vec4f(overlay(base.r, c.r), overlay(base.g, c.g), overlay(base.b, c.b), 1.0);
}`;
interface Mirror { target: RenderTarget; mesh: Mesh; mat: ShaderMaterial; cam: PerspectiveCamera; res: number }

// -- the world ----------------------------------------------------------------------------------
interface World {
  root: Group; ruleset: Ruleset; theme: Theme; detailed: boolean;
  floor: Mesh; grid: LineSegments; gridMat: LineBasicMaterial; mirror: Mirror | null;
  goalMats: { mat: MeshBasicMaterial; pulse: number; base: Color }[];
  obstacles: { def: Obstacle; mesh: Object3D }[];
  paddles: Group[]; edges: MeshBasicMaterial[]; edgeColors: Color[];
  ball: Group; ballCore: Mesh; ballMat: MeshStandardMaterial | MeshLambertMaterial | MeshPhysicalMaterial; ballLight: PointLight;
  blobs: Mesh[]; strips: InstancedMesh | null; stripPhase: { phase: number; speed: number; color: Color }[];
  motes: { pts: Points; pos: Float32Array; n: number; top: number } | null;
  key: DirectionalLight;
}
let world: World | null = null;
let look: Look | null = null;
let lastBuild: { ruleset: Ruleset; themeId: string; opts: BuildOptions } | null = null;
let reducedMotion = false;
let trailsEnabled = true;
let viewName = "broadcast";
let side = 0;
let attract = false;
let elapsed = 0;
let idleT = 0;
let shake = 0;
let shakeSeed = 0;
const camPos = new Vector3(), camVel = new Vector3(), camLook = new Vector3(), camLookVel = new Vector3();
const white = new Color(0xffffff);
const tmpColor = new Color();
let viewW = 16, viewH = 9;

export interface BuildOptions { side?: number; cvd?: string; view?: string; attract?: boolean }

function disposeTree(o: Object3D): void {
  o.traverse((n) => {
    const m = n as unknown as { geometry?: Geo; material?: Material | Material[] };
    if (m.geometry) m.geometry.dispose();
    if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose();
  });
}

type MatParams = {
  color?: number | Color; emissive?: number | Color; emissiveIntensity?: number; roughness?: number; metalness?: number;
  clearcoat?: number; clearcoatRoughness?: number; transparent?: boolean; opacity?: number;
};
/** scene.js _std: Lambert on Low (emissive kept), Standard on Balanced, clear-coated Physical with reflections on the detailed High / Ultra look. */
function std(p: MatParams, detailed: boolean): MeshStandardMaterial | MeshLambertMaterial | MeshPhysicalMaterial {
  const tier = look!.budget.material;
  const { roughness, metalness, clearcoat, clearcoatRoughness, ...base } = p;
  if (tier === "lambert") return new MeshLambertMaterial(base);
  const env = detailed ? environment() : null;
  if (detailed && tier === "physical") return new MeshPhysicalMaterial({ ...base, roughness, metalness, clearcoat, clearcoatRoughness, envMap: env, envMapIntensity: ENV_INTENSITY });
  // three r160 Standard materials took scene.environment at their default envMapIntensity 1
  return new MeshStandardMaterial({ ...base, roughness, metalness, envMap: env, envMapIntensity: 1 });
}
/** scene.js _neon: HDR neon (× 2.4 on the detailed look, for bloom). */
function neon(color: number, detailed: boolean, opacity = 1, hdr = NEON_HDR): MeshBasicMaterial {
  const c = new Color(color);
  if (detailed) c.multiplyScalar(hdr);
  return new MeshBasicMaterial({ color: c, transparent: opacity < 1, opacity, fog: true });
}

/** scene.js _fitShadow: the key's shadow box fitted tightly around the play area (arena + rails + actor height). */
function fitShadow(key: DirectionalLight, w: number, h: number): void {
  const view = new Matrix4().lookAt(key.position, key.target.position, new Vector3(0, 1, 0));
  view.setPosition(key.position);
  const inv = view.clone().invert();
  const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity), p = new Vector3();
  for (const x of [-w / 2 - 0.6, w / 2 + 0.6]) for (const z of [-h / 2 - 1.2, h / 2 + 1.2]) for (const y of [0, 1.2]) {
    p.set(x, y, z).applyMatrix4(inv);
    min.min(p);
    max.max(p);
  }
  const cam = key.shadow.camera as OrthographicCamera;
  Object.assign(cam, { left: min.x, right: max.x, bottom: min.y, top: max.y, near: Math.max(0.5, -max.z - 1), far: -min.z + 1 });
  cam.updateProjectionMatrix();
}

function buildWorld(ruleset: Ruleset, themeId: string, opts: BuildOptions): World {
  const L = look!;
  const base = Themes.getTheme(themeId);
  const pal = Themes.CVD_PALETTES[opts.cvd ?? "none"] ?? null;
  const theme: Theme = { ...base, ...(pal ? { paddleA: pal.paddleA, paddleB: pal.paddleB, ball: pal.ball, accent: pal.accent } : {}) };
  const detailed = L.detailed;
  const root = new Group();
  const { w, h } = ruleset.arena;
  scene.background = new Color(theme.fog);
  scene.fog = new Fog(theme.fog, 40, 110);
  // r160 scaled scene.environment by each material's envMapIntensity; at minor 20 that holds only for a material's own
  // envMap, so the detailed look gives its standard materials the room environment themselves (envOf).
  scene.environment = null;
  const env = detailed ? environment() : null;

  // lights: one dominant key, a hemisphere fill and a soft accent ambient
  root.add(new HemisphereLight(theme.wall, theme.floor, detailed ? 0.4 : 0.55));
  const key = new DirectionalLight(0xffffff, 1.35);
  key.position.set(7, 22, 9);
  key.target.position.set(0, 0, 0);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  root.add(key, key.target);
  fitShadow(key, w, h);
  root.add(new AmbientLight(theme.accent, 0.14));

  // floor
  const fw = detailed ? Math.max(w, h) * 5 : w + 8;
  const fh = detailed ? Math.max(w, h) * 5 : h + 10;
  let floorMat: MeshStandardMaterial | MeshLambertMaterial | MeshPhysicalMaterial;
  let mirror: Mirror | null = null;
  if (detailed) {
    const tex = floorTexture(theme.id, L.budget.texture >= 512 ? 512 : 256);
    tex.repeat.set(fw / 4, fh / 4);
    const reflect = L.reflections;
    floorMat = new MeshStandardMaterial({
      color: theme.floor, map: tex, roughnessMap: tex, roughness: 0.9, metalness: 0.35, envMap: env, envMapIntensity: ENV_INTENSITY * 0.35,
      transparent: reflect, opacity: reflect ? 0.64 : 1,
    });
    if (reflect) {
      try { mirror = makeMirror(fw, fh, L.budget.reflectRes); root.add(mirror.mesh); }
      catch (e) { console.warn(`mirror: ${e instanceof Error ? e.message : String(e)}`); mirror = null; }
    }
  } else floorMat = std({ color: theme.floor, roughness: 0.85, metalness: 0.25 }, false);
  floorMat.polygonOffset = true;
  floorMat.polygonOffsetFactor = 2;
  floorMat.polygonOffsetUnits = 2;
  if (floorMat.transparent) floorMat.depthWrite = false;
  const floor = new Mesh(new PlaneGeometry(fw, fh), floorMat);
  floor.renderOrder = -1;
  floor.rotation.x = -PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  // grid: one line set
  const pts: number[] = [];
  const gx = w / 2, gz = h / 2;
  for (let x = -Math.ceil(gx); x <= gx; x += 1) pts.push(x, 0.01, -gz - 1, x, 0.01, gz + 1);
  for (let z = -Math.ceil(gz); z <= gz; z += 1) pts.push(-gx - 1, 0.01, z, gx + 1, 0.01, z);
  const gridGeo = new BufferGeometry();
  gridGeo.setAttribute("position", new BufferAttribute(new Float32Array(pts), 3));
  const gridMat = new LineBasicMaterial({ color: theme.grid, transparent: true, opacity: detailed ? 0.5 : 0.35 });
  const grid = new LineSegments(gridGeo, gridMat);
  root.add(grid);

  // centre line
  const clMat = neon(theme.wall, detailed, 0.5);
  if (detailed) clMat.color.multiplyScalar(0.3);
  const cl = new Mesh(new BoxGeometry(w, 0.02, 0.08), clMat);
  cl.position.y = 0.02;
  root.add(cl);

  // contact blobs (detailed look without shadow maps)
  const blobs: Mesh[] = [];
  if (detailed) {
    const bt = blobTexture();
    for (let i = 0; i < 3; i++) {
      const s = i === 2 ? 1.4 : 1;
      const blob = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: bt, transparent: true, depthWrite: false, color: 0x000000, opacity: 0.7 }));
      blob.rotation.x = -PI / 2;
      blob.position.y = 0.015;
      blob.scale.set(s, s, 1);
      blob.renderOrder = 1;
      root.add(blob);
      blobs.push(blob);
    }
  }

  // rails
  const railMat = std({
    color: 0x0a0d1a, roughness: 0.4, metalness: 0.7, emissive: theme.wallEmissive, emissiveIntensity: detailed ? 0.35 : 0.9,
    clearcoat: 0.6, clearcoatRoughness: 0.25,
  }, detailed);
  for (const s of [-1, 1]) {
    const geo = detailed ? new RoundedBoxGeometry(0.3, 0.5, h + 0.6, L.budget.roundSeg, 0.08) : new BoxGeometry(0.3, 0.5, h + 0.6);
    const rail = new Mesh(geo, railMat);
    rail.position.set(s * (w / 2 + 0.15), 0.25, 0);
    rail.castShadow = true;
    rail.receiveShadow = detailed;
    root.add(rail);
    if (detailed) {
      const tube = new Mesh(new BoxGeometry(0.07, 0.07, h + 0.5), neon(theme.wall, true));
      tube.position.set(s * (w / 2 + 0.15 - s * 0.1), 0.52, 0);
      root.add(tube);
    }
  }

  // goal lines
  const goalMats: World["goalMats"] = [];
  for (const s of [0, 1]) {
    const color = s === 0 ? theme.paddleA : theme.paddleB;
    const b = new Color(color);
    if (detailed) b.multiplyScalar(1.6);
    const mat = new MeshBasicMaterial({ color: b.clone(), transparent: true, opacity: 0.85 });
    const line = new Mesh(new BoxGeometry(w, 0.06, 0.18), mat);
    line.position.set(0, 0.04, (s === 0 ? 1 : -1) * (h / 2 + 0.35));
    root.add(line);
    goalMats.push({ mat, pulse: 0, base: b });
  }

  // obstacles
  const obstacles: World["obstacles"] = [];
  for (const o of ruleset.obstacles ?? []) {
    let mesh: Object3D;
    if (o.type === "bumper") {
      const r = o.r ?? 1;
      const g = new Group();
      const core = new Mesh(new CylinderGeometry(r * 0.72, r * 0.85, 0.7, 24),
        std({ color: 0x101425, roughness: 0.35, metalness: 0.8, emissive: theme.obstacle, emissiveIntensity: 0.35, clearcoat: 1, clearcoatRoughness: 0.2 }, detailed));
      core.position.y = 0.35;
      core.castShadow = true;
      const ring = new Mesh(new TorusGeometry(r, 0.06, 10, 40), neon(theme.obstacle, detailed));
      ring.rotation.x = PI / 2;
      ring.position.y = 0.72;
      g.add(core, ring);
      mesh = g;
    } else {
      const bw = (o.hw || 1) * 2, bd = (o.hh || 0.5) * 2;
      const m = new Mesh(detailed ? new RoundedBoxGeometry(bw, 0.55, bd, L.budget.roundSeg, 0.08) : new BoxGeometry(bw, 0.55, bd),
        std({ color: 0x101425, roughness: 0.4, metalness: 0.7, emissive: theme.obstacle, emissiveIntensity: 0.55, clearcoat: 0.8, clearcoatRoughness: 0.2 }, detailed));
      m.position.y = 0.3;
      m.castShadow = true;
      mesh = m;
    }
    mesh.position.x = o.x;
    mesh.position.z = -o.y;
    root.add(mesh);
    obstacles.push({ def: o, mesh });
  }

  // paddles: body, neon edge, shape marker (side 0 cube, side 1 diamond)
  const edges: MeshBasicMaterial[] = [];
  const edgeColors: Color[] = [];
  const paddles = [0, 1].map((sd) => {
    const color = sd === 0 ? theme.paddleA : theme.paddleB;
    const g = new Group();
    const body = new Mesh(
      detailed ? new RoundedBoxGeometry(ruleset.paddleWidth, 0.42, 0.72, L.budget.roundSeg + 1, 0.12) : new BoxGeometry(ruleset.paddleWidth, 0.42, 0.72),
      std({ color: 0x0c1020, roughness: 0.3, metalness: 0.75, emissive: color, emissiveIntensity: 0.55, clearcoat: 1, clearcoatRoughness: 0.12 }, detailed),
    );
    body.position.y = 0.32;
    body.castShadow = true;
    const edgeMat = neon(color, detailed, 1, 1.5);
    const edge = new Mesh(new BoxGeometry(ruleset.paddleWidth + 0.06, 0.08, 0.78), edgeMat);
    edge.position.y = 0.56;
    edges.push(edgeMat);
    edgeColors.push(edgeMat.color.clone());
    const marker = sd === 0
      ? new Mesh(new BoxGeometry(0.34, 0.1, 0.34), new MeshBasicMaterial({ color: 0xffffff }))
      : new Mesh(new OctahedronGeometry(0.2), new MeshBasicMaterial({ color: 0xffffff }));
    marker.position.y = 0.66;
    g.add(body, edge, marker);
    root.add(g);
    return g;
  });

  // ball + its light
  const ball = new Group();
  const ballMat = std({ color: 0x101018, roughness: 0.25, metalness: 0.4, emissive: theme.ball, emissiveIntensity: 1.6, clearcoat: 1, clearcoatRoughness: 0.05 }, detailed);
  const ballCore = new Mesh(new SphereGeometry(ruleset.ballRadius, L.budget.ballSeg[0], L.budget.ballSeg[1]), ballMat);
  ballCore.castShadow = true;
  ball.add(ballCore);
  const ballLight = new PointLight(theme.ball, 12, 12, 2);
  ballLight.position.y = 0.4;
  ball.add(ballLight);
  root.add(ball);

  // surround: a ring of instanced pillars (seeded from the theme), light strips on the detailed look
  const detail = detailed ? 1 : 0.35;
  const count = Math.max(6, Math.round(L.budget.pillars * detail));
  const rng = Rng.createRng(0xdec0 ^ String(theme.id).length ^ (theme.wall & 0xffff));
  const pillarMat = std({ color: 0x0a0e1c, roughness: 0.6, metalness: 0.5, emissive: theme.wall, emissiveIntensity: detailed ? 0.08 : 0.22 }, detailed);
  const inst = new InstancedMesh(new BoxGeometry(0.5, 1, 0.5), pillarMat, count);
  const strips = detailed ? new InstancedMesh(new BoxGeometry(0.08, 1, 0.08), new MeshBasicMaterial({ color: 0xffffff }), count) : null;
  const m4 = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const sBase = new Color(theme.wall).multiplyScalar(1.4);
  const sAlt = new Color(theme.accent).multiplyScalar(1.4);
  const stripPhase: World["stripPhase"] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * PI * 2 + Rng.range(rng, -0.08, 0.08);
    const rad = Math.max(w, h) * Rng.range(rng, 0.85, 1.15);
    const height = Rng.range(rng, 2.5, 9) * detail + 1;
    m4.makeScale(1, height, 1);
    m4.setPosition(Math.cos(a) * rad, height / 2 - 0.5, Math.sin(a) * rad);
    inst.setMatrixAt(i, m4);
    if (strips) {
      const inward = new Vector3(-Math.cos(a), 0, -Math.sin(a)).multiplyScalar(0.27);
      q.setFromAxisAngle(up, -a);
      m4.compose(new Vector3(Math.cos(a) * rad + inward.x, height / 2 - 0.5, Math.sin(a) * rad + inward.z), q, new Vector3(1, height * 0.92, 1));
      strips.setMatrixAt(i, m4);
      const c = i % 3 === 0 ? sAlt : sBase;
      strips.setColorAt(i, c);
      stripPhase.push({ phase: Rng.range(rng, 0, PI * 2), speed: Rng.range(rng, 0.6, 1.4), color: c.clone() });
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  root.add(inst);
  if (strips) { strips.instanceMatrix.needsUpdate = true; root.add(strips); }

  // dust motes (animated background)
  let motes: World["motes"] = null;
  if (L.animated && L.budget.motes > 0) {
    const n = Math.min(MOTE_MAX, L.budget.motes);
    const mr = Rng.createRng(0x307e5 ^ (theme.accent & 0xffff));
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = Rng.range(mr, -w * 0.9, w * 0.9);
      pos[i * 3 + 1] = Rng.range(mr, 0.2, 7);
      pos[i * 3 + 2] = Rng.range(mr, -h * 0.8, h * 0.8);
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage));
    const mat = new PointsMaterial({
      color: new Color(theme.wall).lerp(white, 0.4), size: 0.07, transparent: true, opacity: 0.45, blending: AdditiveBlending, depthWrite: false,
    });
    const p = new Points(geo, mat);
    p.frustumCulled = false;
    root.add(p);
    motes = { pts: p, pos, n, top: 7 };
  }

  return {
    root, ruleset, theme, detailed, floor, grid, gridMat, mirror, goalMats, obstacles, paddles, edges, edgeColors, ball, ballCore, ballMat,
    ballLight, blobs, strips, stripPhase, motes, key,
  };
}

function makeMirror(fw: number, fh: number, res: number): Mirror {
  const target = new RenderTarget(256, 256);
  const mat = new ShaderMaterial({
    uniforms: { tDiffuse: { value: target.texture }, uTex: { value: new Matrix4() }, uColor: { value: new Color(0x8a8f9a) } },
    fragmentShader: MIRROR_FRAG,
  });
  (mat as unknown as { toneMapped: boolean }).toneMapped = true;
  const mesh = new Mesh(new PlaneGeometry(fw, fh), mat);
  mesh.rotation.x = -PI / 2;
  mesh.position.y = -0.02;
  return { target, mesh, mat, cam: new PerspectiveCamera(38, 1, 0.1, 320), res };
}
const mirrorLook = new Vector3();
const projView = new Matrix4();
/** Reflector.onBeforeRender: the scene from the camera mirrored in the floor, with the floor, grid and mirror hidden. */
function drawMirror(w: World): void {
  const m = w.mirror;
  if (!m) return;
  const tw = Math.max(128, Math.min(1600, Math.round(viewW * m.res)));
  const th = Math.max(128, Math.min(1600, Math.round(viewH * m.res)));
  if (m.target.width !== tw || m.target.height !== th) m.target.setSize(tw, th);
  camera.updateMatrixWorld();
  m.cam.fov = camera.fov;
  m.cam.aspect = camera.aspect;
  m.cam.near = camera.near;
  m.cam.far = camera.far;
  m.cam.position.set(camera.position.x, -camera.position.y, camera.position.z);
  camera.getWorldDirection(mirrorLook);
  mirrorLook.y = -mirrorLook.y;
  mirrorLook.add(m.cam.position);
  m.cam.up.set(0, 1, 0);
  m.cam.lookAt(mirrorLook);
  m.cam.updateProjectionMatrix();
  m.cam.updateMatrixWorld();
  projView.multiplyMatrices(m.cam.projectionMatrix, m.cam.matrixWorldInverse);
  (m.mat.uniforms.uTex!.value as Matrix4).copy(projView);
  const hide = [w.floor, w.grid, m.mesh];
  for (const o of hide) o.visible = false;
  try {
    renderer.setRenderTarget(m.target);
    renderer.render(scene, m.cam);
  } catch (e) {
    console.warn(`mirror: ${e instanceof Error ? e.message : String(e)}`);
    w.mirror = null;
    w.root.remove(m.mesh);
  } finally {
    renderer.setRenderTarget(null);
    for (const o of hide) o.visible = true;
  }
}

// -- sparks (vfx.js ParticlePool) and the trail (vfx.js Trail) -------------------------------------
const SP_POS = new Float32Array(SPARK_MAX * 3);
const SP_VEL = new Float32Array(SPARK_MAX * 3);
const SP_COL = new Float32Array(SPARK_MAX * 3);
const SP_LIFE = new Float32Array(SPARK_MAX);
const SP_SPAN = new Float32Array(SPARK_MAX);
let spHead = 0;
let spCap = 100;
let spGravity = -6;
let sparks: Points | null = null;
let sparkGeo: BufferGeometry | null = null;
function buildSparks(cap: number): void {
  if (sparks) { scene.remove(sparks); sparks.geometry.dispose(); sparks.material.dispose(); }
  spCap = Math.max(1, Math.min(SPARK_MAX, cap));
  spHead = 0;
  SP_LIFE.fill(0);
  SP_POS.fill(0);
  for (let i = 1; i < SP_POS.length; i += 3) SP_POS[i] = -50; // dead sparks out of sight
  SP_COL.fill(0);
  sparkGeo = new BufferGeometry();
  sparkGeo.setAttribute("position", new BufferAttribute(SP_POS.subarray(0, spCap * 3), 3).setUsage(DynamicDrawUsage));
  sparkGeo.setAttribute("color", new BufferAttribute(SP_COL.subarray(0, spCap * 3), 3).setUsage(DynamicDrawUsage));
  sparks = new Points(sparkGeo, new PointsMaterial({
    size: 0.22, vertexColors: true, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  sparks.frustumCulled = false;
  scene.add(sparks);
}
const spColor = new Color();
function spawn(x: number, y: number, z: number, o: { count?: number; color?: number; speed?: number; up?: number; life?: number }): void {
  const count = o.count ?? 12;
  const n = Math.min(count, Math.floor(count * (reducedMotion ? 0.35 : 1)));
  if (n <= 0 || !sparks) return;
  spColor.set(o.color ?? 0xffffff);
  const speed = o.speed ?? 6, up = o.up ?? 2, life = o.life ?? 0.6;
  for (let i = 0; i < n; i++) {
    const k = spHead;
    spHead = (spHead + 1) % spCap;
    const a = Math.random() * PI * 2;
    const r = (0.3 + 0.7 * Math.random()) * speed;
    SP_POS[k * 3] = x; SP_POS[k * 3 + 1] = y; SP_POS[k * 3 + 2] = z;
    SP_VEL[k * 3] = Math.cos(a) * r; SP_VEL[k * 3 + 1] = up * (0.4 + Math.random()); SP_VEL[k * 3 + 2] = Math.sin(a) * r;
    SP_COL[k * 3] = spColor.r; SP_COL[k * 3 + 1] = spColor.g; SP_COL[k * 3 + 2] = spColor.b;
    SP_LIFE[k] = SP_SPAN[k] = life * (0.6 + Math.random() * 0.8);
  }
  spGravity = -6;
}
function updateSparks(dt: number): void {
  if (!sparks || !sparkGeo) return;
  let any = false;
  for (let i = 0; i < spCap; i++) {
    if (SP_LIFE[i]! <= 0) continue;
    any = true;
    SP_LIFE[i]! -= dt;
    const k = i * 3;
    if (SP_LIFE[i]! <= 0) { SP_COL[k] = SP_COL[k + 1] = SP_COL[k + 2] = 0; SP_POS[k + 1] = -50; continue; }
    SP_VEL[k + 1]! += spGravity * dt;
    SP_POS[k]! += SP_VEL[k]! * dt;
    SP_POS[k + 1]! += SP_VEL[k + 1]! * dt;
    SP_POS[k + 2]! += SP_VEL[k + 2]! * dt;
    const f = Math.max(0, SP_LIFE[i]! / SP_SPAN[i]!);
    if (0.25 + 0.75 * f < 1) SP_COL[k]! *= 0.995;
  }
  if (any || sparkDirty) {
    sparkGeo.attributes.position!.needsUpdate = true;
    sparkGeo.attributes.color!.needsUpdate = true;
  }
  sparkDirty = any;
}
let sparkDirty = false;

const TR_RING = new Float32Array(TRAIL_POINTS * 3);
const TR_POS = new Float32Array(TRAIL_POINTS * 3);
const TR_COL = new Float32Array(TRAIL_POINTS * 3);
let trHead = 0, trCount = 0;
const trBase = new Color();
const trGeo = new BufferGeometry();
trGeo.setAttribute("position", new BufferAttribute(TR_POS, 3).setUsage(DynamicDrawUsage));
trGeo.setAttribute("color", new BufferAttribute(TR_COL, 3).setUsage(DynamicDrawUsage));
const trail = new Line(trGeo, new LineBasicMaterial({ vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false }));
trail.frustumCulled = false;
scene.add(trail);
function trailEnabled(): boolean { return trailsEnabled && !reducedMotion; }
function trailPush(x: number, y: number, z: number): void {
  TR_RING[trHead * 3] = x; TR_RING[trHead * 3 + 1] = y; TR_RING[trHead * 3 + 2] = z;
  trHead = (trHead + 1) % TRAIL_POINTS;
  if (trCount < TRAIL_POINTS) trCount++;
  trailRebuild();
}
function trailClear(): void { if (trCount) { trCount = 0; trailRebuild(); } }
function trailRebuild(): void {
  const m = trCount, pad = TRAIL_POINTS - m, on = trailEnabled();
  for (let i = 0; i < TRAIL_POINTS; i++) {
    const j = Math.max(0, i - pad);
    const idx = m === 0 ? 0 : (trHead - m + j + TRAIL_POINTS * 2) % TRAIL_POINTS;
    TR_POS[i * 3] = TR_RING[idx * 3]!; TR_POS[i * 3 + 1] = TR_RING[idx * 3 + 1]!; TR_POS[i * 3 + 2] = TR_RING[idx * 3 + 2]!;
    const f = m <= 1 ? 0 : j / (m - 1);
    const a = on && i >= pad ? f * f * 0.85 : 0;
    TR_COL[i * 3] = trBase.r * a; TR_COL[i * 3 + 1] = trBase.g * a; TR_COL[i * 3 + 2] = trBase.b * a;
  }
  trGeo.attributes.position!.needsUpdate = true;
  trGeo.attributes.color!.needsUpdate = true;
}

// -- the look, building and settings ------------------------------------------------------------
function applyShadows(): void {
  const w = world;
  if (!w || !look) return;
  const size = look.shadows;
  renderer.shadowMap.enabled = size > 0;
  w.key.castShadow = size > 0;
  if (size > 0) w.key.shadow.mapSize = size;
  for (const b of w.blobs) b.visible = size === 0 && w.detailed;
}
function applyPost(): void {
  const L = look!;
  renderer.ao = L.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: L.ao === "high" ? 16 : 8, resolution: L.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: L.ao === "high" ? 6 : 4, rings: 2, samples: L.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only HDR neon strips, the ball and highlights bloom.
  // The page's three r160 UnrealBloomPass strength 0.62 × theme squared: minor 29 bloom follows r185 (≈2.9× the light).
  renderer.bloom = L.bloom ? { strength: (0.62 * (world?.theme.bloom ?? 1)) ** 2, radius: 0.5, threshold: 0.88, resolution: L.budget.bloomRes } : null;
  // scene.js GradeShader on linear light: a 0.22 S-curve, saturation 1.12, cool shadows to neutral highlights, the 0.28 vignette.
  renderer.grade = L.grade ? {
    space: "linear", contrast: 0.22, saturation: 1.12, shadows: [0.95, 0.98, 1.06], highlights: [1, 1, 1], split: [0.15, 0.7],
    vignette: { amount: 0.28, inner: 0.38, outer: 0.9, scale: [1.1, 1] },
    levels: [0.985, 0.012], // s * 0.985 + 0.012
    overRange: "keep", // minor 29: mix(c, s + max(c - 1, 0), amount) as the page's grade
  } : null;
  renderer.antialias = L.antialias;
}
/** The look for the frame's graphics level (quality.ts); rebuilds the arena when its shape changes. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const before = look;
  look = next;
  if (!before || before.budget.sparks !== next.budget.sparks) buildSparks(next.budget.sparks);
  if (lastBuild && (!before || JSON.stringify({ ...before, ao: 0, bloom: 0, grade: 0, antialias: 0, shadows: 0 }) !== JSON.stringify({ ...next, ao: 0, bloom: 0, grade: 0, antialias: 0, shadows: 0 }))) {
    build(lastBuild.ruleset, lastBuild.themeId, lastBuild.opts);
  }
  applyPost();
  applyShadows();
}
/** (Re)builds the whole arena for a match (scene.js build): everything derives from the ruleset, theme and look. */
export function build(ruleset: Ruleset, themeId: string, opts: BuildOptions = {}): void {
  lastBuild = { ruleset, themeId, opts };
  if (!look) return;
  if (world) { scene.remove(world.root); disposeTree(world.root); if (world.mirror) world.mirror.target.dispose(); }
  attract = !!opts.attract;
  side = opts.side ?? 0;
  viewName = (opts.view && CAMERA_VIEWS[opts.view]) ? opts.view : "broadcast";
  world = buildWorld(ruleset, themeId, opts);
  scene.add(world.root);
  trBase.set(world.theme.ball);
  trailClear();
  applyPost();
  applyShadows();
  snapCamera();
}
/** The title / menu backdrop: the arena with a cosmetic rally (no rules state). */
export function showAttract(themeId = "neon-district"): void {
  build(Rules.DEFAULT_RULESET, themeId, { attract: true, view: "orbit" });
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; trailRebuild(); }
export function setTrails(on: boolean): void { trailsEnabled = on; trailRebuild(); }
/** Broadcast or behind: the spring moves the camera there (interruptible). */
export function setView(name: string): void { if (CAMERA_VIEWS[name]) viewName = name; }

// -- the camera ----------------------------------------------------------------------------------
function frameTargets(pos: Vector3, lookAt: Vector3): void {
  const w = world!;
  const view = CAMERA_VIEWS[viewName]!;
  const { w: aw, h: ah } = w.ruleset.arena;
  const flip = side === 1 ? -1 : 1;
  const aspect = camera.aspect || 1;
  const vFov = (view.fov * PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const needH = (ah / 2 + 1.5) * view.margin;
  const needW = (aw / 2 + 1.5) * view.margin;
  const dist = Math.max(needH / Math.tan(vFov / 2), needW / Math.tan(hFov / 2));
  pos.set(view.dir[0], view.dir[1], view.dir[2] * flip).normalize().multiplyScalar(dist);
  pos.y = Math.max(pos.y, 2.5);
  lookAt.set(0, 0, view.lookAhead * ah * flip);
}
const tPos = new Vector3(), tLook = new Vector3();
function fitFog(dist: number): void {
  const f = scene.fog as Fog | null;
  if (!f) return;
  f.near = dist * 0.9 + 8;
  f.far = dist * 2 + 60;
}
function setAspect(): void {
  camera.aspect = viewW / Math.max(1, viewH);
  camera.fov = CAMERA_VIEWS[viewName]!.fov;
  camera.updateProjectionMatrix();
}
function snapCamera(): void {
  if (!world) return;
  setAspect();
  frameTargets(tPos, tLook);
  camPos.copy(tPos); camLook.copy(tLook);
  camVel.set(0, 0, 0); camLookVel.set(0, 0, 0);
  camera.position.copy(tPos);
  camera.lookAt(tLook);
  fitFog(tPos.distanceTo(tLook));
}
/** Critically damped spring — interruptible, never cumulative lerp. */
function springCamera(dt: number): void {
  frameTargets(tPos, tLook);
  const omega = 3.2, k = omega * omega, c = 2 * omega;
  for (const [cur, vel, tgt] of [[camPos, camVel, tPos], [camLook, camLookVel, tLook]] as const) {
    for (const axis of ["x", "y", "z"] as const) {
      const a = k * (tgt[axis] - cur[axis]) - c * vel[axis];
      vel[axis] += a * dt;
      cur[axis] += vel[axis] * dt;
    }
  }
  camera.position.copy(camPos);
  if (shake > 0.001 && !reducedMotion) {
    shake *= Math.exp(-5.2 * dt);
    shakeSeed += dt * 37;
    camera.position.x += Math.sin(shakeSeed * 1.3) * shake * 0.12;
    camera.position.y += Math.sin(shakeSeed * 1.7 + 2) * shake * 0.09;
  }
  camera.lookAt(camLook);
  fitFog(camPos.distanceTo(camLook));
}
function kick(amount: number): void { if (!reducedMotion) shake = Math.min(0.35, shake + amount); }

// -- per frame -------------------------------------------------------------------------------------
function setEdge(sd: number, highlight: boolean): void {
  const w = world!;
  const mat = w.edges[sd]!;
  if (highlight) { mat.color.copy(white); if (w.detailed) mat.color.multiplyScalar(NEON_HDR); }
  else mat.color.copy(w.edgeColors[sd]!);
}
function animated(): boolean { return !!look?.animated && !reducedMotion; }
/** Grounding blobs, goal pulses and the animated background (scene.js _decorate). */
function decorate(dt: number): void {
  const w = world!;
  if (w.blobs.length && w.blobs[0]!.visible) {
    for (const sd of [0, 1]) {
      const p = w.paddles[sd]!.position;
      w.blobs[sd]!.position.set(p.x, 0.015, p.z);
      w.blobs[sd]!.scale.set(w.ruleset.paddleWidth * 1.3, 1.4, 1);
    }
    w.blobs[2]!.position.set(w.ball.position.x, 0.015, w.ball.position.z);
  }
  for (const g of w.goalMats) {
    if (g.pulse > 0.01) {
      g.pulse *= Math.exp(-3.5 * dt);
      g.mat.opacity = 0.85 + g.pulse * 0.15;
      g.mat.color.copy(g.base).lerp(white, g.pulse);
    }
  }
  if (!animated()) return;
  elapsed += dt;
  const t = elapsed;
  if (w.strips) {
    for (let i = 0; i < w.stripPhase.length; i++) {
      const s = w.stripPhase[i]!;
      w.strips.setColorAt(i, tmpColor.copy(s.color).multiplyScalar(0.55 + 0.45 * Math.sin(t * s.speed + s.phase)));
    }
    if (w.strips.instanceColor) w.strips.instanceColor.needsUpdate = true;
  }
  if (w.motes) {
    const { pos, n, top } = w.motes;
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      pos[k + 1]! += dt * (0.12 + (i % 7) * 0.03);
      pos[k]! += Math.sin(t * 0.3 + i) * dt * 0.05;
      if (pos[k + 1]! > top) pos[k + 1] = 0.2;
    }
    w.motes.pts.geometry.attributes.position!.needsUpdate = true;
  }
  if (w.detailed) w.gridMat.opacity = 0.44 + 0.08 * Math.sin(t * 1.3);
}

/** The window's drawable size (physical pixels): the camera's aspect and the mirror's size. */
export function setViewport(width: number, height: number): void {
  if (width === viewW && height === viewH) return;
  viewW = Math.max(1, width);
  viewH = Math.max(1, height);
  setAspect();
}

/** A match frame: interpolated ball, paddles and blockers (scene.js update). */
export function update(prev: State, cur: State, alpha: number, dt: number): void {
  const w = world;
  if (!w || attract) return;
  setAspect();
  const lerp = (a: number, b: number): number => a + (b - a) * alpha;
  const bx = lerp(prev.ball.x, cur.ball.x), by = lerp(prev.ball.y, cur.ball.y);
  w.ball.position.set(bx, 0.42, -by);
  const spd = cur.ball.speed / cur.ruleset.maxBallSpeed;
  w.ballMat.emissiveIntensity = 1.2 + spd * 1.4;
  w.ballLight.intensity = 8 + spd * 14;
  if (cur.phase === "rally") trailPush(bx, 0.42, -by);
  else if (cur.phase === "serve") trailClear();
  for (let sd = 0; sd < 2; sd++) {
    const px = lerp(prev.paddles[sd]!.x, cur.paddles[sd]!.x);
    w.paddles[sd]!.position.set(px, 0, -Rules.paddleY(cur, sd));
    setEdge(sd, cur.phase === "serve" && cur.server === sd);
  }
  for (const { def, mesh } of w.obstacles) {
    if (def.type === "block" && def.move) {
      const period = Math.max(1, def.move.period || 480);
      const s = Math.sin((2 * PI * ((cur.tick % period) + alpha)) / period);
      if (def.move.axis === "y") mesh.position.z = -(def.y + s * (def.move.amp || 0));
      else mesh.position.x = def.x + s * (def.move.amp || 0);
    }
  }
  decorate(dt);
  updateSparks(reducedMotion ? dt * 0.6 : dt);
  springCamera(Math.min(dt, 0.05));
  drawMirror(w);
}

/** The menu backdrop: a cosmetic rally and a slow camera orbit (frozen under reduced motion or a static background). */
export function idle(dt: number): void {
  const w = world;
  if (!w || !attract) return;
  setAspect();
  const moving = animated();
  if (moving) idleT += dt;
  const t = idleT + 1.7;
  const { w: aw, h: ah } = w.ruleset.arena;
  const zA = ah / 2 - 0.9;
  const u = (t * 0.45) % 2;
  const along = u < 1 ? u : 2 - u;
  const bz = -zA + 0.8 + along * (2 * zA - 1.6);
  const bx = Math.sin(t * 1.1) * aw * 0.33;
  w.ball.position.set(bx, 0.42, bz);
  w.ballMat.emissiveIntensity = 1.6;
  const clampX = (v: number): number => Math.max(-aw / 2 + 2, Math.min(aw / 2 - 2, v));
  w.paddles[0]!.position.set(clampX(bx * 0.9), 0, zA);
  w.paddles[1]!.position.set(clampX(bx * 0.85), 0, -zA);
  setEdge(0, false);
  setEdge(1, false);
  if (moving && trailEnabled()) trailPush(bx, 0.42, bz);
  decorate(dt);
  updateSparks(dt);
  const a = 0.55 + t * 0.06;
  const r = Math.max(aw, ah) * 1.35;
  camera.position.set(Math.sin(a) * r, ah * 0.62, Math.cos(a) * r);
  camera.lookAt(0, 0, 0);
  fitFog(camera.position.length());
  drawMirror(w);
}

/** Sparks, goal pulses and shake per rules event (scene.js handleEvents). */
export function handleEvents(events: RulesEvent[]): void {
  const w = world;
  if (!w) return;
  for (const e of events) {
    const z = -(e.y ?? 0);
    switch (e.t) {
      case "paddle": spawn(e.x ?? 0, 0.5, z, { count: 10, color: e.player === 0 ? w.theme.paddleA : w.theme.paddleB, speed: 4.5, life: 0.45 }); break;
      case "wall": spawn(e.x ?? 0, 0.4, z, { count: 6, color: w.theme.wall, speed: 3, life: 0.35 }); break;
      case "bumper": spawn(e.x ?? 0, 0.6, z, { count: 12, color: w.theme.obstacle, speed: 5, life: 0.5 }); break;
      case "goal": {
        w.goalMats[1 - (e.player ?? 0)]!.pulse = 1;
        spawn(e.x ?? 0, 0.5, z, { count: 46, color: e.player === 0 ? w.theme.paddleA : w.theme.paddleB, speed: 8, life: 0.9 });
        break;
      }
      case "match-end": spawn(0, 1, side === e.winner ? 6 : -6, { count: 70, color: w.theme.accent, speed: 9, up: 5, life: 1.2 }); break;
      default: break;
    }
    const k = SHAKE_BY_EVENT[e.t];
    if (k) kick(k);
  }
}

const ray = new Raycaster();
const ndc = new Vector2();
const hit = new Vector3();
const plane = { normal: new Vector3(0, 1, 0), constant: -0.4 };
/** A pointer's window x as an arena x at the paddle plane (scene.js screenToArenaX: a ray through the screen's middle row). */
export function screenToArenaX(x: number): number {
  ndc.set((x / Math.max(1, viewW)) * 2 - 1, 0);
  camera.updateMatrixWorld();
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  if (Math.abs(d.y) < 1e-6) return 0;
  const t = -(o.dot(plane.normal) + plane.constant) / d.dot(plane.normal);
  if (!(t > 0)) return 0;
  hit.copy(o).addScaledVector(d, t);
  return hit.x;
}
/** Window position of an arena point (for the HUD anchors). */
export function project(x: number, y: number, z: number): { x: number; y: number } {
  const v = new Vector3(x, y, z).project(camera);
  return { x: (v.x * 0.5 + 0.5) * viewW, y: (-v.y * 0.5 + 0.5) * viewH };
}

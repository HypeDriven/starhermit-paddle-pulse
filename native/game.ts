// The browser build's pure game modules, imported unchanged in what they
// decide (allowJs): the deterministic rules (js/rules/engine.js: the 120 Hz
// fixed-step physics, commands, scoring, terminal reasons, replay envelope
// and its verifier), the seeded streams (js/rules/rng.js), the session
// (js/session/match.js: command intake, the AI seats of js/session/ai.js,
// undo snapshots, interpolation data, resume snapshots), the versioned,
// checksummed documents (js/session/storage.js, on the backend
// native/platform.ts gives it), the content (js/content/*.js: Journey,
// Challenges, practice difficulties, lessons, the Daily, themes and
// colour-vision palettes, achievements) and the string tables
// (js/ui/i18n.js). Typed here with the shapes this client reads.
import * as EngineJs from "../js/rules/engine.js";
import * as MatchJs from "../js/session/match.js";
import * as StorageJs from "../js/session/storage.js";
import * as LevelsJs from "../js/content/levels.js";
import * as TutorialsJs from "../js/content/tutorials.js";
import * as DailyJs from "../js/content/daily.js";
import * as AchievementsJs from "../js/content/achievements.js";
import * as ThemesJs from "../js/content/themes.js";
import * as RngJs from "../js/rules/rng.js";

export interface Obstacle {
  type: "bumper" | "block"; id?: string; x: number; y: number; r?: number; hw?: number; hh?: number;
  move?: { axis: "x" | "y"; amp: number; period: number };
}
export interface Ruleset {
  targetScore: number; winMargin: number; ballSpeed: number; maxBallSpeed: number; speedGain: number; paddleWidth: number;
  paddleSpeed: number; ballRadius: number; arena: { w: number; h: number }; obstacles: Obstacle[]; maxTicks: number; moveLimit: number;
  maxServeAngle: number; maxReturnAngle: number; moveLimitPlayers?: number[];
}
export interface Ball { x: number; y: number; vx: number; vy: number; speed: number; lastHit: number }
export interface Paddle { side: number; x: number; tx: number; halfW: number }
export interface Breakdown {
  goals: number[]; targetScore: number; winMargin: number; rallies: number; longestRally: number; hits: number[]; moves: number[];
  invalidActions: number[]; fastestReturn: number; elapsedTicks: number; elapsedSeconds: number;
}
export interface Terminal { reason: string; winner: number; score: number[]; breakdown: Breakdown }
export interface State {
  v: number; seed: number; sessionId: string; ruleset: Ruleset; tick: number; phase: "serve" | "rally" | "point" | "over";
  ball: Ball; paddles: Paddle[]; score: number[]; server: number; rally: { hits: number; ticks: number };
  stats: { hits: number[]; moves: number[]; invalid: number[]; longestRally: number; fastestSpeed: number; rallies: number };
  pointTicks: number; winner: number; terminal: Terminal | null;
}
/** A drained rules event (fields by type). */
export interface RulesEvent {
  t: string; tick?: number; player?: number; x?: number; y?: number; speed?: number; offset?: number; rally?: number;
  score?: number[]; winner?: number; reason?: string; id?: string;
}
export interface Command { id?: string; player: number; type: string; x?: number }
export interface Seat { kind: "human" | "ai"; name: string; level?: number; id?: string }
export interface Replay { v: number; commands: unknown[]; terminal: Terminal | null }
export interface Match {
  mode: string; contentId: string; seats: Seat[]; allowUndo: boolean; state: State; replay: Replay; snapshots: string[];
  readonly finished: boolean; readonly result: Terminal | null;
  submit(cmd: Command): { ok: boolean; reason?: string; duplicate?: boolean };
  step(): RulesEvent[];
  interpolation(alpha: number): { prev: State; cur: State; alpha: number };
  undo(): boolean;
  snapshot(): string;
}
export interface LessonStep { id: string; text: string; hint: string; require: { type: string; dir?: number; player?: number; minOffset?: number } }
export interface Lesson { id: string; title: string; objective: string; ruleset: Partial<Ruleset>; ai: number; aiIdle?: boolean; steps: LessonStep[] }
export interface Level {
  id: string; version: number; index: number; chapter: string; title: string; brief: string; seed: number; theme: string;
  mechanics: string[]; mastery: boolean; ruleset: Partial<Ruleset>; ai: number;
  goals: { win: boolean; par: { star2: number; star3: number; maxTicks: number } };
}
export interface Challenge {
  id: string; version: number; title: string; brief: string; seed: number; theme: string; mechanics: string[];
  ruleset: Partial<Ruleset>; ai: number; goals: { win: boolean; constraint: string };
}
export interface Difficulty { id: string; name: string; ai: number; ruleset: Partial<Ruleset> }
export interface AiLevel { name: string; reactTicks: number; speed: number; error: number; anticipate: number }
export interface Daily { id: string; version: number; date: string; name: string; seed: number; ruleset: Partial<Ruleset>; ai: number; theme: string; excluded: boolean }
export interface Achievement { key: string; name: string; desc: string; icon: string; progress?: number }
export interface Theme {
  id: string; name: string; floor: number; grid: number; wall: number; wallEmissive: number; paddleA: number; paddleB: number;
  ball: number; accent: number; obstacle: number; fog: number; ambience: { root: number; mood: string }; bloom: number;
}
export interface Settings {
  v: number; displayName: string; language: string; privacy: { hiddenProfile: boolean };
  audio: { music: number; effects: number; ambience: number; voice: number; muted: boolean };
  graphics: { preset: string; render_scale: number; adaptive: boolean; show_fps: boolean; trails: boolean };
  camera: { view: string };
  accessibility: {
    reducedMotion: boolean; highContrast: boolean; palette: string; textScale: number; leftHanded: boolean; holdVsToggle: string;
    timingAssist: boolean; haptics: boolean; captions: boolean;
  };
  controls: { keys: Record<string, string>; gamepad: Record<string, number> };
  tutorialDone: Record<string, boolean>;
  solo: { difficulty: string };
}
export interface BoardEntry { name: string; score: number; duration: number; rulesetVersion?: number; seed?: number; assists?: boolean }
export interface Progress {
  v: number; journey: Record<string, { stars: number; wins: number }>; challenges: Record<string, { cleared: boolean; best: string }>;
  dailies: Record<string, { won: boolean; score: number[]; duration: number; seed: number; rulesetVersion: number }>;
  achievements: Record<string, { at: number | null; progress: number }>; streak: { current: number; best: number };
  totals: { matches: number; wins: number; angledHits: number; masteryCleared: number };
  leaderboards: { daily: Record<string, BoardEntry[]>; local: BoardEntry[] }; rating: { mu: number; rd: number; matches: number };
}
export interface Doc<T> { v: number; updatedAt: number; data: T; checksum: string }
export interface Backend { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

interface EngineApi {
  TICK_RATE: number; DT: number;
  PHASE: { SERVE: "serve"; RALLY: "rally"; POINT: "point"; OVER: "over" };
  CMD: { MOVE: "move"; SERVE: "serve"; CONCEDE: "concede" };
  TERMINAL: Record<string, string>;
  DEFAULT_RULESET: Ruleset;
  paddleY(state: { ruleset: Ruleset }, side: number): number;
  verifyReplay(replay: Replay): { ok: boolean; mismatchTick?: number };
}
interface MatchApi {
  LocalMatch: {
    new (opts: { seats: Seat[]; mode?: string; contentId?: string; ruleset?: Partial<Ruleset>; seed?: number; allowUndo?: boolean; sessionId?: string; build?: string; aiIdle?: boolean }): Match;
    restore(json: string, build?: string): Match;
  };
  nextCmdId(player: number): string;
}
interface StorageApi {
  Storage: new (backend: Backend) => { saveDoc(key: string, data: unknown): boolean; loadDoc<T>(key: string): Doc<T> | null; clear(key: string): void };
  defaultSettings(): Settings; migrateSettings(s: unknown): Settings;
  defaultProgress(): Progress; migrateProgress(p: unknown): Progress; mergeProgress(remote: unknown, local: unknown): Progress;
  validateLeaderboardEntry(entry: BoardEntry, opts?: { targetScore?: number }): { ok: boolean; reason?: string };
}
interface LevelsApi {
  JOURNEY_LEVELS: Level[]; CHALLENGES: Challenge[]; PRACTICE_DIFFICULTIES: Difficulty[]; AI_LEVELS: AiLevel[];
  getJourneyLevel(idOrIndex: string | number): Level | null; getChallenge(id: string): Challenge | null;
}
interface TutorialsApi { LESSONS: Lesson[]; getLesson(id: string): Lesson | null; stepSatisfied(step: LessonStep, evt: Record<string, unknown>): boolean }
interface DailyApi { DAILY_RULESET_VERSION: number; utcDateString(now?: number): string; dailyContent(date?: string): Daily; msUntilNextDaily(now?: number): number }
interface AchievementsApi { ACHIEVEMENTS: Achievement[]; getAchievement(key: string): Achievement | null }
interface ThemesApi { THEMES: Record<string, Theme>; CVD_PALETTES: Record<string, { paddleA: number; paddleB: number; ball: number; accent: number } | null>; getTheme(id: string): Theme }
interface RngApi { createRng(seed: number): { n: number }; next(rng: { n: number }): number; range(rng: { n: number }, min: number, max: number): number; hashSeed(s: string): number }

export const Rules = EngineJs as unknown as EngineApi;
export const Sess = MatchJs as unknown as MatchApi;
export const Store = StorageJs as unknown as StorageApi;
export const Levels = LevelsJs as unknown as LevelsApi;
export const Tutorials = TutorialsJs as unknown as TutorialsApi;
export const Daily = DailyJs as unknown as DailyApi;
export const Ach = AchievementsJs as unknown as AchievementsApi;
export const Themes = ThemesJs as unknown as ThemesApi;
export const Rng = RngJs as unknown as RngApi;

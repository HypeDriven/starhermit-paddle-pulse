// The game's data and the StarHermit platform, on the runtime's modules. The
// browser build's versioned, checksummed documents (js/session/storage.js)
// keep their code; this module gives them a backend:
// - progress (Journey stars and wins, challenge clears, dailies, achievements,
//   streaks, totals, the local and daily boards, the display rating) is the
//   game's save (starhermit:storage `saves`): on the device and, signed in, in
//   the player's cloud slot. Two devices' copies merge on a conflict
//   (storage.mergeProgress, the browser build's saveconflict merge). The slot
//   the browser build wrote (the JS SDK's writeSave of { settings, progress }
//   under game:<slug>) shows as foreign: its progress is merged in, its
//   tutorial completions unioned, and it is replaced once;
// - the settings document (the game's own options: the mute, ball trails,
//   camera view, colour palette, left-handed layout, timing assist, haptics,
//   captions, practice difficulty, the guest's display name, the
//   hidden-profile flag and the lessons done) is one synced game setting
//   (`prefs`); the browser build's account settings KV (audio, graphics,
//   camera, accessibility, solo, privacy, ui.language, audio.options) is
//   adopted once (unless this device has options already) and removed.
//   Volumes, graphics, language, reduced motion, high contrast, text size and
//   key bindings are the runtime's Options;
// - the resume snapshot stays on the device (storage KV);
// - the player and their avatar, the invite link, the platform's clock for
//   the Daily, the longest-rally board for the Boards screen, and posting a
//   finished Journey, Daily or Challenge match's longest rally through
//   score-script.js (a practice session whose socket carries { type:
//   'result', scores }, as the JS SDK's submitScores did) with the rank.
import type { JsonValue } from "starhermit:engine";
import {
  avatar as fetchAvatar, connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions,
  type Leaderboard,
} from "starhermit:platform";
import { saves, settings as gameSettings, storage as device } from "starhermit:storage";
import type { ImageBitmap } from "starhermit:canvas";
import { Store, type Backend, type Progress, type Settings } from "./game.ts";
import * as MigrateJs from "../js/migrate.js";
import * as HashJs from "../js/rules/hash.js";

const Migrate = MigrateJs as unknown as {
  LEGACY_KEYS: string[];
  parseForeign(text: string | null): { settings: Record<string, unknown> | null; progress: Record<string, unknown> | null } | null;
  settingsFromLegacy(defaults: Settings, legacy: Record<string, unknown>): Settings;
  mergeForeignSettings(local: Settings, remote: unknown, adoptOptions: boolean): Settings;
};
const Hash = HashJs as unknown as { hashObject(o: unknown): string };

const PREFIX = "paddlepulse:";
const PROGRESS_KEY = PREFIX + "progress";
const SETTINGS_KEY = PREFIX + "settings";
const PREFS = "prefs";
export const BOARD_KEY = "longest-rally";

// -- the documents' backend ------------------------------------------------------------------
/** js/session/storage.js wraps every document as { v, updatedAt, data, checksum }; the save holds just the data. */
function wrap(data: unknown): string {
  return JSON.stringify({ v: 1, updatedAt: 0, data, checksum: Hash.hashObject(data) });
}
function unwrapData(text: string): unknown {
  try { const d = JSON.parse(text) as { data?: unknown }; return d && typeof d === "object" ? d.data : null; } catch { return null; }
}
let lastSavedAt = 0;
const backend: Backend = {
  getItem(key) {
    if (key === PROGRESS_KEY) {
      const cur = saves.load();
      return cur && cur.data && typeof cur.data === "object" ? wrap(cur.data) : null;
    }
    if (key === SETTINGS_KEY) {
      try { const v = gameSettings.get(PREFS); return v === undefined ? null : wrap(v); } catch { return null; }
    }
    // The saves and settings keep their own previous copies: no ":bak" documents for them.
    if (key === PROGRESS_KEY + ":bak" || key === SETTINGS_KEY + ":bak") return null;
    try { return device.getText(key); } catch { return null; }
  },
  setItem(key, value) {
    if (key === PROGRESS_KEY) {
      const data = unwrapData(value);
      if (data && typeof data === "object") {
        try { saves.save(data as JsonValue, { schema: 1 }); lastSavedAt = saves.load()?.savedAt ?? lastSavedAt; }
        catch (e) { console.warn(`save: ${String(e)}`); }
      }
      return;
    }
    if (key === SETTINGS_KEY) {
      const data = unwrapData(value);
      try { if (data && typeof data === "object") gameSettings.set(PREFS, data as JsonValue); } catch (e) { console.warn(`settings: ${String(e)}`); }
      return;
    }
    if (key === PROGRESS_KEY + ":bak" || key === SETTINGS_KEY + ":bak") return;
    try { device.set(key, value); } catch (e) { console.warn(`storage ${key}: ${String(e)}`); }
  },
  removeItem(key) {
    if (key === PROGRESS_KEY) { saves.save(Store.defaultProgress() as unknown as JsonValue, { schema: 1 }); return; }
    if (key === SETTINGS_KEY) { try { gameSettings.delete(PREFS); } catch { /* gone */ } return; }
    try { device.remove(key); } catch { /* gone */ }
  },
};
export const storage = new Store.Storage(backend);

// -- the live documents ------------------------------------------------------------------------
/** The live settings and progress objects (the game and the screens mutate them in place). */
export const settings: Settings = Store.defaultSettings();
export const progress: Progress = Store.defaultProgress();
function replaceProgress(next: Progress): void {
  const p = progress as unknown as Record<string, unknown>;
  for (const k of Object.keys(p)) delete p[k];
  Object.assign(p, next);
}
function replaceSettings(next: Settings): void {
  const s = settings as unknown as Record<string, unknown>;
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, next);
}
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }
const settingsListeners = new Set<() => void>();
/** fn() after the game's options changed (here, from the account, or migrated). */
export function onSettingsChange(fn: () => void): void { settingsListeners.add(fn); }
function settingsChanged(): void { for (const fn of settingsListeners) fn(); }

/** Saves the progress document (device at once, the account debounced by the runtime). */
export function saveProgress(): void { storage.saveDoc("progress", progress); }
/** Saves the game's options (synced with the account). */
export function saveSettings(): void { storage.saveDoc("settings", settings); settingsChanged(); }
function loadSettings(): Settings { return Store.migrateSettings(storage.loadDoc<Settings>("settings")?.data); }
function loadProgress(): Progress { return Store.migrateProgress(storage.loadDoc<Progress>("progress")?.data); }

/** Merges another copy into the live document (and saves); whether anything changed. */
function adopt(other: unknown): boolean {
  if (!other || typeof other !== "object") return false;
  const before = JSON.stringify(progress);
  const next = Store.mergeProgress(other, JSON.parse(before));
  if (JSON.stringify(next) === before) return false;
  replaceProgress(next);
  saveProgress();
  return true;
}
saves.onConflict((local, remote) => ({ merged: Store.mergeProgress(remote.data, local?.data ?? null) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): take it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud save ({ settings, progress } as JSON): merged with this device's, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const doc = Migrate.parseForeign(old.text);
  let changed = false;
  if (doc?.progress) changed = adopt(doc.progress);
  if (doc?.settings) {
    let had = false;
    try { had = gameSettings.get(PREFS) !== undefined; } catch { had = true; }
    const next = Migrate.mergeForeignSettings(settings, doc.settings, !had);
    if (JSON.stringify(next) !== JSON.stringify(settings)) { replaceSettings(next); saveSettings(); changed = true; }
  }
  try { saves.save(progress as unknown as JsonValue, { schema: 1, replaceForeign: true }); lastSavedAt = saves.load()?.savedAt ?? lastSavedAt; }
  catch (e) { console.warn(`save: ${String(e)}`); }
  if (changed) merged();
}

/** For the Settings line: local (a guest) | syncing | saving | synced | offline. */
export function syncState(): "local" | "syncing" | "saving" | "synced" | "offline" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "offline";
  if (st === "loading" || st === "foreign") return "syncing";
  if (st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
/** Sends the save now (Settings › Sync now); whether it reached the account. */
export async function flush(): Promise<boolean> {
  try { return (await saves.flush()) === "saved-to-account"; } catch { return false; }
}

// -- the browser build's account settings ------------------------------------------------------
function importLegacy(): void {
  const keys = gameSettings.legacyKeys();
  if (!keys || !keys.length) return;
  let had = false;
  try { had = gameSettings.get(PREFS) !== undefined; } catch { had = true; }
  if (!had) {
    const old: Record<string, unknown> = {};
    for (const k of keys) if (Migrate.LEGACY_KEYS.includes(k)) old[k] = gameSettings.legacy(k);
    replaceSettings(Migrate.settingsFromLegacy({ ...Store.defaultSettings(), tutorialDone: { ...settings.tutorialDone } }, old));
    storage.saveDoc("settings", settings);
  }
  for (const k of keys) if (Migrate.LEGACY_KEYS.includes(k)) gameSettings.removeLegacy(k);
  if (!had) settingsChanged();
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  lastSavedAt = saves.load()?.savedAt ?? 0;
  replaceProgress(loadProgress());
  replaceSettings(loadSettings());
  gameSettings.onChange((key) => {
    if (key !== PREFS) return;
    replaceSettings(loadSettings());
    settingsChanged();
  });
  gameSettings.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

/** Settings › Reset progress: progress back to a new player's (main.js reset-progress). */
export function resetProgress(): void {
  replaceProgress(Store.defaultProgress());
  saveProgress();
}

// -- the player, the avatar and the clock ------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
let avatarImage: ImageBitmap | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
/** The signed-in player's avatar once loaded, else null. */
export function avatarBitmap(): ImageBitmap | null { return player() ? avatarImage : null; }
const playerListeners = new Set<(on: boolean) => void>();
export function onPlayer(fn: (on: boolean) => void): void { playerListeners.add(fn); }
function refreshPlayer(): void {
  invite = null;
  avatarImage = null;
  board = undefined;
  const me = player();
  if (!me) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
  fetchAvatar(me.userId).then((b) => { if (player()?.userId === me.userId) avatarImage = b; }, () => undefined);
}
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(!!player()); });

/** Now in ms by the platform's clock when it has answered, else the device's. */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// -- the longest-rally board -----------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function rallyBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === BOARD_KEY) ?? null;
  return board;
}
export interface BoardLine { rank: number; name: string; score: number; me: boolean }
/** The StarHermit longest-rally board, top 10; null when there is none or it cannot be read. */
export async function readBoard(): Promise<BoardLine[] | null> {
  try {
    const b = await rallyBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize: 10 });
    const meId = player()?.userId;
    return r.items.slice(0, 10).map((e, i) => ({
      rank: e.rank ?? i + 1, name: e.displayName || e.username, score: e.score ?? 0, me: !!meId && e.userId === meId,
    }));
  } catch { return null; }
}
export interface Posted { posted: boolean; rank: number | null }
/** Signed in only: post a finished match's longest rally through score-script.js; { posted, rank }. Never rejects. */
export async function postLongestRally(value: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(value));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { [BOARD_KEY]: score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes(BOARD_KEY)) return { posted: false, rank: null };
  try {
    const b = await rallyBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}

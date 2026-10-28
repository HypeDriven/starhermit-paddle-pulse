// Localization: the browser build's string tables (js/ui/i18n.js: the nine
// StarHermit locales, keyed UI strings through t(); js/ui/i18n-content.js:
// authored content keyed by its US-English text through tc(); the engine
// client's own strings in js/ui/i18n-native.js) in the interface language the
// runtime reports (preferences().language: the player's choice in Options ›
// Language, else the account's preferred language or the device's). The
// runtime's Options replaced the game's Language section (sh-language.js) and
// the DOM re-render: every string is drawn through t() each frame, so a change
// shows on the next frame without touching the match.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import * as I18nJs from "../js/ui/i18n.js";

const I18n = I18nJs as unknown as {
  LOCALES: string[];
  setLocale(tag: string): void;
  currentLocale(): string;
  t(key: string, vars?: Record<string, string | number> | null): string;
  tc(text: string, vars?: Record<string, string | number> | null): string;
};
const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (sh-language.js's mapping: es-MX → es-419, en-AU → en-GB, fr → fr-FR, pt-PT → pt-BR). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US");
  const exact = I18n.LOCALES.find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const lang = s.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|uk|ie|au|nz|za|in)$/i.test(s)) return "en-GB";
  if (lang === "es" && /-es$/i.test(s)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(s)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "";
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  I18n.setLocale(next);
  locale = I18n.currentLocale();
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));
export function currentLocale(): string { return locale; }

export type Vars = Record<string, string | number>;
/** A UI string by its key in the player's language; `{name}` placeholders from vars. */
export function t(key: string, vars?: Vars | null): string { return I18n.t(key, vars ?? null); }
/** Authored content (lesson, stage, challenge, achievement texts) by its US-English text. */
export function tc(text: string, vars?: Vars | null): string { return I18n.tc(text, vars ?? null); }
/** A whole number as the browser build showed it (en-US grouping in every language: fmtInt). */
export function fmtInt(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? "-" : "") + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
/** m:ss (app.js fmtTime). */
export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

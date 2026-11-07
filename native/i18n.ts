// Localization: the engine's string tables (assets/strings.json: the nine
// StarHermit locales, keyed UI strings through t(), authored content keyed by its
// US-English text through tc()) in the interface language the runtime reports
// (the player's choice in Options › Language, else the account's preferred language
// or the device's). The runtime's Options replaced the game's Language section
// (sh-language.js) and the DOM re-render: every string is drawn through t() each
// frame, so a change shows on the next frame without touching the match.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** A UI string by its key in the player's language; `{name}` placeholders from vars. */
export function t(key: string, vars?: Vars | null): string {
  const k = String(key ?? "");
  if (strings.has(k)) return strings.t(k, vars ?? undefined);
  return vars ? k.replace(/\{(\w+)\}/g, (m, n: string) => (vars[n] != null ? String(vars[n]) : m)) : k;
}
/** Authored content (lesson, stage, challenge, achievement texts) by its US-English text. */
export const tc = t;
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

// The look of the HUD, screens, toasts and captions: the browser build's
// style.css, rewritten class-based in tools/ui-style.css and converted once
// with `starhermit css` into assets/ui-style.json (`npm run css`), registered
// at start with the theme the runtime's own widgets (dialogs, check boxes,
// selects, sliders, text fields, scroll bars) take. The old body.high-contrast
// palette is a token set applied while the runtime's high-contrast option is
// on, and the colour-vision palettes (body.palette-*) swap the cyan and
// magenta tokens, as before.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string | number>;
let base: Tokens = {};
/** style.css body.high-contrast. */
const HIGH_CONTRAST: Tokens = { panel: "#000000f5", ink: "#ffffff", dim: "#d5deee", cyan: "#00ffff", magenta: "#ffe600", line: "#ffffff8c" };
/** style.css body.palette-*. */
const PALETTES: Record<string, Tokens> = {
  "high-contrast": { cyan: "#00ffff", magenta: "#ffe600" },
  deuteranopia: { cyan: "#00b7ff", magenta: "#ffd23d" },
  protanopia: { cyan: "#00d5ff", magenta: "#f0e13d" },
  tritanopia: { cyan: "#00ffd5", magenta: "#ff3d5a" },
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  base = { ...(css.tokens as Tokens) };
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 10, radius: 10,
    text: "#e8f4ff", muted: "#93a4c4", panel: "#0a0e1c", control: "#141c36", hovered: "#1c2748",
    pressed: "#0a0e1c", field: "#080c1a", accent: "#27e6ff", focus: "#ffe600", outline: "#27e6ff38",
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "$dim", radius: 4 } } },
    tooltip: { background: "$panel-solid", text: { color: "$ink" }, radius: 6, padding: 6 },
    dialog: { ...(css.styles[".panel"] as ui.Style), parts: { backdrop: { background: "#03050ce6" } } },
  });
}

let key = "";
/** The palette and high-contrast tokens over the sheet's. */
export function applyTokens(highContrast: boolean, palette: string): void {
  const k = `${highContrast}:${palette}`;
  if (k === key) return;
  key = k;
  ui.setTokens({ ...base, ...(PALETTES[palette] ?? {}), ...(highContrast ? HIGH_CONTRAST : {}) });
}

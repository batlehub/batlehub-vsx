#!/usr/bin/env node
// The derivation of RFC 0014 §4.2: one token block, one rule table, three
// theme files. The JSON under themes/ is this script's output and is never
// edited by hand — test/contrast.test.ts re-runs derive() and compares.
//
//   pnpm run derive     # rewrite themes/batlehub-{dark,light,hc}.json

import fs from "node:fs";
import path from "node:path";
import {
  composite,
  contrast,
  deltaE,
  fromOklchClamped,
  parseHex,
  reLightness,
  reLightnessOn,
  toHex,
  toOklch,
} from "./color.mjs";

const dir = path.join(import.meta.dirname, "..", "themes");
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

export const tokens = read("tokens.json");
export const baseDefaults = read("base-defaults.json");

// ── The rule table (§4.2) ────────────────────────────────────────────────
// A DESIGN.md token, and every editor key that takes it. Two keys are HC's
// alone: the editor outlines every widget with them and only there.
export const ROLES = {
  ground: [
    "activityBar.background",
    "editor.background",
    "notifications.background",
    "panel.background",
    "sideBar.background",
    "terminal.background",
    "titleBar.activeBackground",
  ],
  "ground-sunk": [
    "button.secondaryBackground",
    "dropdown.background",
    "editorWidget.background",
    "input.background",
    "quickInput.background",
    "statusBar.background",
    "textBlockQuote.background",
    "textPreformat.background",
  ],
  // statusBarItem.prominentBackground is the editor's own 50% black scrim: on
  // a paper status bar no foreground can reach 4.5:1 through it, so the theme
  // takes the fill as well as the text (§4.3, promoted not waived).
  "ground-raised": [
    "button.secondaryHoverBackground",
    "editor.lineHighlightBackground",
    "list.activeSelectionBackground",
    "list.hoverBackground",
    "statusBarItem.prominentBackground",
    "tab.activeBackground",
  ],
  ink: [
    "activityBar.foreground",
    "button.secondaryForeground",
    "editor.foreground",
    "editorCursor.foreground",
    "input.foreground",
    "panelTitle.activeForeground",
    "foreground",
    "list.activeSelectionForeground",
    "quickInput.foreground",
    "statusBarItem.prominentForeground",
    "tab.activeForeground",
    "titleBar.activeForeground",
  ],
  "ink-dim": [
    "activityBar.inactiveForeground",
    "descriptionForeground",
    "disabledForeground",
    "editorCodeLens.foreground",
    "editorLineNumber.foreground",
    "panelTitle.inactiveForeground",
    "sideBarSectionHeader.foreground",
    "statusBar.foreground",
    "tab.inactiveForeground",
  ],
  "rule-soft": [
    "editorGroup.border",
    "editorIndentGuide.background",
    "editorRuler.foreground",
    "panel.border",
    "sideBar.border",
    "textBlockQuote.border",
    "tree.indentGuidesStroke",
  ],
  "rule-strong": [
    "button.border",
    "checkbox.border",
    "contrastBorder",
    "dropdown.border",
    "editorWidget.border",
    "input.border",
    "widget.border",
  ],
  accent: [
    "activityBar.activeBorder",
    "activityBarBadge.background",
    "badge.background",
    "button.background",
    "panelTitle.activeBorder",
    "tab.activeBorder",
    "textLink.foreground",
  ],
  "accent-ink": [
    "activityBarBadge.foreground",
    "badge.foreground",
    "button.foreground",
  ],
  copper: [
    "editorGutter.modifiedBackground",
    "textPreformat.foreground",
    "editorWarning.foreground",
    "gitDecoration.modifiedResourceForeground",
    "list.warningForeground",
    "statusBarItem.warningForeground",
    "terminal.ansiYellow",
  ],
  focus: ["contrastActiveBorder", "focusBorder"],
};

/** The two keys the editor only reads in a high-contrast theme. */
export const HC_ONLY = new Set(["contrastBorder", "contrastActiveBorder"]);

/**
 * "this is broken" — the one colour of the theme that does not come from
 * DESIGN.md. Crimson says "do this"; a hue cannot say both (§11 decision 7).
 */
export const ERROR_KEYS = [
  "editorError.foreground",
  "editorOverviewRuler.errorForeground",
  "errorForeground",
  "inputValidation.errorBorder",
  "list.errorForeground",
  "terminal.ansiRed",
];

/**
 * The token families the Undependable Fill Rule accepts as a fill's partner:
 * anything that is not itself a fill. Copper is one — inline code is told
 * apart by its copper text, not by the well behind it.
 */
export const PARTNER_TOKENS = [
  "ink",
  "ink-dim",
  "rule-soft",
  "rule-strong",
  "copper",
];

export const VARIANTS = {
  dark: {
    file: "batlehub-dark.json",
    uiTheme: "vs-dark",
    type: "dark",
    label: "BatleHub Dark",
  },
  light: {
    file: "batlehub-light.json",
    uiTheme: "vs",
    type: "light",
    label: "BatleHub Light",
  },
  hc: {
    file: "batlehub-hc.json",
    uiTheme: "hc-black",
    type: "hcDark",
    label: "BatleHub High Contrast",
  },
};

/** The ratios DESIGN.md states for the pairs that land in the editor. */
export const FLOORS = {
  dark: {
    ink: 16,
    "ink-dim": 5.28,
    "ink-dim-raised": 5.2,
    accent: 5.6,
    error: 4.5,
    focus: 13,
    "rule-strong": 3.4,
    counterInk: 5.6,
  },
  light: {
    ink: 16,
    "ink-dim": 5.28,
    "ink-dim-raised": 5.2,
    accent: 5.6,
    error: 4.5,
    focus: 4.4,
    "rule-strong": 3.4,
    counterInk: 5.6,
  },
  hc: {
    ink: 16,
    "ink-dim": 7,
    "ink-dim-raised": 7,
    accent: 7,
    error: 7,
    focus: 13,
    "rule-strong": 3.4,
    counterInk: 7,
  },
};

/** Inherited keys — the base theme chose them for another ground (§4.3). */
export const INHERITED_FLOORS = {
  dark: { text: 4.5, other: 3 },
  light: { text: 4.5, other: 3 },
  hc: { text: 7, other: 3 },
};

/** An inherited key that draws an icon or a mark: WCAG 1.4.11's 3:1, not 4.5:1. */
const MARK_KEY =
  /icon|lightbulb|graph|chart|decoration|gutter|minimap|bracket|indicator|breakpoint/i;

/**
 * An inherited key that draws a hairline — a boundary, a guide, a ruler, a
 * whitespace dot. DESIGN.md is explicit that a soft rule "is not a
 * contrast-carrying value", so the floor for one is not WCAG's: it is the
 * theme's own, and no inherited hairline may be fainter than a BatleHub
 * separator on the same ground.
 */
const HAIRLINE_KEY =
  /border|guide|sash|stroke|separator|slider|ruler|whitespace/i;

/**
 * `minimap.foregroundOpacity` is an alpha channel wearing a colour's clothes —
 * its lightness means nothing and re-deriving it would change the minimap's
 * opacity, not its contrast.
 */
const NOT_A_COLOUR = /opacity/i;

/**
 * Crimson and a conventional red are neighbours in hue; decision 7 is only
 * worth its row if the eye tells them apart. Fixed with the first derivation
 * (§11 open 3): the editor's own error reds land at ΔE 0.034 (dark) and 0.056
 * (light) from crimson — under, and barely over, what the eye reads as a
 * second colour. 0.05 is roughly twice the OKLab just-noticeable difference
 * and is the most the palette gives before the red reaches copper, which sits
 * at ΔE 0.10–0.12 from it. A red that falls under the floor rotates toward
 * orange; crimson never moves — the palette is BatleHub's.
 */
export const MIN_ACCENT_ERROR_DELTA_E = 0.05;

/** How far toward orange an error red may rotate before the hue is copper's. */
const MAX_ERROR_HUE = 45;

// ── The four voices (§4.2, second table) ─────────────────────────────────
export const VOICES = [
  {
    voice: "ink",
    name: "Types and namespaces",
    semantic: [
      "class",
      "interface",
      "enum",
      "record",
      "typeParameter",
      "namespace",
    ],
    scopes: ["entity.name.type", "entity.name.namespace"],
  },
  {
    voice: "ink",
    style: "bold",
    name: "Declarations",
    semantic: ["class.declaration", "method.declaration"],
    scopes: ["entity.name.function"],
  },
  {
    voice: "ink-dim",
    name: "Everything ordinary",
    semantic: [
      "method",
      "property",
      "parameter",
      "variable",
      "keyword",
      "modifier",
      "operator",
    ],
    scopes: ["keyword", "storage", "variable", "punctuation"],
  },
  {
    voice: "ink-dim",
    style: "italic",
    name: "Comments",
    semantic: ["comment"],
    scopes: ["comment"],
  },
  {
    voice: "copper",
    name: "Literals and annotations",
    semantic: [
      "string",
      "number",
      "annotation",
      "annotationMember",
      "enumMember",
    ],
    scopes: [
      "string",
      "constant.numeric",
      "storage.type.annotation",
      "constant.other.enum",
    ],
  },
  {
    voice: "error",
    name: "Invalid",
    semantic: [],
    scopes: ["invalid", "invalid.illegal"],
  },
];

// ── Derivation ───────────────────────────────────────────────────────────

/**
 * The palette of one variant. Dark and light are DESIGN.md's two renditions
 * as written; high contrast is a function of dark (§5.2) — the ground and the
 * hues stay, every text pair is re-derived to AAA by DESIGN.md's Re-Derived
 * Lightness Rule, and soft rules do not exist.
 */
export function palette(variant) {
  const floors = FLOORS[variant];
  if (variant !== "hc") {
    const p = { ...tokens[variant] };
    p.error = errorOf(variant, p, floors.error);
    return p;
  }
  const p = { ...tokens.dark };
  const ground = parseHex(p.ground);
  const raised = parseHex(p["ground-raised"]);
  const lift = (hex, bg, target) =>
    toHex(reLightness(parseHex(hex), bg, target));
  p.ink = lift(lift(p.ink, ground, floors.ink), raised, floors.ink);
  p["ink-dim"] = lift(
    lift(p["ink-dim"], ground, floors["ink-dim"]),
    raised,
    floors["ink-dim-raised"],
  );
  p.accent = lift(lift(p.accent, ground, floors.accent), raised, floors.accent);
  p.copper = lift(
    lift(p.copper, ground, floors["ink-dim"]),
    raised,
    floors["ink-dim"],
  );
  p["accent-ink"] = lift(
    p["accent-ink"],
    parseHex(p.accent),
    floors.counterInk,
  );
  p["rule-soft"] = p["rule-strong"]; // §5.2: every boundary is a strong rule
  p.error = toHex(
    reLightness(
      parseHex(errorOf(variant, p, floors.error)),
      raised,
      floors.error,
    ),
  );
  return p;
}

/**
 * "this is broken", derived: the editor's own error red for this uiTheme, kept
 * in hue and moved in lightness until it clears the floor on the BatleHub
 * ground — then rotated toward orange, if and only if it sits too close to
 * crimson for the eye to read two colours (§11 open 3).
 */
function errorOf(variant, p, target) {
  const ground = parseHex(p.ground);
  const accent = parseHex(p.accent);
  const base = errorBase(variant);
  const held = reLightness(base, ground, target);
  if (deltaE(held, accent) >= MIN_ACCENT_ERROR_DELTA_E) return toHex(held);
  const { L, C, h } = toOklch(base);
  for (let hue = Math.ceil(h) + 1; hue <= MAX_ERROR_HUE; hue++) {
    const moved = reLightness(
      fromOklchClamped({ L, C, h: hue }),
      ground,
      target,
    );
    if (deltaE(moved, accent) >= MIN_ACCENT_ERROR_DELTA_E) return toHex(moved);
  }
  throw new Error(
    `no error red reaches ΔE ${MIN_ACCENT_ERROR_DELTA_E} from ${p.accent} by hue ${MAX_ERROR_HUE}`,
  );
}

/** The editor's own error red for this uiTheme — the start of the derivation. */
function errorBase(variant) {
  const hex = baseDefaults[VARIANTS[variant].uiTheme]["editorError.foreground"];
  if (!hex)
    throw new Error(
      `no editorError.foreground default for ${VARIANTS[variant].uiTheme}`,
    );
  return parseHex(hex);
}

/** The keys of the rule table alone — §4.2, before the inherited sweep. */
export function listedColorsOf(variant) {
  const p = palette(variant);
  const colors = {};
  for (const [token, keys] of Object.entries(ROLES)) {
    for (const key of keys) {
      if (HC_ONLY.has(key) && variant !== "hc") continue;
      colors[key] = p[token];
    }
  }
  for (const key of ERROR_KEYS) colors[key] = p.error;
  return colors;
}

/**
 * The backgrounds an inherited key is painted on, or null when the pair is
 * none of the theme's business.
 *
 * A key with a background of its own — a badge, the debugging status bar —
 * sits on that one. When both halves are the base theme's and opaque, nothing
 * about the pair changed and the theme owes it nothing; when that background
 * is translucent it composites over a BatleHub ground, so the pair is the
 * theme's after all. Everything else is measured against every ground the
 * theme introduces, because the theme cannot know which one the editor will
 * paint it over and owes the floor on all of them. Nothing has to be listed,
 * so a colour the editor adds tomorrow is swept the day it appears rather
 * than waiting for a table to catch up.
 */
export function surfacesFor(key, listed, base) {
  const grounds = groundsOf(listed);
  const sibling = key.replace(/foreground$/i, (m) =>
    m[0] === "F" ? "Background" : "background",
  );
  if (sibling === key || !base[sibling]) return grounds;
  if (sibling in listed) return [parseHex(listed[sibling])];
  const own = parseHex(base[sibling]);
  if (own.a === 1) return null; // the base theme's own pair, on both sides
  return grounds.map((g) => composite(own, g));
}

/** The grounds the theme introduces, in the order surfacesFor names them. */
const groundsOf = (listed) =>
  [
    listed["editor.background"],
    listed["statusBar.background"],
    listed["list.hoverBackground"],
  ].map(parseHex);

/** text, a mark, or a hairline — the three floors an inherited key can owe. */
export function floorFor(key, variant, listed) {
  if (!HAIRLINE_KEY.test(key))
    return MARK_KEY.test(key)
      ? INHERITED_FLOORS[variant].other
      : INHERITED_FLOORS[variant].text;
  const soft = parseHex(listed["panel.border"]);
  return groundsOf(listed).reduce(
    (lo, g) => Math.min(lo, contrast(soft, g)),
    Infinity,
  );
}

/**
 * Every inherited pair the theme owes a floor to: the key, the value in force,
 * the backgrounds it lands on and what it owes there. The derivation walks
 * this to promote what fails; the test walks it to prove nothing does.
 */
export function* inheritedPairs(variant, listed, colors = listed) {
  const base = baseDefaults[VARIANTS[variant].uiTheme];
  for (const [key, hex] of Object.entries(base)) {
    if (!hex || key in listed) continue; // a listed key answers to §4.2's own floors
    if (!/foreground|border/i.test(key) || NOT_A_COLOUR.test(key)) continue;
    const surfaces = surfacesFor(key, listed, base);
    if (!surfaces) continue;
    yield {
      key,
      value: colors[key] ?? hex,
      surfaces,
      floor: floorFor(key, variant, listed),
    };
  }
}

/**
 * Every inherited key that fails its floor on a BatleHub ground, re-derived.
 *
 * The base theme chose these for another ground and the theme owns the pair
 * the moment it changes the ground (§4.3). They are promoted into the table,
 * not waived — by DESIGN.md's Re-Derived Lightness Rule, which is the rule for
 * exactly this: the hue survives the crossing, the lightness does not. The
 * editor's blue stays blue and its orange stays orange; only the lightness
 * moves, and only as far as the floor. A key whose alpha puts the floor out
 * of reach is promoted opaque: the theme owes the floor, not the veil.
 */
export function promotedColorsOf(variant, listed) {
  const out = {};
  for (const { key, value, surfaces, floor } of inheritedPairs(
    variant,
    listed,
  )) {
    const c = parseHex(value);
    if (surfaces.every((g) => contrast(c, g) >= floor)) continue;
    out[key] = toHex(reDerive(c, surfaces, floor));
  }
  return out;
}

/**
 * Lightness first, alpha only if it must: a veil the editor chose stays as
 * thin as the floor allows.
 */
function reDerive(c, surfaces, floor) {
  // Alpha is quantised to the byte the hex will carry, or the pair measured
  // here is not the pair the editor paints.
  for (
    let a = c.a;
    a <= 1.0001;
    a = Math.min(1, (Math.round(a * 255) + 5) / 255)
  ) {
    try {
      return reLightnessOn(
        { ...c, a: Math.round(a * 255) / 255 },
        surfaces,
        floor,
      );
    } catch {
      if (a >= 1) break;
    }
  }
  throw new Error(
    `no lightness reaches ${floor.toFixed(2)}:1 on every ground for ${toHex(c)}`,
  );
}

/** token → hex for one variant: the rule table, then the inherited sweep. */
export function colorsOf(variant) {
  const listed = listedColorsOf(variant);
  const colors = { ...listed, ...promotedColorsOf(variant, listed) };
  return Object.fromEntries(
    Object.keys(colors)
      .sort()
      .map((k) => [k, colors[k]]),
  );
}

function syntax(variant) {
  const p = palette(variant);
  const semanticTokenColors = {};
  const tokenColors = [];
  for (const row of VOICES) {
    const foreground = p[row.voice];
    for (const t of row.semantic)
      semanticTokenColors[t] = row.style
        ? { foreground, [row.style]: true }
        : foreground;
    tokenColors.push({
      name: row.name,
      scope: row.scopes,
      settings: row.style
        ? { foreground, fontStyle: row.style }
        : { foreground },
    });
  }
  return { semanticTokenColors, tokenColors };
}

/** The three theme files, keyed by their file name. */
export function derive() {
  const out = {};
  for (const [variant, v] of Object.entries(VARIANTS)) {
    out[v.file] = {
      $schema: "vscode://schemas/color-theme",
      name: v.label,
      type: v.type,
      semanticHighlighting: true,
      colors: colorsOf(variant),
      ...syntax(variant),
    };
  }
  return out;
}

/** The exact bytes a theme file carries: what prettier writes for this JSON. */
export const serialise = (value) => JSON.stringify(value, null, 2) + "\n";

if (process.argv[1] === import.meta.filename) {
  for (const [file, value] of Object.entries(derive())) {
    fs.writeFileSync(path.join(dir, file), serialise(value));
    const p = palette(
      Object.entries(VARIANTS).find(([, v]) => v.file === file)[0],
    );
    const g = parseHex(p.ground);
    console.log(
      `${file}: ground ${p.ground}, ink ${contrast(parseHex(p.ink), g).toFixed(2)}:1, dim ${contrast(parseHex(p["ink-dim"]), g).toFixed(2)}:1, ` +
        `accent ${p.accent} ${contrast(parseHex(p.accent), g).toFixed(2)}:1, error ${p.error} ${contrast(parseHex(p.error), g).toFixed(2)}:1, ` +
        `ΔE(accent,error) ${deltaE(parseHex(p.accent), parseHex(p.error)).toFixed(3)}`,
    );
  }
}

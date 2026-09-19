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
export const baseTokens = read("base-tokens.json");

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
    token: 4.5,
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
    token: 4.5,
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
    token: 7,
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

// ── The voices (§4.2, second table) ───────────────────────────────────────
// §11 open 1, closed in the real editor: three colours are all the palette
// gives syntax (crimson is One Synthetic, amber is the focus ring, the error
// red is `invalid`), so weight carries what a hue cannot — a call is bold ink,
// a keyword bold dim ink. Without it every identifier read as one grey word.
export const VOICES = [
  {
    name: "Types and namespaces",
    semantic: [
      "class",
      "interface",
      "enum",
      "record",
      "typeParameter",
      "namespace",
    ],
    from: "entity.name.type",
  },
  {
    name: "Declarations",
    semantic: ["method.declaration", "class.declaration"],
    from: "entity.name.function",
    style: "bold",
  },
  {
    name: "Calls",
    semantic: ["method", "function"],
    from: "entity.name.function",
  },
  {
    name: "Keywords and modifiers",
    semantic: ["keyword", "modifier"],
    from: "keyword.control",
  },
  {
    name: "The body of the code",
    semantic: ["variable", "property", "parameter"],
    from: "variable",
  },
  { name: "Operators", semantic: ["operator"], from: "keyword.operator" },
  {
    name: "Comments",
    semantic: ["comment"],
    from: "comment",
    style: "italic",
  },
  {
    voice: "copper",
    name: "Literals and annotations",
    semantic: ["string", "annotation", "annotationMember"],
    scopes: ["string", "storage.type.annotation"],
  },
  {
    name: "Numbers",
    semantic: ["number", "enumMember"],
    from: "constant.numeric",
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
/**
 * Two syntax voices that sit side by side in the same file have to read as two
 * colours. The number is `MIN_ACCENT_ERROR_DELTA_E`'s — roughly twice the
 * OKLab just-noticeable difference — applied to the voices instead of to
 * crimson and the error red.
 */
export const MIN_VOICE_DELTA_E = MIN_ACCENT_ERROR_DELTA_E;

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

/**
 * Dracula, as a substitution (§11 decision 20). Decision 18 took the editor's
 * *roles* — which scope means "a call", which means "a type" — and that half is
 * what made a buffer readable. Its hues were never the point, and VS Code's
 * blue-and-teal is no neighbour of a warm theme, so every base colour is
 * answered by the colour Dracula spends on the same role before the lightness
 * is re-derived.
 *
 * Red and purple are traded against Dracula's own table (decision 20): the
 * purple carried numbers, constants and storage and the red carried the regex
 * classes, and the numbers read better as the warmer of the two on this ground.
 * Dracula's red is also the one borrowed colour crimson pushes: `#ff5555` sits
 * ΔE 0.043 from it, under the floor, so the derivation rotates it to 0.051.
 *
 * Values follow Dracula and Alucard (Dracula Theme, MIT); they are read as a
 * colour scheme, nothing of the theme is vendored, and the test below fails if
 * the pinned editor ever emits a colour this table does not answer — a hue of
 * VS Code's own would otherwise reach a buffer unnoticed.
 */
export const HUES = {
  dark: {
    "#d4d4d4": "#ff79c6", // operators, embedded expressions
    "#ffffff": "#f8f8f2", // HC plain text
    "#c8c8c8": "#f8f8f2", // labels
    "#9cdcfe": "#f8f8f2", // variables, keys, attribute names
    "#4fc1ff": "#ff5555", // constants, enum members
    "#b5cea8": "#ff5555", // numbers
    "#569cd6": "#ff5555", // language constants, tags, storage
    "#c586c0": "#ff79c6", // control keywords
    "#dcdcaa": "#50fa7b", // functions
    "#4ec9b0": "#8be9fd", // types
    "#ce9178": "#f1fa8c", // strings (BatleHub's copper still wins on `string`)
    "#6a9955": "#6272a4", // comments
    "#7ca668": "#6272a4", // comments, HC
    "#d16969": "#bd93f9", // regex character classes
    "#d7ba7d": "#ffb86c", // CSS tags and classes, escapes
    "#646695": "#6272a4", // regex punctuation
    "#b46695": "#ff79c6", // regex punctuation, HC
    "#6796e6": "#8be9fd", // markdown list markers, HC headings
    "#808080": "#6272a4", // tag punctuation
    "#f44747": "#bd93f9", // invalid (BatleHub's error red still wins)
    "#000080": "#ff5555", // markdown headers, diff headers
    "#cbedcb": "#50fa7b", // search result context, HC
  },
  light: {
    "#000000ff": "#1f1f1f", // embedded expressions
    "#000000": "#a3144d", // operators, import modifiers
    "#001080": "#1f1f1f", // variables, object keys — the body
    "#0070c1": "#cb3a2a", // constants, enum members
    "#098658": "#cb3a2a", // numbers
    "#0000ff": "#cb3a2a", // language constants, preprocessor
    "#af00db": "#a3144d", // control keywords
    "#800080": "#a3144d", // markup italic
    "#795e26": "#14710a", // functions
    "#267f99": "#036a96", // types
    "#a31515": "#846e15", // strings (copper still wins on `string`)
    "#008000": "#6c664b", // comments
    "#800000": "#a34d14", // tags, selectors
    "#e50000": "#14710a", // attribute names
    "#811f3f": "#644ac9", // regex
    "#d16969": "#644ac9", // regex groups
    "#ee0000": "#a34d14", // regex anchors, escapes
    "#0451a5": "#036a96", // markdown quotes and list markers
    "#000080": "#cb3a2a", // diff headers, markup bold
    "#cd3131": "#644ac9", // invalid (the error red still wins)
  },
};

/** Dark and HC read one table; only `vs` reads light. */
export const huesOf = (variant) => HUES[variant === "light" ? "light" : "dark"];

/**
 * The editor's own colour for a scope, from the base theme this uiTheme
 * borrows (§4.2). The last rule naming the scope wins, which is the order VS
 * Code itself paints in — the flattened list of scripts/base-tokens.mjs keeps
 * it. An unknown scope is a typo in VOICES, so it throws rather than falling
 * back to a colour nobody chose.
 */
function baseColour(variant, scope) {
  const rules = baseTokens[VARIANTS[variant].uiTheme].tokenColors;
  let found;
  for (const rule of rules) {
    const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope ?? ""];
    // The scope as written, never a child of it: `keyword.control` is the
    // keyword colour, `keyword.control.anchor.regexp` is a regex detail, and
    // a prefix match would hand the language its regex colour.
    if (rule.settings?.foreground && scopes.includes(scope))
      found = rule.settings.foreground;
  }
  if (!found)
    throw new Error(
      `no base rule paints ${scope} in ${VARIANTS[variant].uiTheme}`,
    );
  return found;
}

/**
 * A borrowed colour, made BatleHub's: the hue is the editor's — decision 18,
 * the same trade as the error red and the ANSI palette — and the lightness is
 * re-derived on the BatleHub ground until it meets the token floor, because
 * the base theme chose its lightness for a ground this theme replaced. Two
 * rules hold on the way out: a borrowed colour never lands on crimson (One
 * Synthetic), and it stays ΔE ≥ 0.05 from it, so nothing in a buffer can be
 * read as the action colour. A colour too close rotates away from crimson's
 * hue in 1° steps, the error red's own escape.
 */
function borrow(variant, p, hex) {
  const ground = parseHex(p.ground);
  const accent = parseHex(p.accent);
  const target = FLOORS[variant].token;
  const base = parseHex(huesOf(variant)[hex.toLowerCase()] ?? hex);
  const held = reLightness(base, ground, target);
  if (deltaE(held, accent) >= MIN_VOICE_DELTA_E) return toHex(held);
  const { L, C, h } = toOklch(base);
  for (let step = 1; step <= 180; step++)
    for (const dir of [1, -1]) {
      const moved = reLightness(
        fromOklchClamped({ L, C, h: h + dir * step }),
        ground,
        target,
      );
      if (deltaE(moved, accent) >= MIN_VOICE_DELTA_E) return toHex(moved);
    }
  throw new Error(
    `no hue near ${hex} reaches ΔE ${MIN_VOICE_DELTA_E} from crimson`,
  );
}

/**
 * Syntax (§4.2, second half): the base theme's rules with every foreground
 * re-derived onto the BatleHub ground, then BatleHub's own rows on top —
 * copper for strings and annotations, the error red for `invalid`, italic for
 * comments. The base list comes first so that a BatleHub row of equal
 * specificity wins, which is how the editor resolves two rules for one scope.
 */
function syntax(variant) {
  const p = palette(variant);
  const base = baseTokens[VARIANTS[variant].uiTheme];
  const mine = (row) =>
    row.voice
      ? p[row.voice]
      : borrow(variant, p, baseColour(variant, row.from));

  const tokenColors = base.tokenColors.map((rule) => ({
    ...rule,
    settings: rule.settings.foreground
      ? {
          ...rule.settings,
          foreground: borrow(variant, p, rule.settings.foreground),
        }
      : { ...rule.settings },
  }));
  for (const row of VOICES) {
    if (!row.scopes && !row.style) continue; // semantic-only voices
    const scopes = row.scopes ?? [row.from];
    tokenColors.push({
      name: row.name,
      scope: scopes,
      settings: row.style
        ? { foreground: mine(row), fontStyle: row.style }
        : { foreground: mine(row) },
    });
  }

  const semanticTokenColors = Object.fromEntries(
    Object.entries(base.semanticTokenColors).map(([t, v]) => [
      t,
      typeof v === "string"
        ? borrow(variant, p, v)
        : { ...v, foreground: borrow(variant, p, v.foreground) },
    ]),
  );
  for (const row of VOICES) {
    const foreground = mine(row);
    for (const t of row.semantic)
      semanticTokenColors[t] = row.style
        ? { foreground, [row.style]: true }
        : foreground;
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

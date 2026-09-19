#!/usr/bin/env node
// Writes themes/base-defaults.json: the colour-registry defaults of vs, vs-dark
// and hc-black for the VS Code the heavy suite pins.
//
// Why a committed file: the theme sets the keys of RFC 0014 §4.2 and inherits
// every other one from the registry. An inherited foreground lands on a
// BatleHub background nobody chose it for, so the contrast test has to measure
// it — and the test runs in CI with no editor. This script is the one place
// that needs the editor build; it runs when the heavy suite's pin moves, and
// its output is reviewed in that PR.
//
//   node scripts/base-defaults.mjs --vscode <dir of the server-web build> [--version 1.136.1]
//
// The defaults live in the workbench bundle as registerColor() calls. Nothing
// is imported from it: the calls are read as text and evaluated against the
// colour model of scripts/color.mjs, with every minified name discovered from
// the bundle rather than hard-coded (a rename then fails loudly here instead of
// silently producing half a registry).

import fs from "node:fs";
import path from "node:path";
import {
  composite,
  darken,
  lighten,
  luminance,
  parseHex,
  toHex,
  transparent,
} from "./color.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i], process.argv[i + 1]);
const root = args.get("--vscode");
if (!root) {
  console.error(
    "usage: node scripts/base-defaults.mjs --vscode <server-web dir> [--version x.y.z]",
  );
  process.exit(2);
}
const bundlePath = path.join(
  root,
  "out/vs/workbench/workbench.web.main.internal.js",
);
const src = fs.readFileSync(bundlePath, "utf8");
const version =
  args.get("--version") ??
  JSON.parse(fs.readFileSync(path.join(root, "product.json"), "utf8")).version;

// ── 1. The minified names ────────────────────────────────────────────────
const registerColor = /\b(\w+)\("editor\.background",\{/.exec(src)?.[1];
if (!registerColor)
  throw new Error("registerColor not found: the bundle's shape changed");
const colorClass = /\b(\w+)\.fromHex\("/.exec(src)?.[1];
if (!colorClass)
  throw new Error("the Color class not found: the bundle's shape changed");
// `new Color(new RGBA(r, g, b, a))` is the other way a default names a colour.
// Color.transparent() is where the class hands its own RGBA back, so it names it.
const rgbaClass = /this\.rgba;return new \w+\(new (\w+)\(/.exec(src)?.[1];
if (!rgbaClass)
  throw new Error("the RGBA class not found: the bundle's shape changed");
// function X(a,b){return{op:N,...}} — the colour transforms, in registry order.
const ops = new Map();
for (const m of src.matchAll(/function (\w+)\(([\w,$.]*)\)\{return\{op:(\d)/g))
  ops.set(m[1], Number(m[3]));
const OP = {
  DARKEN: 0,
  LIGHTEN: 1,
  TRANSPARENT: 2,
  OPAQUE: 3,
  ONE_OF: 4,
  LESS_PROMINENT: 5,
  IF_DEFINED: 6,
};
for (const want of Object.values(OP)) {
  if (![...ops.values()].includes(want))
    throw new Error(`no transform helper for op ${want}`);
}

// ── 2. The registrations ─────────────────────────────────────────────────
/** Top-level arguments of the call whose "(" is at `open`. */
function callArgs(open) {
  let depth = 0,
    cur = "",
    out = [],
    quote = null;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      cur += c;
      if (c === "\\") cur += src[++j];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") ((quote = c), (cur += c));
    else if (c === "(" || c === "[" || c === "{")
      (depth++, depth > 1 && (cur += c));
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) return (out.push(cur), out);
      cur += c;
    } else if (c === "," && depth === 1) (out.push(cur), (cur = ""));
    else cur += c;
  }
  throw new Error("unbalanced call");
}

const byId = new Map(); // id → default expression (source text)
const varToId = new Map(); // minified variable → colour id
const call = new RegExp(`\\b${registerColor}\\("([a-zA-Z][\\w.]*)",`, "g");
for (const m of src.matchAll(call)) {
  const a = callArgs(m.index + registerColor.length);
  if (a.length < 2) continue;
  const id = m[1];
  byId.set(id, a[1].trim());
  const assign = /([\w$]+)\s*=\s*$/.exec(
    src.slice(Math.max(0, m.index - 40), m.index),
  );
  if (assign) varToId.set(assign[1], id);
}
// The sixteen ANSI colours are registered from a table, not one call each.
const ansi = [
  ...src.matchAll(/"(terminal\.ansi\w+)":\{index:\d+,defaults:(\{[^}]*\})\}/g),
];
if (ansi.length !== 16)
  throw new Error(`found ${ansi.length} ANSI colours, expected 16`);
for (const m of ansi) byId.set(m[1], m[2]);

if (byId.size < 500)
  throw new Error(
    `only ${byId.size} colours found: the bundle's shape changed`,
  );

// ── 3. Evaluating a default expression ───────────────────────────────────
// The values a default can take, as the registry models them.
const ref = (id) => ({ kind: "ref", id });
const lit = (rgba) => ({ kind: "color", rgba });

class Lit {
  constructor(rgba) {
    this.kind = "color";
    this.rgba = rgba;
  }
  transparent(f) {
    return new Lit(transparent(this.rgba, f));
  }
  darken(f) {
    return new Lit(darken(this.rgba, f));
  }
  lighten(f) {
    return new Lit(lighten(this.rgba, f));
  }
}
class Rgba {
  constructor(r = 0, g = 0, b = 0, a = 1) {
    Object.assign(this, { r, g, b, a });
  }
}
/** Callable as `new Color(rgba)`, and carrying the statics the defaults use. */
function ColorFacade(rgba) {
  return new Lit({ r: rgba.r, g: rgba.g, b: rgba.b, a: rgba.a });
}
Object.defineProperties(ColorFacade, {
  fromHex: { value: (s) => new Lit(parseHex(s)) },
  black: { get: () => new Lit({ r: 0, g: 0, b: 0, a: 1 }) },
  white: { get: () => new Lit({ r: 255, g: 255, b: 255, a: 1 }) },
  transparent: { get: () => new Lit({ r: 0, g: 0, b: 0, a: 0 }) },
  red: { get: () => new Lit({ r: 255, g: 0, b: 0, a: 1 }) },
  blue: { get: () => new Lit({ r: 0, g: 0, b: 255, a: 1 }) },
  green: { get: () => new Lit({ r: 0, g: 255, b: 0, a: 1 }) },
});

// Bare identifiers in a default are either another registered colour or a
// module constant; the constants are read back out of the bundle.
const constants = new Map();
/** The source text of the expression starting at `i`, to the next top-level break. */
function readExpr(i) {
  let depth = 0,
    quote = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return src.slice(i, j);
      depth--;
    } else if ((c === "," || c === ";") && depth === 0) return src.slice(i, j);
  }
  throw new Error("unterminated expression");
}

// A bare identifier in a default is either another registered colour (handled
// by the scope) or a module constant — a number, or a Color built once and
// shared. The constant's initialiser is read back out of the bundle and
// evaluated in the same scope.
function constantOf(name) {
  if (constants.has(name)) return constants.get(name);
  const decl = new RegExp(
    `[,;{}()\\s]${name.replace(/\$/g, "\\$")}=(?!=|>)`,
    "g",
  );
  for (const m of src.matchAll(decl)) {
    let value;
    try {
      value = evalExpr(readExpr(m.index + m[0].length));
    } catch {
      continue;
    }
    if (
      typeof value === "number" ||
      value instanceof Lit ||
      (value && value.kind)
    ) {
      constants.set(name, value);
      return value;
    }
  }
  throw new Error(`unresolved identifier "${name}" in a colour default`);
}

const scope = new Proxy(
  {},
  {
    has: () => true,
    get(_t, name) {
      if (typeof name !== "string") return undefined;
      if (name === colorClass) return ColorFacade;
      if (name === rgbaClass) return Rgba;
      if (name === "null" || name === "undefined") return undefined;
      if (ops.has(name)) {
        const op = ops.get(name);
        return (...values) => ({ kind: "transform", op, values });
      }
      if (varToId.has(name)) return ref(varToId.get(name));
      return constantOf(name);
    },
  },
);
function evalExpr(expr) {
  return new Function("scope", `with (scope) { return (${expr}); }`)(scope);
}

// ── 4. Resolving a value for one theme type ──────────────────────────────
const TYPES = { vs: "light", "vs-dark": "dark", "hc-black": "hcDark" };

function resolve(value, type, seen = new Set()) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string")
    return value.startsWith("#")
      ? parseHex(value)
      : resolve(ref(value), type, seen);
  if (value instanceof Lit) return value.rgba;
  if (value.kind === "color") return value.rgba;
  if (value.kind === "ref") {
    if (seen.has(value.id)) return null; // a cycle is a registry bug, not ours
    if (!byId.has(value.id)) return null;
    const next = new Set(seen).add(value.id);
    return resolve(defaultsOf(value.id)[type] ?? null, type, next);
  }
  if (value.kind === "transform") return transformOf(value, type, seen);
  throw new Error(`unknown colour value: ${JSON.stringify(value)}`);
}

function transformOf({ op, values }, type, seen) {
  const at = (i) => resolve(values[i], type, seen);
  switch (op) {
    case OP.DARKEN: {
      const c = at(0);
      return c && darken(c, values[1]);
    }
    case OP.LIGHTEN: {
      const c = at(0);
      return c && lighten(c, values[1]);
    }
    case OP.TRANSPARENT: {
      const c = at(0);
      return c && transparent(c, values[1]);
    }
    case OP.OPAQUE: {
      const c = at(0),
        bg = at(1);
      return c && bg && composite(c, bg);
    }
    case OP.ONE_OF: {
      for (const v of values) {
        const c = resolve(v, type, seen);
        if (c) return c;
      }
      return null;
    }
    case OP.LESS_PROMINENT: {
      const from = at(0);
      if (!from) return null;
      const bg = at(1);
      const [factor, transparency] = [values[2], values[3]];
      if (!bg) return transparent(from, factor * transparency);
      const moved =
        luminance(from) < luminance(bg)
          ? lighterThan(from, bg, factor)
          : darkerThan(from, bg, factor);
      return transparent(moved, transparency);
    }
    case OP.IF_DEFINED: {
      return at(0) ? at(1) : at(2);
    }
    default:
      throw new Error(`unknown transform op ${op}`);
  }
}

// Color.getLighterColor / getDarkerColor, as the registry uses them.
function lighterThan(of, relative, factor = 0.5) {
  const l1 = luminance(of),
    l2 = luminance(relative);
  if (l1 > l2) return of;
  return lighten(of, (factor * (l2 - l1)) / (l2 || 1));
}
function darkerThan(of, relative, factor = 0.5) {
  const l1 = luminance(of),
    l2 = luminance(relative);
  if (l1 < l2) return of;
  return darken(of, (factor * (l1 - l2)) / (l1 || 1));
}

const parsed = new Map();
function defaultsOf(id) {
  if (parsed.has(id)) return parsed.get(id);
  const expr = byId.get(id);
  const v = evalExpr(expr);
  let out;
  if (v === undefined || v === null) out = {};
  else if (v instanceof Lit || typeof v === "string" || v.kind)
    out = { light: v, dark: v, hcDark: v, hcLight: v };
  else out = v; // { light, dark, hcDark, hcLight }
  parsed.set(id, out);
  return out;
}

// ── 5. Write it out ──────────────────────────────────────────────────────
const out = { vscode: version, source: path.relative(root, bundlePath) };
for (const [uiTheme, type] of Object.entries(TYPES)) {
  const map = {};
  for (const id of [...byId.keys()].sort()) {
    let c = null;
    try {
      c = resolve(defaultsOf(id)[type] ?? null, type);
    } catch (e) {
      throw new Error(`${id} (${uiTheme}): ${e.message}`);
    }
    map[id] = c
      ? toHex({
          ...c,
          r: Math.round(c.r),
          g: Math.round(c.g),
          b: Math.round(c.b),
        })
      : null;
  }
  out[uiTheme] = map;
}
const dest = path.join(
  import.meta.dirname,
  "..",
  "themes",
  "base-defaults.json",
);
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
const set = Object.values(out["vs-dark"]).filter(Boolean).length;
console.log(
  `base-defaults.json: VS Code ${version}, ${Object.keys(out["vs-dark"]).length} colours (${set} with a dark default)`,
);

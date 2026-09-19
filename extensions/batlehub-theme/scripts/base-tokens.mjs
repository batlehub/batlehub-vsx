#!/usr/bin/env node
// Writes themes/base-tokens.json: the token colours of Dark+, Light+ and High
// Contrast Black for the VS Code the heavy suite pins.
//
// Why a committed file, and why these three: `tokenColors` are not inherited.
// A theme that names none paints every buffer in `editor.foreground`, so §4.2's
// syntax half is a choice of source, not a default — and RFC 0014 decision 18
// chose the editor's own, the same way decision 12 chose its error red and its
// ANSI palette. The colours are read here and re-derived onto the BatleHub
// ground by scripts/derive.mjs; this script is the only one that needs an
// editor build, and runs when the heavy suite's pin moves.
//
//   node scripts/base-tokens.mjs --vscode <dir of the server-web build> [--version x.y.z]
//
// The file it writes is reviewed in the PR that moves the pin: a token colour
// is a design decision of the editor's, and a silent change of one is a silent
// change of how BatleHub paints code.

import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i], process.argv[i + 1]);
const root = args.get("--vscode");
if (!root) {
  console.error(
    "usage: node scripts/base-tokens.mjs --vscode <server-web dir> [--version x.y.z]",
  );
  process.exit(2);
}

/** The base theme each `uiTheme` borrows from (RFC 0014 §4.2). */
const SOURCES = {
  "vs-dark": "dark_plus.json",
  vs: "light_plus.json",
  "hc-black": "hc_black.json",
};

const dir = path.join(root, "extensions", "theme-defaults", "themes");

/**
 * A theme and everything it includes, flattened. VS Code applies the included
 * file's rules first and the including file's after, and a later rule of equal
 * specificity wins — so the order here is the order the editor paints in.
 */
function load(file, seen = new Set()) {
  if (seen.has(file)) throw new Error(`include cycle at ${file}`);
  seen.add(file);
  const theme = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  const base = theme.include
    ? load(path.basename(theme.include), seen)
    : { tokenColors: [], semanticTokenColors: {} };
  return {
    tokenColors: [...base.tokenColors, ...(theme.tokenColors ?? [])],
    semanticTokenColors: {
      ...base.semanticTokenColors,
      ...(theme.semanticTokenColors ?? {}),
    },
  };
}

const version =
  args.get("--version") ??
  JSON.parse(fs.readFileSync(path.join(root, "product.json"), "utf8")).version;

const out = {
  vscode: version,
  source: Object.fromEntries(
    Object.entries(SOURCES).map(([ui, file]) => [
      ui,
      `extensions/theme-defaults/themes/${file}`,
    ]),
  ),
};
for (const [ui, file] of Object.entries(SOURCES)) out[ui] = load(file);

const target = path.join(
  import.meta.dirname,
  "..",
  "themes",
  "base-tokens.json",
);
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
for (const ui of Object.keys(SOURCES))
  console.log(
    `${ui}: ${out[ui].tokenColors.length} rules, ${Object.keys(out[ui].semanticTokenColors).length} semantic tokens (VS Code ${version})`,
  );

#!/usr/bin/env node
// Rewrite l10n/bundle.l10n.json from the `vscode.l10n.t("…")` literals of the
// sources: the `en` catalogue is the identity, kept as a file so a second
// language is a copy with the values translated (RFC 0001 §4.2 Localisation).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
for (const ext of process.argv.slice(2).length ? process.argv.slice(2) : ["java-core", "java-groovy"]) {
  const root = `extensions/${ext}`;
  let files;
  try {
    files = walk(`${root}/src`).filter((f) => f.endsWith(".ts"));
  } catch {
    continue;
  }
  const out = {};
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/l10n\.t\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)) {
      const k = (m[1] ?? m[2]).replace(/\\n/g, "\n").replace(/\\"/g, '"');
      out[k] = k;
    }
  }
  const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
  writeFileSync(`${root}/l10n/bundle.l10n.json`, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`${ext}: ${Object.keys(sorted).length} strings`);
}

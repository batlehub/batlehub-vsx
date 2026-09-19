#!/usr/bin/env node
// RFC 0001 §13, the `lint` job's non-localised-string check, for the Java
// family: every `title`/`description` in a manifest's `contributes` is a
// `%key%` of package.nls.json, and every `vscode.l10n.t("…")` literal of the
// sources is a key of l10n/bundle.l10n.json (the `en` catalogue, which is the
// identity — it exists so a second language is a file, not a refactor).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
let failed = false;
for (const ext of ["java-core", "java-groovy"]) {
  const root = `extensions/${ext}`;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  } catch {
    continue;
  }
  const nls = JSON.parse(readFileSync(`${root}/package.nls.json`, "utf8"));
  const bad = [];
  const check = (v, where) => {
    if (typeof v !== "string") return;
    if (!/^%[\w.-]+%$/.test(v)) bad.push(`${where}: "${v}" is not a %key%`);
    else if (!(v.slice(1, -1) in nls)) bad.push(`${where}: ${v} missing from package.nls.json`);
  };
  for (const c of pkg.contributes.commands ?? []) check(c.title, `command ${c.command}`);
  for (const [k, p] of Object.entries(pkg.contributes.configuration?.properties ?? {})) check(p.markdownDescription ?? p.description, `setting ${k}`);
  for (const [, views] of Object.entries(pkg.contributes.views ?? {})) for (const v of views) check(v.name, `view ${v.id}`);
  for (const v of pkg.contributes.viewsContainers?.activitybar ?? []) check(v.title, `container ${v.id}`);
  for (const m of pkg.contributes.submenus ?? []) check(m.label, `submenu ${m.id}`);
  const bundle = JSON.parse(readFileSync(`${root}/l10n/bundle.l10n.json`, "utf8"));
  const literals = new Set();
  for (const f of walk(`${root}/src`).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/l10n\.t\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)) literals.add((m[1] ?? m[2]).replace(/\\n/g, "\n").replace(/\\"/g, '"'));
  }
  for (const l of literals) if (!(l in bundle)) bad.push(`l10n: "${l.slice(0, 60)}" not in l10n/bundle.l10n.json`);
  if (bad.length) {
    failed = true;
    console.error(`${ext}:\n  ${bad.join("\n  ")}`);
  } else console.log(`${ext}: ${Object.keys(nls).length} nls keys, ${literals.size} runtime strings, all catalogued`);
}
process.exit(failed ? 1 : 0);

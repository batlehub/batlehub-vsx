#!/usr/bin/env node
// RFC 0001 §13, the `lint` job's settings-schema check: every
// `batlehub.java.*` key of java-core's package.json is a row of
// docs/guide/java/settings.md, and every row is a key. Fails on either
// direction so the docs and the schema cannot drift.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("extensions/java-core/package.json", "utf8"));
const declared = Object.keys(pkg.contributes.configuration.properties).sort();
const doc = readFileSync("docs/guide/java/settings.md", "utf8");
const documented = [...doc.matchAll(/^\| `(batlehub\.java\.[\w.]+)`/gm)].map((m) => m[1]).sort();
const missing = declared.filter((k) => !documented.includes(k));
const stale = documented.filter((k) => !declared.includes(k));
if (missing.length || stale.length) {
  if (missing.length) console.error(`in package.json but not in docs/guide/java/settings.md:\n  ${missing.join("\n  ")}`);
  if (stale.length) console.error(`in docs/guide/java/settings.md but not in package.json:\n  ${stale.join("\n  ")}`);
  process.exit(1);
}
console.log(`${declared.length} batlehub.java.* settings documented`);

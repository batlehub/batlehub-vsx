#!/usr/bin/env node
// RFC 0005 §6.4: the JSON Schema of `.batlehub/java/inspections.json`, written
// from the bundle itself — the rules its META-INF/services list loads, each
// one's `super("area", "id", "severity")` — so the editor's completion
// offers real ids and their defaults. Where a level is lower than the rule's
// default, the schema asks for a `why` as the profile does (§4.2), so the
// editor flags it before the extension reads the file. `--check` fails when
// the committed schema is not what the bundle gives (the `lint` job).
//
//   node scripts/inspections-schema.mjs [--check]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const SRC = "jdt/batlehub-jdt-core/src/main";
const OUT = "extensions/java-core/schema/java-inspections.schema.json";
const LEVELS = ["error", "warning", "info", "hint", "off"];
const RANK = { off: 0, hint: 1, info: 2, warning: 3, error: 4 };

const classes = readFileSync(`${SRC}/resources/META-INF/services/batlehub.jdt.core.Inspection`, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const rules = classes.map((c) => {
  const src = readFileSync(`${SRC}/java/${c.replaceAll(".", "/")}.java`, "utf8");
  const m = /super\("([^"]+)",\s*"([^"]+)",\s*"(error|warning|info|hint)"\)/.exec(src);
  if (!m) throw new Error(`${c}: no super("area", "id", "severity") call`);
  if (m[1] === "sonar") throw new Error(`${c}: the area "sonar" is the SonarLint bridge's (RFC 0005 §4.3)`);
  return { code: `${m[1]}/${m[2]}`, severity: m[3], cls: c.split(".").pop() };
});

/** One rule's entry; `def` is its default, `undefined` for a bridged rule (taken as error, decision 9). */
const rule = (description, def = "error") => {
  const lower = LEVELS.filter((l) => RANK[l] < RANK[def]);
  return {
    type: "object",
    description,
    required: ["severity"],
    additionalProperties: false,
    properties: {
      severity: { enum: LEVELS, description: `The team's level for this rule; the bundle's default is ${def}.` },
      why: { type: "string", description: "Why the team chose this level — required for off and for any level below the default, and shown beside the rule." },
      imported: { type: "string", description: "Set only by a program (the IntelliJ import): the why was generated, not argued." },
      options: { type: "object", description: "Reserved: no rule reads options yet." },
    },
    ...(lower.length
      ? {
          if: { properties: { severity: { enum: lower } } },
          then: {
            required: ["why"],
            properties: { why: { type: "string", pattern: "\\S", errorMessage: "a level below the default needs a why" } },
          },
        }
      : {}),
  };
};

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://batlehub.dev/schema/java-inspections.schema.json",
  title: "BatleHub Java inspection profile",
  description: "The team's severities for the BatleHub inspections (RFC 0005), committed and reviewed. Generated from the JDT bundle by scripts/inspections-schema.mjs.",
  type: "object",
  required: ["version", "rules"],
  additionalProperties: false,
  properties: {
    $schema: { type: "string" },
    version: { const: 1, description: "The format's version; this java-core reads 1." },
    rules: {
      type: "object",
      description: "area/ruleId → the team's level. A rule left out runs at its default.",
      properties: Object.fromEntries(rules.map((r) => [r.code, rule(`${r.code} (${r.cls}) — default ${r.severity}`, r.severity)])),
      patternProperties: { "^sonar/.+$": rule("A SonarLint rule, through the bridge (RFC 0016): sonar/<its own key>.") },
      additionalProperties: false,
    },
  },
};

const text = `${JSON.stringify(schema, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(OUT, "utf8");
  } catch {}
  if (committed !== text) {
    console.error(`${OUT} is not what the bundle gives: run 'node scripts/inspections-schema.mjs'`);
    process.exit(1);
  }
  console.log(`${rules.length} inspections in ${OUT}, current`);
} else {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`${rules.length} inspections → ${OUT}`);
}

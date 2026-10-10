import { describe, expect, it } from "vitest";
import {
  closest,
  differing,
  mergeSeverities,
  parseProfile,
  unwriteRules,
  validate,
  writeRules,
  type Severity,
} from "@batlehub/java-rules/profile";
import { applyOverrides, type Row } from "@batlehub/java-rules/rules";

// The eleven rules of the bundle and their declared severities (`batlehub.ping`'s `defaults`).
const DEFAULTS: Record<string, Severity> = {
  "unused/privateField": "warning",
  "unused/privateMethod": "warning",
  "style/redundantThis": "info",
  "collections/sizeIsZero": "info",
  "performance/stringConcatInLoop": "warning",
  "correctness/missingOverride": "warning",
  "correctness/objectsEqualsLiteral": "info",
  "performance/boxingConstructor": "warning",
  "correctness/emptyCatch": "warning",
  "style/booleanLiteralComparison": "info",
  "style/ifReturnBoolean": "info",
};
const KNOWN = Object.keys(DEFAULTS);

const check = (
  text: string,
  known: string[] | undefined = KNOWN,
  defaults = DEFAULTS,
) => {
  const p = parseProfile(text);
  return {
    ...p,
    ...(p.profile ? validate(p.profile, p.lines, known, defaults) : {}),
  };
};
const file = (rules: object) =>
  JSON.stringify({ $schema: "x", version: 1, rules }, null, 2);

describe("the profile file (RFC 0005 §4.1, §4.3)", () => {
  it("reads §1's example: an off with its reason, an upgrade, a downgrade with its reason", () => {
    const v = check(
      file({
        "style/redundantThis": {
          severity: "off",
          why: "house style writes this.x",
        },
        "performance/stringConcatInLoop": { severity: "error" },
        "correctness/emptyCatch": {
          severity: "info",
          why: "legacy module, #412",
        },
      }),
    );
    expect(v.problems).toEqual([]);
    expect(v.merged).toEqual({
      "style/redundantThis": "off",
      "performance/stringConcatInLoop": "error",
      "correctness/emptyCatch": "info",
    });
    expect(v.reasons!["style/redundantThis"]).toBe("house style writes this.x");
  });

  it("treats a file that does not parse, or another version, as absent — one error row", () => {
    for (const bad of [
      "{ nope",
      file({}).replace('"version": 1', '"version": 2'),
      "[]",
    ]) {
      const p = parseProfile(bad);
      expect(p.profile).toBeUndefined();
      expect(p.problems).toHaveLength(1);
      expect(p.problems[0]!.severity).toBe("error");
    }
  });

  it("accepts comments, as the editor writes JSONC", () => {
    const v = check(
      `{\n  // the team's\n  "version": 1,\n  "rules": { "style/redundantThis": { "severity": "warning" } }\n}`,
    );
    expect(v.problems).toEqual([]);
    expect(v.merged).toEqual({ "style/redundantThis": "warning" });
  });

  it("refuses off, or any downgrade, without a why — on the entry's line, the rest applied (use case 2)", () => {
    const text = file({
      "unused/privateField": { severity: "error" },
      "correctness/emptyCatch": { severity: "off" },
      "performance/boxingConstructor": { severity: "hint", why: "  " },
    });
    const v = check(text);
    expect(v.merged).toEqual({ "unused/privateField": "error" });
    expect(v.problems.map((p) => [p.line, p.key, p.message])).toEqual([
      [
        text.split("\n").findIndex((l) => l.includes("emptyCatch")),
        "correctness/emptyCatch",
        'correctness/emptyCatch: "off" needs a "why"',
      ],
      [
        text.split("\n").findIndex((l) => l.includes("boxingConstructor")),
        "performance/boxingConstructor",
        'performance/boxingConstructor: "hint" is below the rule\'s default (warning) and needs a "why"',
      ],
    ]);
  });

  it("asks a why for every downgrade from an unknown default, taken as error (decision 9)", () => {
    const v = check(
      file({ "style/redundantThis": { severity: "warning" } }),
      KNOWN,
      {},
    );
    expect(v.problems[0]!.message).toMatch(
      /below the rule's default \(error\)/,
    );
    expect(
      check(file({ "style/redundantThis": { severity: "error" } }), KNOWN, {})
        .problems,
    ).toEqual([]);
  });

  it("names an unknown rule with the closest id first, but only once the bundle has answered (use case 4)", () => {
    const text = file({ "style/ifReturnBool": { severity: "error" } });
    const v = check(text);
    expect(v.merged).toEqual({});
    expect(v.problems[0]!.message).toMatch(
      /^unknown rule style\/ifReturnBool — the loaded bundle has: style\/ifReturnBoolean, unused\/privateField/,
    );
    // Before the bundle answers there is no list to check against: no row.
    const p = parseProfile(text);
    expect(validate(p.profile!, p.lines, undefined, DEFAULTS).problems).toEqual(
      [],
    );
    expect(closest("style/ifReturnBool", KNOWN)).toBe("style/ifReturnBoolean");
  });

  it("refuses a bare ruleId and a severity it does not know, suggesting the full key", () => {
    const v = check(
      file({
        redundantThis: { severity: "off", why: "x" },
        "style/redundantThis": { severity: "loud" },
      }),
    );
    expect(v.problems.map((p) => p.message)).toEqual([
      "redundantThis: a rule is written area/ruleId — style/redundantThis; entry ignored",
      'style/redundantThis: "severity" must be one of error, warning, info, hint, off; entry ignored',
    ]);
  });

  it("accepts an imported reason and marks it; an unknown importer is one info row (use case 7)", () => {
    const v = check(
      file({
        "collections/sizeIsZero": {
          severity: "off",
          why: 'imported from IntelliJ profile "Project Default" (disabled there)',
          imported: "intellij",
        },
        "style/redundantThis": {
          severity: "off",
          why: "x",
          imported: "eclipse",
        },
      }),
    );
    expect(v.merged).toEqual({
      "collections/sizeIsZero": "off",
      "style/redundantThis": "off",
    });
    expect(v.imported).toEqual([
      "collections/sizeIsZero",
      "style/redundantThis",
    ]);
    expect(v.problems.map((p) => [p.severity, p.key])).toEqual([
      ["info", "style/redundantThis"],
    ]);
  });

  it("checks a bridged sonar/ key for its why, not its existence (use case 8)", () => {
    const v = check(
      file({
        "sonar/java:S1135": {
          severity: "off",
          why: "TODO comments are tracked in the forge",
        },
        "sonar/java:S100": { severity: "off" },
      }),
    );
    expect(v.merged).toEqual({ "sonar/java:S1135": "off" });
    expect(v.problems.map((p) => p.message)).toEqual([
      'sonar/java:S100: "off" needs a "why"',
    ]);
  });

  it("applies options-less, with one info row, a rule given options", () => {
    const v = check(
      file({
        "style/redundantThis": { severity: "warning", options: { x: 1 } },
      }),
    );
    expect(v.merged).toEqual({ "style/redundantThis": "warning" });
    expect(v.problems.map((p) => p.severity)).toEqual(["info"]);
  });
});

describe("precedence (RFC 0005 §4.2)", () => {
  const row = (code: string, severity: Row["severity"]): Row => ({
    ruleId: code.split("/")[1]!,
    area: code.split("/")[0]!,
    code,
    message: code,
    severity,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  });
  const rows = [
    row("style/redundantThis", "info"),
    row("performance/stringConcatInLoop", "warning"),
    row("unused/privateField", "warning"),
  ];
  const project = {
    "style/redundantThis": "off",
    "performance/stringConcatInLoop": "error",
  } as const;

  it("is override over profile over default, rule by rule, through applyOverrides unchanged", () => {
    const shown = (o: Record<string, string>) =>
      applyOverrides(rows, mergeSeverities(project, o)).map((r) => [
        r.code,
        r.severity,
      ]);
    expect(shown({})).toEqual([
      ["performance/stringConcatInLoop", "error"],
      ["unused/privateField", "warning"],
    ]);
    // use case 3: the developer's override wins in the editor, keyed either way
    expect(shown({ "style/redundantThis": "warning" })).toContainEqual([
      "style/redundantThis",
      "warning",
    ]);
    expect(shown({ redundantThis: "warning" })).toContainEqual([
      "style/redundantThis",
      "warning",
    ]);
    expect(shown({ privateField: "off" })).toEqual([
      ["performance/stringConcatInLoop", "error"],
    ]);
  });

  it("marks what the developer's overrides change, and nothing they agree with", () => {
    expect(
      differing(project, {
        redundantThis: "warning",
        "performance/stringConcatInLoop": "error",
        "unused/privateField": "off",
      }),
    ).toEqual(["style/redundantThis"]);
    expect(differing(project, {})).toEqual([]);
  });
});

describe("a program's writes and their undo (RFC 0005 §6.6)", () => {
  it("creates the file with $schema and version, and records what each key replaced", () => {
    const w = writeRules(undefined, {
      "style/redundantThis": { severity: "off", why: "" },
    });
    expect(JSON.parse(w.text)).toEqual({
      $schema: "https://batlehub.dev/schema/java-inspections.schema.json",
      version: 1,
      rules: { "style/redundantThis": { severity: "off", why: "" } },
    });
    expect(w.previous).toEqual({ "style/redundantThis": null });
  });

  it("keeps comments and other keys, and gives back the replaced entry", () => {
    const text = `{\n  // ours\n  "version": 1,\n  "rules": {\n    "unused/privateField": { "severity": "error" }, // why not\n    "style/redundantThis": { "severity": "info" }\n  }\n}\n`;
    const w = writeRules(text, {
      "style/redundantThis": {
        severity: "off",
        why: "imported",
        imported: "intellij",
      },
    });
    expect(w.text).toContain("// ours");
    expect(w.text).toContain("// why not");
    expect(w.previous).toEqual({ "style/redundantThis": { severity: "info" } });
    expect(parseProfile(w.text).profile!.rules["style/redundantThis"]).toEqual({
      severity: "off",
      why: "imported",
      imported: "intellij",
    });
  });

  it("undoes only the entries still as written, and deletes a file it created only when empty", () => {
    const created = writeRules(undefined, {
      "a/x": { severity: "off", why: "i", imported: "intellij" },
      "a/y": { severity: "off", why: "i", imported: "intellij" },
    });
    const entries = {
      "a/x": {
        written: { severity: "off" as const, why: "i", imported: "intellij" },
        previous: null,
      },
      "a/y": {
        written: { severity: "off" as const, why: "i", imported: "intellij" },
        previous: null,
      },
    };
    expect(unwriteRules(created.text, entries, true)).toEqual({
      text: null,
      kept: [],
    });
    // a person argued a/y since: it is kept, the file with it
    const edited = writeRules(created.text, {
      "a/y": { severity: "off", why: "we agreed, #9" },
    }).text;
    const u = unwriteRules(edited, entries, true);
    expect(u.kept).toEqual(["a/y"]);
    expect(Object.keys(parseProfile(u.text!).profile!.rules)).toEqual(["a/y"]);
    // on a file the family did not create, the replaced entry comes back
    const before = file({ "a/x": { severity: "warning" } });
    const w = writeRules(before, { "a/x": { severity: "off", why: "i" } });
    const back = unwriteRules(
      w.text,
      {
        "a/x": {
          written: { severity: "off", why: "i" },
          previous: w.previous["a/x"]!,
        },
      },
      false,
    );
    expect(parseProfile(back.text!).profile!.rules).toEqual({
      "a/x": { severity: "warning" },
    });
  });
});

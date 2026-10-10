import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseProjectFile,
  resolve,
  saveToProject,
} from "@batlehub/java-rules/project-config";
import { PROJECT_KEYS } from "@batlehub/java-rules/project-keys";

const EXAMPLE = `{
  "$schema": "https://batlehub.dev/schema/java-project.schema.json", // shipped in the VSIX too
  "version": 1,
  "jdk": { "requirement": "21" },
  "maven": {
    "configuration": "corp",
    "configurations": [{ "name": "corp", "settingsFile": "~/.m2/settings-corp.xml" }],
    "activeProfiles": ["dev"]
  },
  "gradle": { "activeProfiles": [] },
  "registry": { "enabled": "ask" },
  "satellites": { "java-quarkus": { "devPort": 8081 } }
}`;

describe("project.json (RFC 0006 §4.1, §4.3)", () => {
  it("reads §4.1's file, comments included, every key with its value", () => {
    const p = parseProjectFile(EXAMPLE);
    expect(p.problems).toEqual([]);
    expect(p.values).toEqual({
      "jdk.requirement": "21",
      "maven.configuration": "corp",
      "maven.configurations": [
        { name: "corp", settingsFile: "~/.m2/settings-corp.xml" },
      ],
      "maven.activeProfiles": ["dev"],
      "gradle.activeProfiles": [],
      "registry.enabled": "ask",
    });
    expect(p.satellites).toEqual({ "java-quarkus": { devPort: 8081 } });
  });

  it("treats a file that does not parse as absent, with one error at the parse position", () => {
    const p = parseProjectFile(
      '{\n  "version": 1,\n  "maven": { "activeProfiles": ["dev" }\n}',
    );
    expect(p.values).toEqual({});
    expect(p.problems).toEqual([
      {
        path: "",
        line: 2,
        severity: "error",
        message:
          "project.json does not parse: the whole file is ignored until it does",
      },
    ]);
  });

  it("drops a key that fails the schema, on its line, and applies the rest", () => {
    const text = `{
  "version": 1,
  "jdk": { "requirement": "twenty-one" },
  "maven": { "activeProfiles": "dev", "configurations": [{ "settingsFile": "x" }], "configuration": "corp", "cache": true },
  "registry": { "enabled": true },
  "build": {}
}`;
    const p = parseProjectFile(text);
    expect(p.values).toEqual({ "maven.configuration": "corp" });
    expect(p.problems.map((x) => [x.path, x.line, x.message])).toEqual([
      [
        "jdk.requirement",
        2,
        "jdk.requirement must match ^[0-9]+$; treated as absent",
      ],
      [
        "maven.activeProfiles",
        3,
        "maven.activeProfiles must be an array; treated as absent",
      ],
      [
        "maven.configurations",
        3,
        'maven.configurations item 0 needs "name"; treated as absent',
      ],
      ["maven.cache", 3, 'unknown key "maven.cache"; ignored'],
      [
        "registry.enabled",
        4,
        "registry.enabled must be one of ask, true, false; treated as absent",
      ],
      [
        "build",
        5,
        'unknown section "build" (known: jdk, maven, gradle, registry, satellites); ignored',
      ],
    ]);
  });

  it("reads a newer version for the keys it knows, and says so", () => {
    const p = parseProjectFile(
      '{ "version": 2, "maven": { "activeProfiles": ["dev"] } }',
    );
    expect(p.values).toEqual({ "maven.activeProfiles": ["dev"] });
    expect(p.problems[0]!.message).toMatch(
      /version 2; this java-core reads version 1/,
    );
  });

  it("walks exactly the schema's keys (the generated table is current)", () => {
    const schema = JSON.parse(
      readFileSync(
        path.join(__dirname, "..", "schema", "java-project.schema.json"),
        "utf8",
      ),
    );
    const fromSchema = Object.entries(
      schema.properties as Record<
        string,
        { type?: string; additionalProperties?: unknown; properties?: object }
      >,
    )
      .filter(
        ([, s]) => s.type === "object" && s.additionalProperties === false,
      )
      .flatMap(([sec, s]) =>
        Object.keys(s.properties!).map((k) => `${sec}.${k}`),
      );
    expect(Object.keys(PROJECT_KEYS).sort()).toEqual(fromSchema.sort());
  });
});

describe("the precedence (RFC 0006 §4.2)", () => {
  const project = parseProjectFile(EXAMPLE).values;
  it("is settings over project.json over detection over the default, per key, with origins", () => {
    const r = resolve({ "maven.activeProfiles": ["dev", "fast"] }, project, {
      "jdk.requirement": "17",
      "maven.configuration": "default",
    });
    expect(r["maven.activeProfiles"]).toEqual({
      value: ["dev", "fast"],
      origin: "settings",
      project: ["dev"],
      differsFromProject: true,
    });
    expect(r["jdk.requirement"]).toEqual({
      value: "21",
      origin: "project.json",
      project: "21",
    });
    expect(r["maven.configuration"]).toEqual({
      value: "corp",
      origin: "project.json",
      project: "corp",
    });
    const bare = resolve({}, {}, { "maven.configuration": "default" });
    expect(bare["maven.configuration"]).toEqual({
      value: "default",
      origin: "detected",
    });
    expect(bare["registry.enabled"]).toEqual({
      value: "ask",
      origin: "default",
    });
    expect(bare["jdk.requirement"]).toBeUndefined();
  });
  it("marks nothing when the setting says what the project says", () => {
    expect(
      resolve({ "maven.activeProfiles": ["dev"] }, project, {})[
        "maven.activeProfiles"
      ],
    ).toEqual({ value: ["dev"], origin: "settings", project: ["dev"] });
  });
  it("gives the engine, which passes no settings, the project's values", () => {
    const r = resolve({}, project, {});
    expect(r["maven.activeProfiles"]!.value).toEqual(["dev"]);
    expect(Object.values(r).some((x) => x?.origin === "settings")).toBe(false);
  });
});

describe("Save to project (RFC 0006 §4.2)", () => {
  it("creates the file with $schema and version", () => {
    expect(
      JSON.parse(saveToProject(undefined, { "maven.activeProfiles": ["dev"] })),
    ).toEqual({
      $schema: "https://batlehub.dev/schema/java-project.schema.json",
      version: 1,
      maven: { activeProfiles: ["dev"] },
    });
  });
  it("keeps comments and unknown keys, and removes a key and its emptied section", () => {
    const text = saveToProject(
      saveToProject(EXAMPLE, { "maven.activeProfiles": ["dev", "it"] }),
      { "jdk.requirement": undefined },
    );
    expect(text).toContain("// shipped in the VSIX too");
    expect(text).toContain('"satellites"');
    const p = parseProjectFile(text);
    expect(p.values["maven.activeProfiles"]).toEqual(["dev", "it"]);
    expect(p.values["jdk.requirement"]).toBeUndefined();
    expect(text).not.toContain('"jdk"');
  });
});

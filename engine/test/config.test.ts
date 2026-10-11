import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../cli.ts";
import {
  committedBase,
  printedProfile,
  projectConfig,
  requiredJava,
  teamProfile,
} from "../config.ts";
import { readOrUndefined } from "../ops.ts";

const bundle = {
  inspections: ["unused/privateField", "style/redundantThis"],
  defaults: {
    "unused/privateField": "warning",
    "style/redundantThis": "info",
  } as const,
};

const made: string[] = [];
afterAll(() =>
  made.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

/** A workspace with the given files, relative path → content. */
function ws(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "engine-config-"));
  made.push(root);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), text);
  }
  return root;
}

describe("the team profile on the command line (RFC 0005 phase 4)", () => {
  it("reads the committed file and validates it against the running bundle", () => {
    const root = ws({
      ".batlehub/java/inspections.json": JSON.stringify({
        version: 1,
        rules: {
          "style/redundantThis": { severity: "off", why: "house style" },
          "unused/privateFeild": { severity: "error" },
        },
      }),
    });
    const p = teamProfile(root, bundle, readOrUndefined);
    expect(p.levels).toEqual({ "style/redundantThis": "off" });
    expect(p.reasons).toEqual({ "style/redundantThis": "house style" });
    expect(p.problems.map((x) => x.message)[0]).toMatch(
      /unknown rule unused\/privateFeild — the loaded bundle has: unused\/privateField/,
    );
    const printed = printedProfile(p);
    expect(printed.rules["style/redundantThis"]).toEqual({
      level: "off",
      origin: "profile",
      default: "info",
      why: "house style",
    });
    expect(printed.rules["unused/privateField"]).toEqual({
      level: "warning",
      origin: "default",
      default: "warning",
    });
  });

  it("finds the committed files above a module root, never past .git", () => {
    const root = ws({
      ".git/HEAD": "ref: refs/heads/main",
      ".batlehub/java/inspections.json": JSON.stringify({
        version: 1,
        rules: { "unused/privateField": { severity: "error" } },
      }),
      "core/pom.xml": "<project/>",
    });
    expect(committedBase(path.join(root, "core"))).toBe(root);
    expect(
      teamProfile(path.join(root, "core"), bundle, readOrUndefined).levels,
    ).toEqual({ "unused/privateField": "error" });
    const outside = ws({ "a/.git/HEAD": "", "a/core/pom.xml": "" });
    mkdirSync(path.join(outside, ".batlehub", "java"), { recursive: true });
    expect(committedBase(path.join(outside, "a", "core"))).toBe(
      path.join(outside, "a", "core"),
    );
  });

  it("is the bundle's defaults with no committed file, and refuses a named one that is missing or broken", () => {
    const root = ws({ "broken.json": "{ version: 2 " });
    expect(teamProfile(root, bundle, readOrUndefined).levels).toEqual({});
    expect(() =>
      teamProfile(root, bundle, readOrUndefined, path.join(root, "none.json")),
    ).toThrow(/no such profile/);
    expect(() =>
      teamProfile(
        root,
        bundle,
        readOrUndefined,
        path.join(root, "broken.json"),
      ),
    ).toThrow(/not an inspection profile/);
  });
});

describe("config --print (RFC 0006 use case 6)", () => {
  it("resolves project.json with no settings layer, the build file's floor detected", () => {
    const root = ws({
      "pom.xml":
        "<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>",
      ".batlehub/java/project.json": JSON.stringify({
        version: 1,
        maven: { activeProfiles: ["dev"] },
      }),
    });
    const c = projectConfig(root, readOrUndefined);
    expect(c.problems).toEqual([]);
    expect(c.config["maven.activeProfiles"]).toEqual({
      value: ["dev"],
      origin: "project.json",
      project: ["dev"],
    });
    expect(c.config["jdk.requirement"]).toEqual({
      value: "21",
      origin: "detected",
    });
    expect(c.config["registry.enabled"]).toEqual({
      value: "ask",
      origin: "default",
    });
  });

  it("reads a Gradle build's toolchain when there is no pom", () => {
    const root = ws({
      "build.gradle.kts":
        "java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }",
    });
    expect(requiredJava(root, readOrUndefined)).toBe(17);
  });

  it("degrades a malformed key to its default and reports it; --print is required", async () => {
    const root = ws({
      "pom.xml": "<project/>",
      ".batlehub/java/project.json":
        '{ "version": 1, "maven": { "activeProfiles": "dev" } }',
    });
    const c = projectConfig(root, readOrUndefined);
    expect(c.config["maven.activeProfiles"]).toEqual({
      value: [],
      origin: "default",
    });
    expect(c.problems.map((p) => [p.line, p.severity, p.path])).toEqual([
      [0, "warning", "maven.activeProfiles"],
    ]);
    // Refused before any workspace is looked for.
    expect(
      await main(
        ["config", root],
        () => {},
        () => {},
      ),
    ).toBe(2);
  });
});

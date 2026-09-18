import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDependencies, parseTasks } from "../src/build/gradle/tasks";
import { flatten } from "../src/build/maven/deptree";

// Real output of Gradle 8.14.5 (mise, JDK 21) on tests/heavy/fixtures/gradle-multi,
// captured 2026-09-18 — what the provider actually parses, not a hand-written shape.
const fx = (n: string) =>
  readFileSync(path.join(__dirname, "fixtures", n), "utf8");

describe("Gradle 8.14.5's real output", () => {
  it("tasks --all: groups and descriptions of a two-module build", () => {
    const t = parseTasks(fx("gradle-tasks-all.txt"));
    const by = Object.fromEntries(t.map((x) => [x.name, x]));
    expect(by["app:build"]).toEqual({
      name: "app:build",
      group: "build",
      description: "Assembles and tests this project.",
    });
    expect(by["app:run"]?.group).toBe("application");
    expect(by["wrapper"]?.group).toBe("build setup");
    expect(t.length).toBeGreaterThan(40);
    expect(t.every((x) => /^[\w:-]+$/.test(x.name))).toBe(true);
  });
  it("dependencies: project references, constraints (c) and repeats (*)", () => {
    const rt = parseDependencies(fx("gradle-dependencies.txt"))!;
    expect(rt.children.map((c) => c.artifactId)).toEqual([":core"]);
    const test = parseDependencies(
      fx("gradle-test-dependencies.txt"),
      "testRuntimeClasspath",
    )!;
    const all = flatten(test);
    expect(
      all.some(
        (n) => n.artifactId === "junit-jupiter" && n.version === "5.11.4",
      ),
    ).toBe(true);
    expect(all.some((n) => n.artifactId === "junit-platform-launcher")).toBe(
      true,
    );
    expect(all.some((n) => n.omitted === "duplicate")).toBe(true);
    expect(all.filter((n) => n.omitted === "conflict")).toEqual([]);
  });
});

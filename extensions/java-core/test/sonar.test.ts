import { describe, expect, it } from "vitest";
import {
  sonarCapMiB,
  pendingOffs,
  sonarJavaHome,
  toRows,
  toSonarRules,
} from "../src/inspections/sonar";

const r = { start: { line: 3, character: 0 }, end: { line: 3, character: 20 } };

describe("SonarLint bridged for breadth (RFC 0016 phase 1)", () => {
  it("reads SonarLint 5.9.0's diagnostics — source sonarqube — into sonar/<ruleKey> rows (phase 0, decision 12)", () => {
    expect(
      toRows([
        {
          source: "sonarqube",
          code: "java:S1135",
          severity: 2,
          message: "Complete the task associated to this TODO comment.",
          range: r,
        },
        {
          source: "sonarqube",
          code: { value: "java:S2699" },
          severity: 1,
          message: "Add at least one assertion to this test case.",
          range: r,
        },
        {
          source: "Java",
          code: 536870973,
          severity: 1,
          message: "The value of the local variable x is not used",
          range: r,
        },
        {
          source: "batlehub",
          code: "unused/privateField",
          severity: 1,
          message: "x",
          range: r,
        },
        { source: "sonarqube", severity: 1, message: "no code", range: r },
      ]),
    ).toEqual([
      {
        ruleId: "java:S1135",
        area: "sonar",
        code: "sonar/java:S1135",
        message: "Complete the task associated to this TODO comment.",
        severity: "info",
        range: r,
      },
      {
        ruleId: "java:S2699",
        area: "sonar",
        code: "sonar/java:S2699",
        message: "Add at least one assertion to this test case.",
        severity: "warning",
        range: r,
      },
    ]);
  });
  it("counts the server at the user's -Xmx, else the estimate (no -Xmx by default, decision 14)", () => {
    expect(sonarCapMiB(undefined, 768)).toBe(768);
    expect(sonarCapMiB("-XX:+UseG1GC", 768)).toBe(768);
    expect(sonarCapMiB("-Xmx1g -XX:+UseG1GC", 768)).toBe(1024);
  });
});

describe("sonar: the two writes (RFC 0016 phase 2)", () => {
  const runtimes = [
    { major: 25, path: "/jdk/25" },
    { major: 21, path: "/jdk/21" },
    { major: 11, path: "/jdk/11" },
  ];
  it("javaHome: the newest JDK 17+, only for a build without its own JRE, only when enabled", () => {
    expect(sonarJavaHome({ hasJre: false, enabled: true, runtimes })).toBe(
      "/jdk/25",
    );
    expect(
      sonarJavaHome({ hasJre: true, enabled: true, runtimes }),
    ).toBeUndefined();
    expect(
      sonarJavaHome({ hasJre: false, enabled: false, runtimes }),
    ).toBeUndefined();
    expect(
      sonarJavaHome({
        hasJre: false,
        enabled: true,
        runtimes: [{ major: 11, path: "/jdk/11" }],
      }),
    ).toBeUndefined();
  });
  it("rules: the profile's sonar/* offs not yet in sonarlint.rules are pending; a key the user names is theirs", () => {
    const levels = {
      "sonar/java:S1135": "off",
      "sonar/java:S1155": "off",
      "sonar/java:S100": "warning",
      "style/redundantThis": "off",
    };
    expect(pendingOffs(levels, undefined)).toEqual([
      "java:S1135",
      "java:S1155",
    ]);
    expect(pendingOffs(levels, { "java:S1155": { level: "on" } })).toEqual([
      "java:S1135",
    ]);
    expect(pendingOffs({ "sonar/java:S100": "warning" }, {})).toEqual([]);
  });
  it("rules: a key not shaped like a Sonar rule never reaches the settings object (§7)", () => {
    expect(
      pendingOffs({ "sonar/../../x": "off", "sonar/java:S1": "off" }, {}),
    ).toEqual(["java:S1"]);
  });
  it("rules: the offs merged into the user's own value, every key of theirs kept", () => {
    expect(
      toSonarRules({ "java:S100": { level: "on" } }, ["java:S1135"]),
    ).toEqual({
      "java:S100": { level: "on" },
      "java:S1135": { level: "off" },
    });
  });
});

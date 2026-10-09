import { describe, expect, it } from "vitest";
import { sonarCapMiB, toRows } from "../src/inspections/sonar";

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

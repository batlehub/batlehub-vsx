import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planDiffs, readPlan, summary } from "../src/idea/import";
import {
  activeProfile,
  parseIdeaProfile,
  RULES,
  toProfilePlan,
} from "../src/idea/profile";

const FIXTURE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "tests",
  "heavy",
  "fixtures",
  "maven-multi",
);

describe("the IntelliJ inspection profile (RFC 0007 phase 4)", () => {
  it("maps only to rules the bundle ships", () => {
    const schema = JSON.parse(
      readFileSync(
        path.join(__dirname, "..", "schema", "java-inspections.schema.json"),
        "utf8",
      ),
    ) as { properties: { rules: { properties: Record<string, unknown> } } };
    const shipped = Object.keys(schema.properties.rules.properties);
    for (const codes of Object.values(RULES))
      for (const c of codes) expect(shipped, c).toContain(c);
  });

  it("reads the fixture's active profile into imported entries, and counts the rest", () => {
    const plan = readPlan(FIXTURE, new Set(["inspections"]));
    expect(plan.errors).toEqual([]);
    expect(plan.inspections?.rules).toEqual({
      "collections/sizeIsZero": {
        severity: "off",
        why: 'imported from IntelliJ profile "Project Default" (disabled there)',
        imported: "intellij",
      },
      "performance/stringConcatInLoop": {
        severity: "error",
        why: 'imported from IntelliJ profile "Project Default" (ERROR there)',
        imported: "intellij",
      },
    });
    expect(plan.inspections?.unmapped).toEqual([
      "ConstantValue",
      "SpellCheckingInspection",
    ]);
    const lines = summary(plan);
    expect(lines[0]).toBe(
      'inspection profile   2 rules mapped from "Project Default", 1 disabled with an imported reason',
    );
    expect(lines).toContain(
      "  - 2 IDEA inspections have no bundle rule (listed in the log)",
    );
    const [diff] = planDiffs(plan, {});
    expect(diff?.target).toBe(".batlehub/java/inspections.json");
    expect(
      JSON.parse(diff!.after).rules["collections/sizeIsZero"].severity,
    ).toBe("off");
  });

  it("maps one IDEA id to several rules, levels, and an unknown level", () => {
    const p = toProfilePlan(
      parseIdeaProfile(`<component><profile version="1.0">
        <option name="myName" value="Team" />
        <inspection_tool class="UnusedDeclaration" enabled="true" level="WEAK WARNING" />
        <inspection_tool class="UnnecessaryThis" enabled="true" level="TYPO" />
      </profile></component>`),
    );
    expect(Object.keys(p.rules)).toEqual([
      "unused/privateField",
      "unused/privateMethod",
    ]);
    expect(p.rules["unused/privateField"]?.severity).toBe("info");
    expect(p.skipped).toEqual([
      { option: "UnnecessaryThis", reason: "level TYPO has no equivalent" },
    ]);
  });

  it("follows profiles_settings.xml, and refuses what IDEA ignores", () => {
    expect(activeProfile(undefined)).toEqual({ name: "Project Default" });
    expect(
      activeProfile(
        '<settings><option name="PROJECT_PROFILE" value="Team" /></settings>',
      ),
    ).toEqual({ name: "Team" });
    expect(
      activeProfile(
        '<settings><option name="USE_PROJECT_PROFILE" value="false" /></settings>',
      ),
    ).toHaveProperty("error");
    expect(() => parseIdeaProfile("<component/>")).toThrow(/no <profile>/);
  });
});

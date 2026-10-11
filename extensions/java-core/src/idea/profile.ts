// `.idea/inspectionProfiles/` → the team's profile of RFC 0005 (RFC 0007
// §4.2 "Inspection profile", §6.5). Pure, like `codestyle.ts`: it parses
// strings and returns strings, and `import.ts` does every read and write.
import type { ProfileRule, Severity } from "@batlehub/java-rules/profile";
import type { Skipped } from "./codestyle";

export interface IdeaTool {
  id: string;
  enabled: boolean;
  level?: string;
}

/**
 * IDEA inspection id → the bundle's rule ids. Checked against the rules the
 * bundle ships (the generated schema) by a unit test, and grows with them.
 */
export const RULES: Record<string, string[]> = {
  UnusedDeclaration: ["unused/privateField", "unused/privateMethod"],
  SizeReplaceableByIsEmpty: ["collections/sizeIsZero"],
  StringConcatenationInLoop: ["performance/stringConcatInLoop"],
  MissingOverrideAnnotation: ["correctness/missingOverride"],
  EmptyCatchBlock: ["correctness/emptyCatch"],
  PointlessBooleanExpression: ["style/booleanLiteralComparison"],
  RedundantIfStatement: ["style/ifReturnBoolean"],
  UnnecessaryBoxing: ["performance/boxingConstructor"],
  ObjectEqualsNull: ["correctness/objectsEqualsLiteral"],
  UnnecessaryThis: ["style/redundantThis"],
};

const LEVELS: Record<string, Severity> = {
  ERROR: "error",
  WARNING: "warning",
  "WEAK WARNING": "info",
  INFORMATION: "hint",
  INFO: "hint",
};

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

/** One `inspectionProfiles/<name>.xml`: its name and its `<inspection_tool>`s. */
export function parseIdeaProfile(xml: string): {
  name: string;
  tools: IdeaTool[];
} {
  if (!/<profile\b/.test(xml)) throw new Error("no <profile> element");
  const name =
    /<option\s+name="myName"\s+value="([^"]*)"/.exec(xml)?.[1] ??
    "Project Default";
  const tools: IdeaTool[] = [];
  for (const m of xml.matchAll(/<inspection_tool\b([^>]*?)\/?>/g)) {
    const id = attr(m[1]!, "class");
    if (!id) continue;
    tools.push({
      id,
      enabled: attr(m[1]!, "enabled") !== "false",
      level: attr(m[1]!, "level"),
    });
  }
  return { name, tools };
}

/**
 * `profiles_settings.xml`: the profile IDEA uses for this project, or an
 * error when IDEA ignores the project's profiles (`USE_PROJECT_PROFILE`
 * false) — importing one would enforce what the IDEA users do not see.
 */
export function activeProfile(
  settingsXml: string | undefined,
): { name: string } | { error: string } {
  const opt = (n: string) =>
    settingsXml === undefined
      ? undefined
      : new RegExp(`<option\\s+name="${n}"\\s+value="([^"]*)"`).exec(
          settingsXml,
        )?.[1];
  if (opt("USE_PROJECT_PROFILE") === "false")
    return {
      error:
        "profiles_settings.xml says USE_PROJECT_PROFILE=false — IDEA ignores the project's inspection profiles, so importing one would enforce what your IDEA users do not see",
    };
  return { name: opt("PROJECT_PROFILE") ?? "Project Default" };
}

export interface ProfilePlan {
  /** The IDEA profile's name, for the report and the reasons. */
  name: string;
  /** What `writeProfileEntries` receives: every rule marked imported. */
  rules: Record<string, ProfileRule>;
  /** IDEA ids with no bundle rule: counted in the plan, listed in the log. */
  unmapped: string[];
  skipped: Skipped[];
}

/**
 * The profile's tools through `RULES` (§4.2): a disabled tool is `off`, an
 * enabled one its level. Every entry carries a reason nobody wrote, so it is
 * marked `imported` and RFC 0005's view shows it as such until a person
 * rewrites it.
 */
export function toProfilePlan(profile: {
  name: string;
  tools: IdeaTool[];
}): ProfilePlan {
  const rules: Record<string, ProfileRule> = {};
  const unmapped: string[] = [];
  const skipped: Skipped[] = [];
  for (const t of profile.tools) {
    const codes = RULES[t.id];
    if (!codes) {
      unmapped.push(t.id);
      continue;
    }
    const level = t.enabled ? LEVELS[t.level ?? "WARNING"] : "off";
    if (!level) {
      skipped.push({
        option: t.id,
        reason: `level ${t.level} has no equivalent`,
      });
      continue;
    }
    const why = t.enabled
      ? `imported from IntelliJ profile "${profile.name}" (${t.level ?? "WARNING"} there)`
      : `imported from IntelliJ profile "${profile.name}" (disabled there)`;
    for (const code of codes)
      rules[code] = { severity: level, why, imported: "intellij" };
  }
  return { name: profile.name, rules, unmapped: unmapped.sort(), skipped };
}

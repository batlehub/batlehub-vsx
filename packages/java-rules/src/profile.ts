// The team's inspection profile, `.batlehub/java/inspections.json` (RFC
// 0005): parse, validate against the loaded bundle, merge with the
// developer's overrides, and the text edits a program makes to it. Pure, and
// shared: the editor, the command line and the live-editor tools call the
// same functions (RFC 0005 §5.1, RFC 0002 decision 7).
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  type Node,
  type ParseError,
} from "jsonc-parser";

export type Severity = "error" | "warning" | "info" | "hint";
export type Level = Severity | "off";

export interface ProfileRule {
  severity: Level;
  why?: string;
  /** Written only by a program (RFC 0007): the `why` is nobody's argument. */
  imported?: string;
  /** Reserved: no rule reads options yet (§3). */
  options?: Record<string, unknown>;
}

export interface Profile {
  version: 1;
  rules: Record<string, ProfileRule>;
}

/** A row on the profile file (§4.3): 0-based line, the Problems panel's. */
export interface ProfileProblem {
  line: number;
  severity: "error" | "warning" | "info";
  key?: string;
  message: string;
}

const LEVELS: readonly Level[] = ["error", "warning", "info", "hint", "off"];
const RANK: Record<Level, number> = {
  off: 0,
  hint: 1,
  info: 2,
  warning: 3,
  error: 4,
};
/** Bridged analysers' prefixes (RFC 0005 §4.1, RFC 0016): never a bundle area. */
export const BRIDGES = ["sonar"] as const;
export const IMPORTERS = ["intellij"] as const;

const lineOf = (text: string, offset: number) =>
  text.slice(0, offset).split("\n").length - 1;

/** The hard errors of §4.3: a file that does not parse, or a version that is not 1, is no profile at all. */
export function parseProfile(text: string): {
  profile?: Profile;
  problems: ProfileProblem[];
  /** The 0-based line of each rule key, for the rows `validate()` produces. */
  lines: Record<string, number>;
} {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || !tree || tree.type !== "object")
    return {
      problems: [
        {
          line: errors.length ? lineOf(text, errors[0]!.offset) : 0,
          severity: "error",
          message:
            "inspections.json does not parse: the profile is ignored until it does",
        },
      ],
      lines: {},
    };
  const version = findNodeAtLocation(tree, ["version"]);
  if (!version || getNodeValue(version) !== 1)
    return {
      problems: [
        {
          line: version ? lineOf(text, version.offset) : 0,
          severity: "error",
          message: `inspections.json: "version" must be 1 (this java-core reads version 1): the profile is ignored`,
        },
      ],
      lines: {},
    };
  const rulesNode = findNodeAtLocation(tree, ["rules"]);
  const lines: Record<string, number> = {};
  const rules: Record<string, ProfileRule> = {};
  for (const prop of rulesNode?.type === "object"
    ? (rulesNode.children ?? [])
    : []) {
    const [k, v] = prop.children as [Node, Node];
    const key = String(getNodeValue(k));
    lines[key] = lineOf(text, k.offset);
    rules[key] = getNodeValue(v) as ProfileRule;
  }
  return { profile: { version: 1, rules }, problems: [], lines };
}

/** Levenshtein over a short list: the closest known id, for the message (§4.3). */
export function closest(key: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const k of known) {
    const d = distance(key, k);
    if (d < bestD) [best, bestD] = [k, d];
  }
  return best;
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[b.length]!;
}

export interface Validated {
  /** What `applyOverrides` takes for the project's layer: code → level. */
  merged: Record<string, Level>;
  /** code → the reason shown beside the rule. */
  reasons: Record<string, string>;
  /** codes whose reason was written by a program, not argued (§4.1). */
  imported: string[];
  problems: ProfileProblem[];
}

/**
 * The warnings of §4.3 and the `why` rule. `known` is the loaded bundle's
 * `area/id` list (undefined until the bundle answers: no unknown-rule rows
 * yet); `defaults` its declared severities — an absent default is `error`,
 * so every lower level needs a reason (decision 9). `sonar/*` keys are
 * checked for shape and `why` only: the bridge, not the bundle, knows them.
 */
export function validate(
  profile: Profile,
  lines: Record<string, number>,
  known: string[] | undefined,
  defaults: Record<string, Severity> = {},
): Validated {
  const out: Validated = {
    merged: {},
    reasons: {},
    imported: [],
    problems: [],
  };
  const row = (
    key: string,
    severity: ProfileProblem["severity"],
    message: string,
  ) => out.problems.push({ line: lines[key] ?? 0, severity, key, message });
  for (const [key, rule] of Object.entries(profile.rules)) {
    if (!key.includes("/")) {
      const guess = known?.find((k) => k.endsWith(`/${key}`));
      row(
        key,
        "warning",
        `${key}: a rule is written area/ruleId${guess ? ` — ${guess}` : ""}; entry ignored`,
      );
      continue;
    }
    const bridged = (BRIDGES as readonly string[]).includes(key.split("/")[0]!);
    if (!bridged && known && !known.includes(key)) {
      const near = closest(key, known);
      row(
        key,
        "warning",
        `unknown rule ${key} — the loaded bundle has: ${[near, ...known.filter((k) => k !== near)].join(", ")}; entry ignored`,
      );
      continue;
    }
    if (
      !rule ||
      typeof rule !== "object" ||
      !LEVELS.includes(rule.severity as Level)
    ) {
      row(
        key,
        "warning",
        `${key}: "severity" must be one of ${LEVELS.join(", ")}; entry ignored`,
      );
      continue;
    }
    const level = rule.severity;
    const def = defaults[key] ?? "error";
    const why = typeof rule.why === "string" ? rule.why.trim() : "";
    if (RANK[level] < RANK[def] && !why) {
      row(
        key,
        "warning",
        level === "off"
          ? `${key}: "off" needs a "why"`
          : `${key}: "${level}" is below the rule's default (${def}) and needs a "why"`,
      );
      continue;
    }
    out.merged[key] = level;
    if (why) out.reasons[key] = why;
    if (rule.imported !== undefined) {
      out.imported.push(key);
      if (!(IMPORTERS as readonly string[]).includes(rule.imported))
        row(
          key,
          "info",
          `${key}: "imported" is "${rule.imported}", not a known importer (${IMPORTERS.join(", ")}); marked imported all the same`,
        );
    }
    if (rule.options !== undefined)
      row(
        key,
        "info",
        `${key}: no rule reads "options" yet; applied without them`,
      );
  }
  return out;
}

/**
 * The layer `applyOverrides` receives (§4.2): the developer's overrides over
 * the project's levels over the bundle's defaults. Agents and CI call it with
 * `{}` for the overrides, so the project's word is final there.
 */
export function mergeSeverities(
  project: Record<string, Level>,
  overrides: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...project };
  for (const [k, v] of Object.entries(overrides)) {
    // An override keyed by the bare ruleId wins over the project's area/ruleId.
    const full = Object.keys(project).find((p) => p.endsWith(`/${k}`));
    if (full && !k.includes("/")) delete out[full];
    out[k] = v;
  }
  return out;
}

/** The codes whose override changes the project's level: the "differs from project" marker (§4.2). */
export function differing(
  project: Record<string, Level>,
  overrides: Record<string, string>,
): string[] {
  return Object.entries(project)
    .filter(([code, level]) => {
      const o = overrides[code] ?? overrides[code.split("/").pop()!];
      return o !== undefined && o !== level;
    })
    .map(([code]) => code)
    .sort();
}

const FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n" };
export const SCHEMA_URL =
  "https://batlehub.dev/schema/java-inspections.schema.json";

/**
 * A program's write (RFC 0005 §6.6): each rule of `patch` set (or removed,
 * for `null`), comments and every other key kept. Returns the new text and
 * what each key was before, for the manifest.
 */
export function writeRules(
  text: string | undefined,
  patch: Record<string, ProfileRule | null>,
): { text: string; previous: Record<string, ProfileRule | null> } {
  let out =
    text ??
    `${JSON.stringify({ $schema: SCHEMA_URL, version: 1, rules: {} }, null, 2)}\n`;
  const previous: Record<string, ProfileRule | null> = {};
  for (const [key, rule] of Object.entries(patch)) {
    const node = findNodeAtLocation(parseTree(out)!, ["rules", key]);
    previous[key] = node ? (getNodeValue(node) as ProfileRule) : null;
    out = applyEdits(
      out,
      modify(out, ["rules", key], rule ?? undefined, {
        formattingOptions: FORMAT,
      }),
    );
  }
  return { text: out, previous };
}

/**
 * The replay of a `profile` manifest entry (§6.6): a key still as written goes
 * back to what it replaced, or away; a key a person edited since is kept and
 * listed. `null` when the file was created by the family and has no rule left.
 */
export function unwriteRules(
  text: string,
  entries: Record<
    string,
    { written: ProfileRule; previous: ProfileRule | null }
  >,
  created: boolean,
): { text: string | null; kept: string[] } {
  let out = text;
  const kept: string[] = [];
  for (const [key, { written, previous }] of Object.entries(entries)) {
    const node = findNodeAtLocation(parseTree(out)!, ["rules", key]);
    const now = node ? getNodeValue(node) : undefined;
    if (JSON.stringify(now) !== JSON.stringify(written)) {
      if (now !== undefined) kept.push(key);
      continue;
    }
    out = applyEdits(
      out,
      modify(out, ["rules", key], previous ?? undefined, {
        formattingOptions: FORMAT,
      }),
    );
  }
  const rules = findNodeAtLocation(parseTree(out)!, ["rules"]);
  const empty = !rules?.children?.length;
  return { text: created && empty ? null : out, kept };
}

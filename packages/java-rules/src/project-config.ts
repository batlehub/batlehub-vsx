// `.batlehub/java/project.json`, the team's committed configuration (RFC
// 0006): parse and validate it against the key table generated from its
// schema, resolve it against the developer's settings and detection — the
// one place that knows the precedence — and the text edit `Save to project`
// makes. Pure: the editor passes its settings, the engine passes `{}`.
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  type Node,
  type ParseError,
} from "jsonc-parser";
import { PROJECT_KEYS, PROJECT_SECTIONS } from "./project-keys.ts";

export type ProjectKey = keyof typeof PROJECT_KEYS;
/** The file's values by dotted key (`maven.activeProfiles`); a key it does not name is absent. */
export type ProjectValues = Partial<Record<ProjectKey, unknown>>;

export interface ProjectProblem {
  /** The dotted key, or the section, or "" for the file itself. */
  path: string;
  /** 0-based, the Problems panel's. */
  line: number;
  severity: "error" | "warning";
  message: string;
}

export const PROJECT_SCHEMA_URL =
  "https://batlehub.dev/schema/java-project.schema.json";

const lineOf = (text: string, offset: number) =>
  text.slice(0, offset).split("\n").length - 1;

type Leaf = (typeof PROJECT_KEYS)[ProjectKey];

/** Why a value does not fit its key, or undefined when it does. */
function misfit(leaf: Leaf, v: unknown): string | undefined {
  if ("enum" in leaf)
    return (leaf.enum as readonly unknown[]).includes(v)
      ? undefined
      : `must be one of ${leaf.enum.join(", ")}`;
  if (leaf.type === "string") {
    if (typeof v !== "string") return "must be a string";
    if ("pattern" in leaf && !new RegExp(leaf.pattern).test(v))
      return `must match ${leaf.pattern}`;
    return undefined;
  }
  if (leaf.type === "array") {
    if (!Array.isArray(v)) return "must be an array";
    const items = (leaf as { items: { type: string } }).items;
    if (items.type === "string")
      return v.every((x) => typeof x === "string")
        ? undefined
        : "must be an array of strings";
    const { required, properties } = items as unknown as {
      required: string[];
      properties: Record<string, string>;
    };
    for (const [i, x] of v.entries()) {
      if (!x || typeof x !== "object" || Array.isArray(x))
        return `item ${i} must be an object`;
      for (const r of required) if (!(r in x)) return `item ${i} needs "${r}"`;
      for (const [k, val] of Object.entries(x)) {
        const t = properties[k];
        if (!t) return `item ${i}: unknown key "${k}"`;
        const ok =
          t === "string[]"
            ? Array.isArray(val) && val.every((s) => typeof s === "string")
            : typeof val === t;
        if (!ok)
          return `item ${i}: "${k}" must be ${t === "string[]" ? "an array of strings" : `a ${t}`}`;
      }
    }
    return undefined;
  }
  return undefined;
}

/**
 * §4.3: a file that does not parse is absent, with one error at the parse
 * position; a key that fails the schema is absent, with one warning on its
 * line, and every other key applies. A newer `version` is read for the keys
 * this core knows, with a warning.
 */
export function parseProjectFile(text: string): {
  values: ProjectValues;
  satellites: Record<string, unknown>;
  problems: ProjectProblem[];
} {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  const empty = { values: {}, satellites: {} };
  if (errors.length || !tree || tree.type !== "object")
    return {
      ...empty,
      problems: [
        {
          path: "",
          line: errors.length ? lineOf(text, errors[0]!.offset) : 0,
          severity: "error",
          message:
            "project.json does not parse: the whole file is ignored until it does",
        },
      ],
    };
  const problems: ProjectProblem[] = [];
  const values: ProjectValues = {};
  let satellites: Record<string, unknown> = {};
  for (const prop of tree.children ?? []) {
    const [k, v] = prop.children as [Node, Node];
    const name = String(getNodeValue(k));
    const at = lineOf(text, k.offset);
    if (name === "$schema") continue;
    if (name === "version") {
      const ver = getNodeValue(v);
      if (ver !== 1)
        problems.push({
          path: "version",
          line: at,
          severity: "warning",
          message: `project.json is version ${JSON.stringify(ver)}; this java-core reads version 1 and applies the keys it knows`,
        });
      continue;
    }
    if (!(PROJECT_SECTIONS as readonly string[]).includes(name)) {
      problems.push({
        path: name,
        line: at,
        severity: "warning",
        message: `unknown section "${name}" (known: ${PROJECT_SECTIONS.join(", ")}); ignored`,
      });
      continue;
    }
    if (v.type !== "object") {
      problems.push({
        path: name,
        line: at,
        severity: "warning",
        message: `"${name}" must be an object; ignored`,
      });
      continue;
    }
    if (name === "satellites") {
      satellites = getNodeValue(v) as Record<string, unknown>;
      continue;
    }
    for (const leafProp of v.children ?? []) {
      const [lk, lv] = leafProp.children as [Node, Node];
      const key = `${name}.${String(getNodeValue(lk))}`;
      const line = lineOf(text, lk.offset);
      const leaf = PROJECT_KEYS[key as ProjectKey];
      if (!leaf) {
        problems.push({
          path: key,
          line,
          severity: "warning",
          message: `unknown key "${key}"; ignored`,
        });
        continue;
      }
      const value = getNodeValue(lv);
      const why = misfit(leaf, value);
      if (why) {
        problems.push({
          path: key,
          line,
          severity: "warning",
          message: `${key} ${why}; treated as absent`,
        });
        continue;
      }
      values[key as ProjectKey] = value;
    }
  }
  return { values, satellites, problems };
}

/** What a key is when nobody says anything (§4.1); undefined: detection's or nothing. */
export const PROJECT_DEFAULTS: ProjectValues = {
  "maven.activeProfiles": [],
  "gradle.activeProfiles": [],
  "registry.enabled": "ask",
};

export type Origin = "settings" | "project.json" | "detected" | "default";

export interface Resolved {
  value: unknown;
  origin: Origin;
  /** The file's value, when the file names the key. */
  project?: unknown;
  /** Set when a setting overrides a value the file names (the panel's marker). */
  differsFromProject?: true;
}

/**
 * The precedence of §4.2, and nothing else: settings over project.json over
 * detection over the default. The editor passes its merged settings; RFC
 * 0002's engine passes `{}`, so the two differ exactly where a developer's
 * setting overrides the project.
 */
export function resolve(
  settings: ProjectValues,
  project: ProjectValues,
  detected: ProjectValues,
): Record<ProjectKey, Resolved | undefined> {
  const out = {} as Record<ProjectKey, Resolved | undefined>;
  for (const key of Object.keys(PROJECT_KEYS) as ProjectKey[]) {
    const p = project[key];
    const named = p !== undefined;
    let r: Resolved | undefined;
    if (settings[key] !== undefined)
      r = {
        value: settings[key],
        origin: "settings",
        ...(named ? { project: p } : {}),
        ...(named && JSON.stringify(settings[key]) !== JSON.stringify(p)
          ? { differsFromProject: true as const }
          : {}),
      };
    else if (named) r = { value: p, origin: "project.json", project: p };
    else if (detected[key] !== undefined)
      r = { value: detected[key], origin: "detected" };
    else if (PROJECT_DEFAULTS[key] !== undefined)
      r = { value: PROJECT_DEFAULTS[key], origin: "default" };
    out[key] = r;
  }
  return out;
}

/**
 * `Save to project` (§4.2): each dotted key of `patch` set, or removed for
 * `undefined`; the file created with `$schema` and `version` when there is
 * none; comments and unknown keys kept, as `launch.json` is edited.
 */
export function saveToProject(
  text: string | undefined,
  patch: ProjectValues,
): string {
  let out =
    text ??
    `${JSON.stringify({ $schema: PROJECT_SCHEMA_URL, version: 1 }, null, 2)}\n`;
  for (const [key, value] of Object.entries(patch)) {
    out = applyEdits(
      out,
      modify(out, key.split("."), value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
      }),
    );
    // A section left empty by a removal goes too.
    const section = key.split(".")[0]!;
    const node = findNodeAtLocation(parseTree(out)!, [section]);
    if (
      value === undefined &&
      node?.type === "object" &&
      !node.children?.length
    )
      out = applyEdits(out, modify(out, [section], undefined, {}));
  }
  return out;
}

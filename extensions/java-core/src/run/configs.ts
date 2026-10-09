// Run configurations are `.vscode/launch.json` entries of `type: "java"`
// (RFC 0001 §4.2): read and written through jsonc-parser's edits so comments,
// unknown keys and formatting survive the round trip. BatleHub's own fields
// live under `"batlehub": {}` inside the entry and the debugger ignores them.
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export interface JavaLaunch {
  type: "java";
  name: string;
  request: "launch" | "attach";
  mainClass?: string;
  projectName?: string;
  args?: string | string[];
  vmArgs?: string | string[];
  env?: Record<string, string>;
  cwd?: string;
  preLaunchTask?: string;
  hostName?: string;
  port?: number;
  console?: string;
  batlehub?: { template?: string; profile?: string; mavenProfiles?: string[] };
  [k: string]: unknown;
}

export interface LaunchFile {
  configurations: Record<string, unknown>[];
  errors: ParseError[];
}

const FORMAT = {
  formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
};

export function readLaunch(text: string | undefined): LaunchFile {
  if (!text?.trim()) return { configurations: [], errors: [] };
  const errors: ParseError[] = [];
  const doc = parse(text, errors, { allowTrailingComma: true }) as
    { configurations?: unknown } | undefined;
  const configurations = Array.isArray(doc?.configurations)
    ? (doc!.configurations as Record<string, unknown>[])
    : [];
  return { configurations, errors };
}

export const javaConfigs = (f: LaunchFile): JavaLaunch[] =>
  f.configurations.filter(
    (c): c is JavaLaunch => c.type === "java" && typeof c.name === "string",
  );

const SKELETON = `{
  // Use IntelliSense to learn about possible attributes.
  "version": "0.2.0",
  "configurations": []
}
`;

/** Add or replace (by name) one entry; a missing file gets the skeleton. Unknown keys of the replaced entry are kept. */
export function upsertConfig(
  text: string | undefined,
  config: JavaLaunch,
): string {
  let t = text?.trim() ? text : SKELETON;
  const file = readLaunch(t);
  const i = file.configurations.findIndex(
    (c) => c.name === config.name && c.type === config.type,
  );
  if (i < 0)
    return applyEdits(
      t,
      modify(t, ["configurations", file.configurations.length], config, {
        ...FORMAT,
        isArrayInsertion: true,
      }),
    );
  // Key by key, so the entry's other keys and the comments between them survive.
  for (const [k, v] of Object.entries(config))
    t = applyEdits(t, modify(t, ["configurations", i, k], v, FORMAT));
  return t;
}

/** Like `upsertConfig` for any entry type (a satellite's template), replaced by name and type. */
export function upsertLaunch(
  text: string | undefined,
  entry: { type: string; name: string },
): string {
  return upsertConfig(text, entry as JavaLaunch);
}

const TASKS_SKELETON = `{
  "version": "2.0.0",
  "tasks": []
}
`;

/** `tasks.json`: add or replace one task by label, comments and unknown keys kept (RFC 0011 §6.2, RFC 0004). */
export function upsertTask(
  text: string | undefined,
  task: { label: string; [k: string]: unknown },
): string {
  let t = text?.trim() ? text : TASKS_SKELETON;
  const errors: ParseError[] = [];
  const doc = parse(t, errors, { allowTrailingComma: true }) as
    { tasks?: unknown } | undefined;
  const tasks = Array.isArray(doc?.tasks)
    ? (doc!.tasks as { label?: unknown }[])
    : [];
  const i = tasks.findIndex((x) => x.label === task.label);
  if (i < 0)
    return applyEdits(
      t,
      modify(t, ["tasks", tasks.length], task, {
        ...FORMAT,
        isArrayInsertion: true,
      }),
    );
  for (const [k, v] of Object.entries(task))
    t = applyEdits(t, modify(t, ["tasks", i, k], v, FORMAT));
  return t;
}

export function removeConfig(text: string, name: string): string {
  const file = readLaunch(text);
  const i = file.configurations.findIndex(
    (c) => c.name === name && c.type === "java",
  );
  if (i < 0) return text;
  return applyEdits(
    text,
    modify(text, ["configurations", i], undefined, FORMAT),
  );
}

/** The templates the run editor offers (§12 phase 4); `{{ }}` are the form's fields. */
export const TEMPLATES: {
  id: string;
  label: string;
  make: (p: { mainClass: string; projectName: string }) => JavaLaunch;
}[] = [
  {
    id: "application",
    label: "Application (main class)",
    make: (p) => ({
      type: "java",
      name: `Run ${p.mainClass.split(".").pop() ?? p.mainClass}`,
      request: "launch",
      mainClass: p.mainClass,
      projectName: p.projectName,
      batlehub: { template: "application" },
    }),
  },
  {
    id: "remote",
    label: "Remote (attach to a JVM on a port)",
    make: (p) => ({
      type: "java",
      name: `Attach ${p.projectName || "remote"}`,
      request: "attach",
      hostName: "localhost",
      port: 5005,
      projectName: p.projectName,
      batlehub: { template: "remote" },
    }),
  },
];

/** A copy: "<name> (copy)", the whole entry carried, BatleHub's origin kept. */
export function duplicate(c: JavaLaunch): JavaLaunch {
  return { ...c, name: `${c.name} (copy)` };
}

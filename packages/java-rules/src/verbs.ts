// The five tools of RFC 0002 §4.2, one table both surfaces render: the live
// editor (phase 0, `server.ts`) and later the stdio engine and its CLI.
// No `vscode`: it moves to `packages/java-rules` with phase 1, when the
// engine is the second consumer.

export type Surface = "live" | "stdio";

interface Arg {
  type: "string" | "integer" | "boolean" | "array";
  doc: string;
  required?: boolean;
  enum?: string[];
  /** Per surface: the live editor applies unsaved edits, the command line writes to disk (§4.2, decision 6). */
  default?: unknown | Record<Surface, unknown>;
}

export interface Verb {
  name: string;
  doc: string;
  args: Record<string, Arg>;
  /** Refused before workspace trust and outside Standard mode (§6.4). */
  needsServer: boolean;
}

const dryRun: Arg = {
  type: "boolean",
  doc: "Return the WorkspaceEdit without applying it. In the live editor an applied edit is unsaved and undoable in one step; nothing is ever saved by the tool.",
  default: { live: false, stdio: true },
};
const paths: Arg = {
  type: "array",
  doc: "Files or directories, relative to the workspace root (default: the whole workspace). Directories are searched for *.java.",
};

export const VERBS: Verb[] = [
  {
    name: "java_status",
    doc: "The JDK and Java language server this workspace runs on, the server mode, and whether the BatleHub JDT bundle is loaded.",
    args: {},
    needsServer: false,
  },
  {
    name: "java_inspect",
    doc: "The BatleHub inspections of Java files, one row per finding, at the project's severities (not the developer's personal overrides; a row they change is marked differsFromEditor).",
    args: { paths },
    needsServer: true,
  },
  {
    name: "java_fix",
    doc: "Apply every inspection fix in the given files, or only one rule's fixes, as one edit.",
    args: {
      paths,
      rule: {
        type: "string",
        doc: "A rule code such as collections/sizeIsZero (default: every rule with a fix).",
      },
      dryRun,
    },
    needsServer: true,
  },
  {
    name: "java_generate",
    doc: "Generate getters and/or setters for the fields of the type at a line, with no prompt.",
    args: {
      what: {
        type: "string",
        enum: ["accessors", "getters", "setters"],
        doc: "accessors = getters and setters.",
        required: true,
      },
      file: {
        type: "string",
        doc: "The Java file, relative to the workspace root.",
        required: true,
      },
      line: {
        type: "integer",
        doc: "1-based line inside the type to generate for.",
        required: true,
      },
      getterPrefix: { type: "string", doc: "Getter prefix (default get)." },
      booleanPrefix: {
        type: "string",
        doc: "Getter prefix of a boolean field (default is).",
      },
      fluentSetters: {
        type: "boolean",
        doc: "Setters return this (default false).",
      },
      dryRun,
    },
    needsServer: true,
  },
  {
    name: "java_rename",
    doc: "Rename a symbol across the workspace, every module and every caller included, through the Java language server.",
    args: {
      symbol: {
        type: "string",
        doc: "Fully.Qualified.Type, Fully.Qualified.Type#member, or path:line:col (1-based).",
        required: true,
      },
      newName: { type: "string", doc: "The new name.", required: true },
      dryRun,
    },
    needsServer: true,
  },
];

const byName = new Map(VERBS.map((v) => [v.name, v]));

function defaultOf(a: Arg, surface: Surface): unknown {
  return a.default && typeof a.default === "object" && surface in a.default
    ? (a.default as Record<Surface, unknown>)[surface]
    : a.default;
}

/** MCP `tools/list` entries for one surface. */
export function toolSchemas(surface: Surface) {
  return VERBS.map((v) => ({
    name: v.name,
    description: v.doc,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(v.args).map(([k, a]) => {
          const d = defaultOf(a, surface);
          return [
            k,
            {
              type: a.type,
              description: a.doc,
              ...(a.type === "array" ? { items: { type: "string" } } : {}),
              ...(a.enum ? { enum: a.enum } : {}),
              ...(d === undefined ? {} : { default: d }),
            },
          ];
        }),
      ),
      required: Object.entries(v.args)
        .filter(([, a]) => a.required)
        .map(([k]) => k),
      additionalProperties: false,
    },
  }));
}

/** The arguments of a call, checked against the table and given their defaults; throws one readable line. */
export function checkArgs(
  name: string,
  args: Record<string, unknown> | undefined,
  surface: Surface,
): Record<string, unknown> {
  const v = byName.get(name);
  if (!v) throw new Error(`unknown tool ${name}`);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args ?? {}))
    if (!(k in v.args)) throw new Error(`${name}: unknown argument ${k}`);
  for (const [k, a] of Object.entries(v.args)) {
    const x = args?.[k] ?? defaultOf(a, surface);
    if (x === undefined) {
      if (a.required) throw new Error(`${name}: ${k} is required`);
      continue;
    }
    const ok =
      a.type === "array"
        ? Array.isArray(x) && x.every((s) => typeof s === "string")
        : a.type === "integer"
          ? Number.isInteger(x)
          : typeof x === a.type;
    if (!ok) throw new Error(`${name}: ${k} must be ${a.type}`);
    if (a.enum && !a.enum.includes(x as string))
      throw new Error(`${name}: ${k} must be one of ${a.enum.join(", ")}`);
    out[k] = x;
  }
  return out;
}

export type SymbolRef =
  | { kind: "type"; type: string; member?: string }
  | { kind: "position"; path: string; line: number; col: number };

const ID = "[A-Za-z_$][\\w$]*";
const FQN = new RegExp(`^(${ID}(?:\\.${ID})*)(?:#(${ID}))?$`);

/** `Fully.Qualified.Type[#member]` or `path:line:col` (1-based), §4.2. */
export function parseSymbol(s: string): SymbolRef {
  const pos = /^(.+):(\d+):(\d+)$/.exec(s);
  if (pos) {
    const line = Number(pos[2]);
    const col = Number(pos[3]);
    if (line < 1 || col < 1)
      throw new Error(`symbol ${s}: line and column are 1-based`);
    return { kind: "position", path: pos[1]!, line, col };
  }
  const m = FQN.exec(s);
  if (!m)
    throw new Error(
      `symbol ${s}: expected Fully.Qualified.Type[#member] or path:line:col`,
    );
  return { kind: "type", type: m[1]!, member: m[2] };
}

// The five tools of RFC 0002 §4.2, one table both surfaces render: the live
// editor (phase 0, `server.ts`) and later the stdio engine and its CLI.
// No `vscode`: it moves to `packages/java-rules` with phase 1, when the
// engine is the second consumer.

export type Surface = "live" | "stdio";

interface Arg {
  type: "string" | "integer" | "boolean" | "array" | "object";
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

export const GENERATE_KINDS = [
  "accessors",
  "getters",
  "setters",
  "builder",
  "withers",
  "surroundWith",
] as const;
const ACCESSOR_KIND: Record<string, number> = {
  accessors: 0,
  getters: 1,
  setters: 2,
};

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
    doc: "Generate code with no prompt: getters and/or setters, a builder or withers for the type at a line, or surround lines with a construct.",
    args: {
      what: {
        type: "string",
        enum: [...GENERATE_KINDS],
        doc: "accessors = getters and setters; builder, withers (RFC 0015) for the type at line; surroundWith wraps line..endLine.",
        required: true,
      },
      file: {
        type: "string",
        doc: "The Java file, relative to the workspace root.",
        required: true,
      },
      line: {
        type: "integer",
        doc: "1-based line inside the type to generate for, or the first line to surround.",
        required: true,
      },
      endLine: {
        type: "integer",
        doc: "surroundWith: the last line to surround, 1-based (default: line).",
      },
      options: {
        type: "object",
        doc: 'builder, withers: fields (names; default all), methodPrefix, lombok; withers: style "copy" or "mutate". surroundWith: construct (if, ifElse, while, for, tryCatch, tryFinally, tryWithResources, synchronized, runnable; default tryCatch), catchType "Exception" for no precise type. placement "file" is refused: a tool never creates a file.',
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

/**
 * The bundle call of one `java_generate` (RFC 0015 phase 4), for both
 * surfaces: the command and its arguments. `accessorOptions` is each
 * surface's own taste (the editor's settings, the engine's flags).
 */
export function generateCall(a: {
  what: string;
  uri: string;
  line: number;
  endLine?: number;
  options?: Record<string, unknown>;
  accessorOptions?: Record<string, unknown>;
}): { command: string; args: unknown[] } {
  const at = { line: a.line - 1, character: 0 };
  const params = {
    textDocument: { uri: a.uri },
    range: { start: at, end: at },
    context: { diagnostics: [] },
  };
  const kind = ACCESSOR_KIND[a.what];
  if (kind !== undefined)
    return {
      command: "batlehub.generate.accessors",
      args: [params, JSON.stringify({ ...a.accessorOptions, kind })],
    };
  if (a.options?.placement === "file")
    throw new Error(
      `${a.what}: placement "file" creates a file, which this tool never does — generate it in the editor`,
    );
  const options = JSON.stringify(a.options ?? {});
  if (a.what === "builder" || a.what === "withers")
    return { command: `batlehub.generate.${a.what}`, args: [params, options] };
  if (a.what === "surroundWith") {
    const end = a.endLine ?? a.line;
    if (end < a.line)
      throw new Error(`surroundWith: endLine ${end} is before line ${a.line}`);
    // Whole lines: from the first line's start to the start of the line after the last.
    const range = { start: at, end: { line: end, character: 0 } };
    return {
      command: "batlehub.generate.surroundWith",
      args: [a.uri, range, options],
    };
  }
  throw new Error(
    `generate ${a.what || "?"}: expected ${GENERATE_KINDS.join(", ")}`,
  );
}

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
          : a.type === "object"
            ? !!x && typeof x === "object" && !Array.isArray(x)
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

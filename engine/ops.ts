// What every engine verb does with a server (RFC 0002 §4.2), apart from how
// it is asked and how it answers: the CLI (`cli.ts`) starts one server per
// verb, the stdio MCP server (`mcp.ts`) one per session. Nothing here
// prints, parses argv or reads a settings.json (§4.1).
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { discover, runtimeAt, type Io } from "@batlehub/java-rules/discover";
import { homeIo } from "@batlehub/java-rules/io";
import { resolve } from "@batlehub/java-rules/resolve";
import {
  formatSize,
  parseSize,
  readCgroupLimit,
} from "@batlehub/java-rules/resources";
import type { Row } from "@batlehub/java-rules/rules";
import type { Runtime } from "@batlehub/java-rules/types";
import { parseSymbol, type SymbolRef } from "@batlehub/java-rules/verbs";
import type { WorkspaceEdit } from "./apply.ts";
import { fileUri, launch, type Server } from "./launch.ts";
import type { Finding } from "./render.ts";
import { bundleJar, ensure, locate, PIN, SERVER_MIN_JAVA } from "./server.ts";

export const EXIT = {
  ok: 0,
  findings: 1,
  unusable: 2,
  refused: 3,
  timeout: 4,
} as const;

/** A refusal with its exit code: one line on stderr, nothing started (§4.3). */
export class Exit extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const MARKERS = [
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  ".git",
];
export const inside = (p: string, dir: string): boolean => {
  const r = path.relative(dir, p);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};

/** The nearest ancestor of `from` holding a build file or `.git` (§4.2); refused outside what the caller owns (§4.3). */
export function workspaceRoot(
  from: string,
  opts: {
    cwd: string;
    home: string;
    explicit?: string;
    exists?: (p: string) => boolean;
  },
): string {
  const exists = opts.exists ?? existsSync;
  let root = opts.explicit ? path.resolve(opts.cwd, opts.explicit) : undefined;
  if (!root) {
    const start = path.resolve(opts.cwd, from);
    for (let d = start; ; d = path.dirname(d)) {
      if (MARKERS.some((m) => exists(path.join(d, m)))) {
        root = d;
        break;
      }
      if (path.dirname(d) === d) break;
    }
    root ??= start;
  }
  if (
    root === path.parse(root).root ||
    !(
      inside(root, opts.home) ||
      inside(root, opts.cwd) ||
      inside(opts.cwd, root)
    )
  )
    throw new Error(
      `the workspace ${root} is neither under your home nor under, or above, the current directory: name one with --workspace`,
    );
  return root;
}

/** The JDK the server runs on: `BATLEHUB_JAVA_HOME`, else discovery's lowest ≥ 21 (the server's own floor). */
export async function serverJdk(io: Io): Promise<Runtime> {
  const forced = io.env.BATLEHUB_JAVA_HOME;
  const runtimes = forced
    ? [runtimeAt(io, forced.replace(/[/\\]+$/, ""), "env")].filter(
        (r): r is Runtime => !!r,
      )
    : await discover(io, ["mise", "sdkman", "env", "wellKnown"]);
  const r = resolve(runtimes, {
    min: SERVER_MIN_JAVA,
    origin: `redhat.java ${PIN.version}`,
  }).runtime;
  if (!r || r.major < SERVER_MIN_JAVA)
    throw new Exit(
      EXIT.unusable,
      forced
        ? `BATLEHUB_JAVA_HOME=${forced} is not a JDK ≥ ${SERVER_MIN_JAVA}`
        : `no JDK ≥ ${SERVER_MIN_JAVA}: install one with 'mise use java@temurin-21'`,
    );
  return r;
}

/** The declared cap against the container's limit (§4.2, RFC 0001 §7.1). */
export function capCheck(
  heap: string,
  read: (p: string) => string | undefined,
): { cap: number; limit?: number } {
  const cap = parseSize(heap);
  if (!cap)
    throw new Exit(
      EXIT.unusable,
      `--heap ${heap} is not a size (512m, 1G, 2G)`,
    );
  const { limit } = readCgroupLimit(read);
  if (limit !== undefined && cap > limit)
    throw new Exit(
      EXIT.unusable,
      `the server's declared cap ${formatSize(cap)} does not fit the container's limit ${formatSize(limit)}: lower --heap, or use the live editor's tools, which start nothing`,
    );
  return { cap, limit };
}

export const readOrUndefined = (p: string): string | undefined => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};
export const tilde = (p: string): string =>
  inside(p, os.homedir()) ? `~/${path.relative(os.homedir(), p)}` : p;

/** What `status` says, line by line (use case 5); exit 2 with no JDK. */
export async function statusOf(): Promise<{
  jdk: string;
  server: string;
  bundle: string;
  cap: string;
}> {
  const jdk = await serverJdk(homeIo());
  const { server, from } = locate();
  const jar = bundleJar();
  const { cap, limit } = capCheck("1G", readOrUndefined);
  return {
    jdk: `${jdk.name} (${jdk.version}, ${jdk.source})`,
    server: `redhat.java ${PIN.version} ${server ? `at ${tilde(server)}` : `not downloaded yet (the first inspect fetches it into ${tilde(from)})`}`,
    bundle: jar
      ? tilde(jar)
      : "not found: run 'task jdt:build', or set BATLEHUB_JDT_BUNDLE",
    cap: `${formatSize(cap)} declared, container limit ${limit ? formatSize(limit) : "none"}`,
  };
}

/** Every `*.java` of the server's own source roots (decision 13), under one of `paths`. */
export function javaFiles(sourceRoots: string[], paths: string[]): string[] {
  const out = new Set<string>();
  for (const root of sourceRoots)
    for (const rel of readdirSync(root, { recursive: true }) as string[]) {
      const f = path.join(root, rel);
      if (f.endsWith(".java") && paths.some((p) => inside(f, p))) out.add(f);
    }
  return [...out].sort();
}

export interface Common {
  workspace?: string;
  timeout: number;
  heap: string;
  verbose: boolean;
}

export interface Started {
  server: Server;
  root: string;
  /** The JVM's peak RSS so far, for `--verbose`. */
  peak(): string;
}

/**
 * JDK, cap, bundle, server, `ServiceReady` (§4.2 "The server's life"):
 * a server on `root`, ready. The caller stops it.
 */
export async function start(
  root: string,
  o: Common,
  warn: (l: string) => void,
): Promise<Started> {
  if (
    o.verbose &&
    /"batlehub\.java\./.test(
      readOrUndefined(path.join(root, ".vscode", "settings.json")) ?? "",
    )
  )
    warn(
      ".vscode/settings.json holds batlehub.java.* keys: not read — CI and agents report at the project's values (RFC 0002 §4.1)",
    );
  const jdk = await serverJdk(homeIo());
  capCheck(o.heap, readOrUndefined);
  const jar = bundleJar();
  if (!jar)
    throw new Exit(
      EXIT.unusable,
      "no BatleHub JDT bundle: run 'task jdt:build', or set BATLEHUB_JDT_BUNDLE",
    );
  let serverDir: string;
  try {
    serverDir = await ensure(jdk.path, warn);
  } catch (e) {
    throw new Exit(EXIT.unusable, (e as Error).message);
  }
  if (o.verbose)
    warn(
      `workspace ${root}, JDK ${jdk.name} (${jdk.version}), -Xmx${o.heap}, a fresh -data`,
    );
  const server = await launch({
    server: serverDir,
    workspace: root,
    bundles: [jar],
    java: path.join(jdk.path, "bin", "java"),
    heap: o.heap,
    settings: { java: { import: { gradle: { enabled: true } } } },
  });
  try {
    await server.ready(o.timeout * 1000, (s) =>
      warn(
        `still importing after ${Math.round(s.ms / 1000)} s (last status: ${s.last ?? "none"})`,
      ),
    );
  } catch (e) {
    await server.stop();
    throw new Exit(EXIT.timeout, (e as Error).message);
  }
  return {
    server,
    root,
    peak: () => {
      const hwm = /VmHWM:\s+(\d+) kB/.exec(
        readOrUndefined(`/proc/${server.pid}/status`) ?? "",
      )?.[1];
      return hwm ? formatSize(Number(hwm) * 1024) : "unknown";
    },
  };
}

/** The `*.java` files under `paths`, through the server's own source roots. */
export async function sources(
  server: Server,
  paths: string[],
): Promise<string[]> {
  const listed = await server.exec("java.project.listSourcePaths");
  const roots = ((listed?.data ?? []) as { path: string }[])
    .map((d) => d.path)
    .filter((p) => existsSync(p));
  return javaFiles(roots, paths);
}

/** Each file's mtime, by real path, at the moment the server is asked (the write guard). */
export const mtimesOf = (files: string[]): Map<string, number> =>
  new Map(files.map((f) => [realpathSync(f), statSync(f).mtimeMs]));

/** The bundle's rows for each file, at the bundle's severities (decision 21); `path` relative to `base`. */
export async function findings(
  server: Server,
  files: string[],
  base: string,
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const f of files) {
    const rows = ((await server.exec(
      "batlehub.inspections.list",
      fileUri(f),
    )) ?? []) as Row[];
    for (const r of rows) out.push({ path: path.relative(base, f), ...r });
  }
  return out;
}

/** Every fix in `files`, or one rule's (`collections/sizeIsZero` or `sizeIsZero`), as one edit. */
export async function fixEdit(
  server: Server,
  files: string[],
  rule?: string,
): Promise<WorkspaceEdit> {
  const edit: WorkspaceEdit = { changes: {} };
  for (const f of files) {
    const e = (await server.exec(
      "batlehub.inspections.fixAll",
      fileUri(f),
      rule ? rule.split("/").pop() : null,
    )) as WorkspaceEdit | undefined;
    for (const [u, l] of Object.entries(e?.changes ?? {}))
      if (l.length) edit.changes![u] = l;
  }
  return edit;
}

export const GENERATE_KIND: Record<string, number> = {
  accessors: 0,
  getters: 1,
  setters: 2,
};

/** Accessors for the type at `line` (1-based), with the bundle's defaults (decision 34). */
export async function generateEdit(
  server: Server,
  file: string,
  line: number,
  o: {
    what: string;
    getterPrefix?: string;
    booleanPrefix?: string;
    fluentSetters?: boolean;
  },
): Promise<WorkspaceEdit> {
  const kind = GENERATE_KIND[o.what];
  if (kind === undefined)
    throw new Exit(
      EXIT.unusable,
      `generate ${o.what || "?"}: expected accessors, getters or setters`,
    );
  const at = { line: line - 1, character: 0 };
  return ((await server.exec(
    "batlehub.generate.accessors",
    {
      textDocument: { uri: fileUri(file) },
      range: { start: at, end: at },
      context: { diagnostics: [] },
    },
    JSON.stringify({
      getterPrefix: o.getterPrefix ?? "get",
      booleanPrefix: o.booleanPrefix ?? "is",
      fluentSetters: o.fluentSetters ?? false,
      finalFields: "keepSetters",
      kind,
    }),
  )) ?? {}) as WorkspaceEdit;
}

/** A symbol (`Type#member`) or a 1-based `path:line:col`, `path` resolved against `base`. */
export function symbolRef(symbol: string, base: string): SymbolRef {
  try {
    const ref = parseSymbol(symbol);
    return ref.kind === "position"
      ? { ...ref, path: path.resolve(base, ref.path) }
      : ref;
  } catch (e) {
    throw new Exit(EXIT.unusable, (e as Error).message);
  }
}

/** The bundle's `batlehub.rename`; a refusal (unknown, ambiguous, a type) is exit 1 with its sentence. */
export async function renameEdit(
  server: Server,
  ref: SymbolRef,
  symbol: string,
  newName: string,
): Promise<WorkspaceEdit> {
  try {
    return (
      (await (ref.kind === "position"
        ? server.exec(
            "batlehub.rename",
            fileUri(ref.path),
            ref.line - 1,
            ref.col - 1,
            newName,
          )
        : server.exec("batlehub.rename", symbol, newName))) ?? {}
    );
  } catch (e) {
    throw new Exit(
      EXIT.findings,
      (e as Error).message.replace(/^batlehub: /, ""),
    );
  }
}

#!/usr/bin/env node
// `batlehub java <verb>` (RFC 0002 §4.2): `status`, `inspect`, `fix`,
// `generate`, `rename`, and `mcp` (the same tools over stdio, one server for
// the session). Until `batlehub-cli` grows its `java` group (phase 6) it
// runs as `node engine/cli.ts <verb>`. Argument parsing and output only: the
// verbs' work is `ops.ts`. Nothing here reads a settings.json (§4.1).
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { VERBS } from "@batlehub/java-rules/verbs";
import { PIN } from "./server.ts";
import {
  plan,
  Refused,
  write,
  type Planned,
  type WorkspaceEdit,
} from "./apply.ts";
import { serve } from "./mcp.ts";
import {
  type Common,
  EXIT,
  Exit,
  findings,
  fixEdit,
  generateEdit,
  mtimesOf,
  renameEdit,
  sources,
  start,
  type Started,
  statusOf,
  symbolRef,
  workspaceRoot,
} from "./ops.ts";
import {
  failed,
  json,
  sarif,
  text,
  type Severity,
  unifiedDiff,
} from "./render.ts";

/** A server for one verb: the workspace of `from`, started, `fn`, stopped (§4.2). */
async function session<T>(
  from: string,
  o: Common,
  warn: (l: string) => void,
  fn: (s: Started) => Promise<T>,
): Promise<T> {
  const root = workspaceRoot(
    statSync(from).isDirectory() ? from : path.dirname(from),
    { cwd: process.cwd(), home: os.homedir(), explicit: o.workspace },
  );
  const s = await start(root, o, warn);
  try {
    const out = await fn(s);
    if (o.verbose) warn(`peak RSS ${s.peak()} (declared ${o.heap})`);
    return out;
  } finally {
    await s.server.stop();
  }
}

/** Paths that exist, absolute; the current directory when none is named. */
function existing(paths: string[]): string[] {
  const out = (paths.length ? paths : ["."]).map((p) =>
    path.resolve(process.cwd(), p),
  );
  for (const p of out)
    if (!statSync(p, { throwIfNoEntry: false }))
      throw new Exit(EXIT.unusable, `${p}: no such file or directory`);
  return out;
}

async function status(say: (l: string) => void): Promise<number> {
  const s = await statusOf();
  say(`JDK: ${s.jdk}`);
  say(`server: ${s.server}`);
  say(`bundle: ${s.bundle}`);
  say(`cap: ${s.cap}`);
  return EXIT.ok;
}

async function inspect(
  o: Common & {
    paths: string[];
    format: "text" | "json" | "sarif";
    failOn: Severity;
  },
  say: (l: string) => void,
  warn: (l: string) => void,
): Promise<number> {
  const paths = existing(o.paths);
  return session(paths[0]!, o, warn, async ({ server }) => {
    const files = await sources(server, paths);
    const found = await findings(server, files, process.cwd());
    const exit = failed(found, o.failOn) ? EXIT.findings : EXIT.ok;
    if (o.format === "json") say(json(found, exit));
    else if (o.format === "sarif") say(sarif(found, PIN.version));
    else if (found.length) say(text(found));
    if (o.verbose) warn(`${files.length} file(s), ${found.length} finding(s)`);
    return exit;
  });
}

/** `1 file, 1 edit`, `2 files, 3 edits`, `0 files` (use case 2). */
export function summary(planned: Planned[]): string {
  const n = planned.length;
  const e = planned.reduce((a, p) => a + p.edits, 0);
  return n
    ? `${n} file${n > 1 ? "s" : ""}, ${e} edit${e > 1 ? "s" : ""}`
    : "0 files";
}

/** Writes `planned` under the guards; a refusal is exit 3 (§4.3). */
export function guardedWrite(
  planned: Planned[],
  root: string,
  mtimes: Map<string, number>,
): void {
  try {
    write(planned, root, mtimes);
  } catch (e) {
    if (e instanceof Refused) throw new Exit(EXIT.refused, e.message);
    throw e;
  }
}

/**
 * What a verb that edits ends with (§4.2): the diff, or the WorkspaceEdit in
 * JSON, and nothing written; with `--write`, the files written and the count.
 */
function finishEdit(
  edit: WorkspaceEdit,
  o: { write: boolean; format: "text" | "json" },
  root: string,
  mtimes: Map<string, number>,
  emptyExit: number,
  say: (l: string) => void,
  warn: (l: string) => void,
): number {
  const planned = plan(edit);
  const exit = planned.length ? EXIT.ok : emptyExit;
  if (o.write) guardedWrite(planned, root, mtimes);
  if (o.format === "json")
    say(JSON.stringify({ edit, written: o.write, exit }, null, 2));
  else if (o.write) say(summary(planned));
  else {
    const diff = planned
      .map((p) =>
        unifiedDiff(path.relative(process.cwd(), p.file), p.before, p.after),
      )
      .join("\n");
    if (diff) say(diff);
    warn(`${summary(planned)} (dry run: --write applies it)`);
  }
  return exit;
}

type EditOpts = Common & { write: boolean; format: "text" | "json" };

async function fix(
  o: EditOpts & { paths: string[]; rule?: string },
  say: (l: string) => void,
  warn: (l: string) => void,
): Promise<number> {
  const paths = existing(o.paths);
  return session(paths[0]!, o, warn, async ({ server, root }) => {
    const files = await sources(server, paths);
    const mtimes = mtimesOf(files);
    const edit = await fixEdit(server, files, o.rule);
    return finishEdit(edit, o, root, mtimes, EXIT.ok, say, warn);
  });
}

/** `path:line`, 1-based: where `generate` acts. */
export function parseTarget(t: string): { file: string; line: number } {
  const m = /^(.+):(\d+)$/.exec(t);
  if (!m || Number(m[2]) < 1)
    throw new Exit(EXIT.unusable, `${t}: expected <file>:<line>, 1-based`);
  return { file: m[1]!, line: Number(m[2]) };
}

async function generate(
  o: EditOpts & {
    what: string;
    target: string;
    getterPrefix?: string;
    booleanPrefix?: string;
    fluent: boolean;
  },
  say: (l: string) => void,
  warn: (l: string) => void,
): Promise<number> {
  const t = parseTarget(o.target);
  const [file] = existing([t.file]);
  return session(file!, o, warn, async ({ server, root }) => {
    const mtimes = mtimesOf([file!]);
    const edit = await generateEdit(server, file!, t.line, {
      what: o.what,
      getterPrefix: o.getterPrefix,
      booleanPrefix: o.booleanPrefix,
      fluentSetters: o.fluent,
    });
    return finishEdit(edit, o, root, mtimes, EXIT.findings, say, warn);
  });
}

/**
 * `rename <symbol|path:line:col> <newName>` (§4.2, use case 3): an unknown
 * symbol, an ambiguous one, or a type (its rename moves the file) is exit 1
 * with the server's sentence.
 */
async function rename(
  o: EditOpts & { symbol: string; newName: string },
  say: (l: string) => void,
  warn: (l: string) => void,
): Promise<number> {
  const ref = symbolRef(o.symbol, process.cwd());
  const [from] = existing([ref.kind === "position" ? ref.path : "."]);
  return session(from!, o, warn, async ({ server, root }) => {
    // Which files the rename touches is the server's answer, so every source
    // file's mtime is taken before the question.
    const mtimes = mtimesOf(await sources(server, [root]));
    const edit = await renameEdit(server, ref, o.symbol, o.newName);
    return finishEdit(edit, o, root, mtimes, EXIT.findings, say, warn);
  });
}

const SEVERITIES = ["error", "warning", "info", "hint"] as const;
const FORMATS = ["text", "json", "sarif"] as const;

export function usage(): string {
  const doc = (n: string) =>
    VERBS.find((v) => v.name === `java_${n}`)?.doc ?? "";
  return [
    "batlehub java <verb> [paths…] [options]",
    "",
    `  status                             ${doc("status")}`,
    `  inspect [paths…]                   ${doc("inspect")}`,
    `  fix [paths…]                       ${doc("fix")}`,
    `  generate accessors|getters|setters <file>:<line>   ${doc("generate")}`,
    `  rename <Type#member|file:line:col> <newName>   ${doc("rename")}`,
    "  mcp                                the tools above over stdio (Model Context Protocol), one server for the session",
    "",
    "  --format text|json|sarif   output form (sarif: inspect only); default text",
    "  --fail-on error|warning|info|hint   (inspect) exit 1 at or above; default hint (any finding)",
    "  --rule <code>       (fix) one rule's fixes, e.g. collections/sizeIsZero",
    "  --write             (fix, generate, rename) apply the edit; without it, a dry run that prints the diff",
    "  --getter-prefix <p>, --boolean-prefix <p>, --fluent   (generate) default get, is, off",
    "  --workspace <dir>   the workspace root; default the nearest build file or .git",
    "  --timeout <s>       wait for the server's import; default 300",
    "  --heap <size>       the server's declared cap (-Xmx); default 1G",
    "  --verbose           progress and peak RSS on stderr",
    "",
    "exit: 0 done · 1 findings at or above --fail-on, or generate or rename made nothing · 2 no usable JDK, server or cap · 3 a write refused · 4 no ServiceReady in --timeout",
  ].join("\n");
}

export async function main(
  argv: string[],
  say = (l: string) => console.log(l),
  warn = (l: string) => console.error(l),
): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv[0] === "java" ? argv.slice(1) : argv,
      allowPositionals: true,
      options: {
        format: { type: "string", default: "text" },
        "fail-on": { type: "string", default: "hint" },
        rule: { type: "string" },
        write: { type: "boolean", default: false },
        "getter-prefix": { type: "string" },
        "boolean-prefix": { type: "string" },
        fluent: { type: "boolean", default: false },
        workspace: { type: "string" },
        timeout: { type: "string", default: "300" },
        heap: { type: "string", default: "1G" },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    const [verb, ...rest] = positionals;
    if (values.help || !verb) {
      say(usage());
      return values.help ? EXIT.ok : EXIT.unusable;
    }
    if (!(FORMATS as readonly string[]).includes(values.format!))
      throw new Exit(
        EXIT.unusable,
        `--format must be one of ${FORMATS.join(", ")}`,
      );
    if (values.format === "sarif" && verb !== "inspect")
      throw new Exit(EXIT.unusable, "--format sarif is for inspect only");
    if (!(SEVERITIES as readonly string[]).includes(values["fail-on"]!))
      throw new Exit(
        EXIT.unusable,
        `--fail-on must be one of ${SEVERITIES.join(", ")}`,
      );
    const timeout = Number(values.timeout);
    if (!(timeout > 0))
      throw new Exit(EXIT.unusable, "--timeout must be a number of seconds");
    const common: Common = {
      workspace: values.workspace,
      timeout,
      heap: values.heap!,
      verbose: values.verbose!,
    };
    const format = values.format as "text" | "json";
    if (verb === "status") return await status(say);
    if (verb === "mcp") return await serve(common, warn);
    if (verb === "inspect")
      return await inspect(
        {
          ...common,
          paths: rest,
          format: values.format as "text" | "json" | "sarif",
          failOn: values["fail-on"] as Severity,
        },
        say,
        warn,
      );
    if (verb === "fix")
      return await fix(
        {
          ...common,
          paths: rest,
          rule: values.rule,
          write: values.write!,
          format,
        },
        say,
        warn,
      );
    if (verb === "generate") {
      if (rest.length !== 2)
        throw new Exit(
          EXIT.unusable,
          "generate takes two arguments: accessors|getters|setters <file>:<line>",
        );
      return await generate(
        {
          ...common,
          what: rest[0]!,
          target: rest[1]!,
          getterPrefix: values["getter-prefix"],
          booleanPrefix: values["boolean-prefix"],
          fluent: values.fluent!,
          write: values.write!,
          format,
        },
        say,
        warn,
      );
    }
    if (verb === "rename") {
      if (rest.length !== 2)
        throw new Exit(
          EXIT.unusable,
          "rename takes two arguments: <Fully.Qualified.Type#member | file:line:col> <newName>",
        );
      return await rename(
        {
          ...common,
          symbol: rest[0]!,
          newName: rest[1]!,
          write: values.write!,
          format,
        },
        say,
        warn,
      );
    }
    throw new Exit(
      EXIT.unusable,
      `unknown verb ${verb} (status, inspect, fix, generate, rename, mcp)\n${usage()}`,
    );
  } catch (e) {
    warn(`batlehub java: ${(e as Error).message}`);
    return e instanceof Exit ? e.code : EXIT.unusable;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));

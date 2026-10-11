#!/usr/bin/env node
// `batlehub java <verb>` (RFC 0002 §4.2): `status`, `inspect`, `fix`,
// `generate`, `rename`, and `mcp` (the same tools over stdio, one server for
// the session), and `config --print`. `batlehub-cli java …` runs it (phase 6:
// the CLI embeds `task engine:bundle`'s build); in this repository,
// `node engine/cli.ts <verb>`. Argument parsing and output only: the verbs'
// work is `ops.ts` and `config.ts`. Nothing here reads a settings.json (§4.1).
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { GENERATE_KINDS, VERBS } from "@batlehub/java-rules/verbs";
import { PIN } from "./server.ts";
import {
  plan,
  Refused,
  write,
  type Planned,
  type WorkspaceEdit,
} from "./apply.ts";
import {
  printedProfile,
  projectConfig,
  teamProfile,
  type TeamProfile,
} from "./config.ts";
import { serve } from "./mcp.ts";
import {
  bundleRules,
  type Common,
  EXIT,
  Exit,
  findings,
  fixEdit,
  generateEdit,
  mtimesOf,
  readOrUndefined,
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

/** The team profile against the running bundle (RFC 0005 phase 4); its problems on stderr, as `file:line:`. */
async function team(
  s: Started,
  file: string | undefined,
  warn: (l: string) => void,
): Promise<TeamProfile> {
  let p: TeamProfile;
  try {
    p = teamProfile(s.root, await bundleRules(s.server), readOrUndefined, file);
  } catch (e) {
    throw new Exit(EXIT.unusable, (e as Error).message);
  }
  for (const x of p.problems)
    warn(
      `${path.relative(process.cwd(), p.file!)}:${x.line + 1}: ${x.severity}: ${x.message}`,
    );
  return p;
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
    profile?: string;
    printProfile: boolean;
  },
  say: (l: string) => void,
  warn: (l: string) => void,
): Promise<number> {
  const paths = existing(o.paths);
  return session(paths[0]!, o, warn, async (s) => {
    const { server } = s;
    const p = await team(s, o.profile, warn);
    if (o.printProfile) {
      const printed = printedProfile(p);
      if (o.format === "text")
        for (const [code, r] of Object.entries(printed.rules))
          say(
            `${code} ${r.level}${r.origin === "profile" ? ` (profile; default ${r.default})` : ""}${r.why ? ` — ${r.why}` : ""}`,
          );
      else say(JSON.stringify(printed, null, 2));
      return EXIT.ok;
    }
    const files = await sources(server, paths);
    const found = await findings(server, files, process.cwd(), p.levels);
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
  o: EditOpts & { paths: string[]; rule?: string; profile?: string },
  say: (l: string) => void,
  warn: (l: string) => void,
): Promise<number> {
  const paths = existing(o.paths);
  return session(paths[0]!, o, warn, async (s) => {
    const { server, root } = s;
    const p = await team(s, o.profile, warn);
    const files = await sources(server, paths);
    const mtimes = mtimesOf(files);
    const edit = await fixEdit(server, files, o.rule, p.levels);
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
    endLine?: string;
    options?: string;
    getterPrefix?: string;
    booleanPrefix?: string;
    fluent: boolean;
  },
  say: (l: string) => void,
  warn: (l: string) => void,
): Promise<number> {
  if (!(GENERATE_KINDS as readonly string[]).includes(o.what))
    throw new Exit(
      EXIT.unusable,
      `generate ${o.what}: expected ${GENERATE_KINDS.join(", ")}`,
    );
  const t = parseTarget(o.target);
  const endLine = o.endLine === undefined ? undefined : Number(o.endLine);
  if (endLine !== undefined && !(Number.isInteger(endLine) && endLine >= 1))
    throw new Exit(EXIT.unusable, "--end-line must be a 1-based line");
  let options: Record<string, unknown> | undefined;
  try {
    options = o.options === undefined ? undefined : JSON.parse(o.options);
  } catch {
    throw new Exit(EXIT.unusable, "--options must be a JSON object");
  }
  if (
    options !== undefined &&
    (typeof options !== "object" || Array.isArray(options) || !options)
  )
    throw new Exit(EXIT.unusable, "--options must be a JSON object");
  const [file] = existing([t.file]);
  return session(file!, o, warn, async ({ server, root }) => {
    const mtimes = mtimesOf([file!]);
    const edit = await generateEdit(server, file!, t.line, {
      what: o.what,
      endLine,
      options,
      getterPrefix: o.getterPrefix,
      booleanPrefix: o.booleanPrefix,
      fluentSetters: o.fluent,
    });
    // The bundle's refusal is its answer (RFC 0015 §6.1): said, and exit 1.
    if (edit.refused) {
      warn(edit.refused);
      return EXIT.findings;
    }
    if (edit.note) warn(edit.note);
    return finishEdit(
      { changes: edit.changes ?? {} },
      o,
      root,
      mtimes,
      EXIT.findings,
      say,
      warn,
    );
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

/** `config --print` (RFC 0006 use case 6): no server, only the committed file and the build file. */
function config(
  rest: string[],
  print: boolean,
  o: Common,
  say: (l: string) => void,
  warn: (l: string) => void,
): number {
  if (!print) throw new Exit(EXIT.unusable, "config takes --print");
  const [from] = existing(rest);
  const root = workspaceRoot(
    statSync(from!).isDirectory() ? from! : path.dirname(from!),
    { cwd: process.cwd(), home: os.homedir(), explicit: o.workspace },
  );
  const c = projectConfig(root, readOrUndefined);
  for (const x of c.problems)
    warn(
      `${path.relative(process.cwd(), c.file)}:${x.line + 1}: ${x.severity}: ${x.message}`,
    );
  say(JSON.stringify(c.config, null, 2));
  return EXIT.ok;
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
    `  generate accessors|getters|setters|builder|withers|surroundWith <file>:<line>   ${doc("generate")}`,
    `  rename <Type#member|file:line:col> <newName>   ${doc("rename")}`,
    "  mcp                                the tools above over stdio (Model Context Protocol), one server for the session",
    "  config --print                     the committed .batlehub/java/project.json resolved, as JSON — the editor's `project` view; no server",
    "",
    "  --format text|json|sarif   output form (sarif: inspect only); default text",
    "  --fail-on error|warning|info|hint   (inspect) exit 1 at or above; default hint (any finding)",
    "  --rule <code>       (fix) one rule's fixes, e.g. collections/sizeIsZero",
    "  --profile <file>    (inspect, fix) this inspection profile instead of the committed .batlehub/java/inspections.json",
    "  --print-profile     (inspect) print every rule at its effective level instead of inspecting",
    "  --write             (fix, generate, rename) apply the edit; without it, a dry run that prints the diff",
    "  --getter-prefix <p>, --boolean-prefix <p>, --fluent   (generate accessors) default get, is, off",
    "  --end-line <n>      (generate surroundWith) the last line to surround; default <line>",
    '  --options <json>    (generate builder|withers|surroundWith) e.g. \'{"fields":["name"],"methodPrefix":"with"}\', \'{"construct":"tryCatch"}\'',
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
        profile: { type: "string" },
        "print-profile": { type: "boolean", default: false },
        print: { type: "boolean", default: false },
        write: { type: "boolean", default: false },
        "getter-prefix": { type: "string" },
        "boolean-prefix": { type: "string" },
        fluent: { type: "boolean", default: false },
        "end-line": { type: "string" },
        options: { type: "string" },
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
    if (verb === "config")
      return config(rest, values.print!, common, say, warn);
    if (verb === "inspect")
      return await inspect(
        {
          ...common,
          paths: rest,
          format: values.format as "text" | "json" | "sarif",
          failOn: values["fail-on"] as Severity,
          profile: values.profile,
          printProfile: values["print-profile"]!,
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
          profile: values.profile,
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
          `generate takes two arguments: ${GENERATE_KINDS.join("|")} <file>:<line>`,
        );
      return await generate(
        {
          ...common,
          what: rest[0]!,
          target: rest[1]!,
          endLine: values["end-line"],
          options: values.options,
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
      `unknown verb ${verb} (status, inspect, fix, generate, rename, mcp, config)\n${usage()}`,
    );
  } catch (e) {
    warn(`batlehub java: ${(e as Error).message}`);
    return e instanceof Exit ? e.code : EXIT.unusable;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));

// `batlehub java mcp` (RFC 0002 §4.2 "MCP (command line)", phase 5): the
// five tools over stdio for an agent with no editor — the same McpSession
// and the same table as the live editor (decision 7), `dryRun` defaulting to
// true on this surface (decision 6). One server for the session, started by
// the first tool that needs it. No listener: the spawning process is the
// trust boundary (§7).
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpSession } from "@batlehub/java-rules/protocol";
import { plan, Refused, write, type WorkspaceEdit } from "./apply.ts";
import { fileUri } from "./launch.ts";
import {
  type Common,
  findings,
  fixEdit,
  generateEdit,
  inside,
  mtimesOf,
  renameEdit,
  sources,
  start,
  type Started,
  statusOf,
  symbolRef,
  workspaceRoot,
} from "./ops.ts";

const VERSION = String(
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, "package.json"), "utf8"),
  ).version,
);

type Args = Record<string, unknown>;

/** The tools over one workspace and one lazily started server. */
export function tools(
  root: string,
  server: () => Promise<Started>,
): Record<string, (a: Args) => Promise<unknown>> {
  /** A workspace-relative path, refused when it leaves the workspace. */
  const abs = (p: string) => {
    const f = path.resolve(root, p);
    if (!inside(f, root)) throw new Error(`${p} is outside the workspace`);
    return f;
  };
  const rel = (f: string) => path.relative(root, f);

  /** Dry run: the edit. Otherwise written under the guards, and the server told. */
  const finish = async (
    s: Started,
    edit: WorkspaceEdit,
    dryRun: boolean,
    mtimes: Map<string, number>,
  ) => {
    const planned = plan(edit);
    const applied = !dryRun && planned.length > 0;
    if (applied) {
      try {
        write(planned, root, mtimes);
      } catch (e) {
        if (e instanceof Refused)
          throw new Error(`write refused: ${e.message}`);
        throw e;
      }
      // One server for the session: what it read before the write is stale
      // until it is told (decision 36 is per process; a session is one).
      s.server.notify("workspace/didChangeWatchedFiles", {
        changes: planned.map((p) => ({ uri: fileUri(p.file), type: 2 })),
      });
      // The notification is queued; the bundle's refresh is done when it answers.
      await s.server.exec(
        "batlehub.refresh",
        planned.map((p) => fileUri(p.file)),
      );
    }
    return {
      files: planned.length,
      edits: planned.reduce((n, p) => n + p.edits, 0),
      applied,
      edit: {
        changes: Object.fromEntries(
          Object.entries(edit.changes ?? {}).map(([u, l]) => [
            rel(new URL(u).pathname),
            l,
          ]),
        ),
      },
    };
  };

  return {
    java_status: async () => ({ workspace: root, ...(await statusOf()) }),
    java_inspect: async (a) => {
      const s = await server();
      const files = await sources(
        s.server,
        ((a.paths as string[] | undefined) ?? ["."]).map(abs),
      );
      return {
        files: files.length,
        findings: await findings(s.server, files, root),
      };
    },
    java_fix: async (a) => {
      const s = await server();
      const files = await sources(
        s.server,
        ((a.paths as string[] | undefined) ?? ["."]).map(abs),
      );
      const mtimes = mtimesOf(files);
      const edit = await fixEdit(s.server, files, a.rule as string | undefined);
      return finish(s, edit, a.dryRun as boolean, mtimes);
    },
    java_generate: async (a) => {
      const s = await server();
      const file = abs(a.file as string);
      const mtimes = mtimesOf([file]);
      const edit = await generateEdit(s.server, file, a.line as number, {
        what: a.what as string,
        getterPrefix: a.getterPrefix as string | undefined,
        booleanPrefix: a.booleanPrefix as string | undefined,
        fluentSetters: a.fluentSetters as boolean | undefined,
      });
      return finish(s, edit, a.dryRun as boolean, mtimes);
    },
    java_rename: async (a) => {
      const s = await server();
      const ref = symbolRef(a.symbol as string, root);
      if (ref.kind === "position") abs(ref.path);
      const mtimes = mtimesOf(await sources(s.server, [root]));
      const edit = await renameEdit(
        s.server,
        ref,
        a.symbol as string,
        a.newName as string,
      );
      return finish(s, edit, a.dryRun as boolean, mtimes);
    },
  };
}

/** Serves stdin → stdout until stdin ends; the server is stopped then. Logs go to stderr. */
export async function serve(
  o: Common,
  warn: (l: string) => void,
): Promise<number> {
  const root = workspaceRoot(".", {
    cwd: process.cwd(),
    home: os.homedir(),
    explicit: o.workspace,
  });
  let started: Promise<Started> | undefined;
  const server = () =>
    (started ??= start(root, o, warn).catch((e) => {
      started = undefined; // a failed start is retried by the next call
      throw e;
    }));
  const t = tools(root, server);
  const session = new McpSession(
    "stdio",
    VERSION,
    async (name, args) => {
      const t0 = Date.now();
      try {
        return await t[name]!(args);
      } finally {
        if (o.verbose) warn(`mcp: ${name} in ${Date.now() - t0} ms`);
      }
    },
    (line) => process.stdout.write(line),
  );
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d: string) => session.feed(d));
  await new Promise<void>((r) => {
    process.stdin.once("end", r);
    process.once("SIGTERM", r);
  });
  if (started) await (await started.catch(() => undefined))?.server.stop();
  return 0;
}

// The headless JDT.LS of RFC 0002 §6.1: the pinned redhat.java's own server,
// started with the BatleHub bundle in `initializationOptions.bundles`, spoken
// to over stdio JSON-RPC. `jdt/smoke.mjs` was this with a fixture and its
// assertions inside; it is now the first caller, the CLI verbs the next.
// Erasable TypeScript only: Node 24 runs it as is, no build.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface LaunchOptions {
  /** The unpacked server: `<vsix>/extension/server` (`jdt/deps.sh`'s layout, `BATLEHUB_JDTLS_HOME`). */
  server: string;
  /** The workspace root the server imports. */
  workspace: string;
  /**
   * The server's `-data` directory: its own, never the editor's (decision 3).
   * Absent, a fresh one is made and removed at stop (decision 36): a `-data`
   * kept between runs goes out of sync with files changed in between.
   */
  data?: string;
  /** Bundle jars for `initializationOptions.bundles`. */
  bundles?: string[];
  /** The `java` to run; default `$JAVA_HOME/bin/java`, else `java` on PATH. */
  java?: string;
  /** The declared cap (§4.2): `-Xmx`, default `1G`. */
  heap?: string;
  /** `initializationOptions.settings`. */
  settings?: unknown;
}

export interface Note {
  method: string;
  params?: any;
}

export interface Server {
  /** What `initialize` answered: the capabilities, the advertised commands. */
  readonly init: any;
  readonly notes: Note[];
  request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  notify(method: string, params: unknown): void;
  /** `workspace/executeCommand`, the bundle's and the server's commands alike. */
  exec(command: string, ...args: unknown[]): Promise<any>;
  /** The JVM's pid, for its peak RSS (§4.2 `--verbose`). */
  readonly pid: number | undefined;
  /**
   * Until `language/status` says `ServiceReady`; rejects after `timeoutMs`.
   * Past 60 s, `progress` every 10 s with the last status (§4.3: a CI log
   * shows an import, not a hang).
   */
  ready(
    timeoutMs?: number,
    progress?: (s: { ms: number; last?: string }) => void,
  ): Promise<{ ms: number; statuses: string[] }>;
  /** The server's stderr so far, for a failure's message. */
  stderr(): string;
  /** `shutdown` · `exit`, then SIGTERM after 5 s (§4.2), and the temp config removed. */
  stop(): Promise<void>;
}

export const fileUri = (p: string): string => pathToFileURL(p).href;

export async function launch(o: LaunchOptions): Promise<Server> {
  const plugins = path.join(o.server, "plugins");
  if (!existsSync(plugins)) throw new Error(`no JDT.LS at ${o.server}`);
  const launcher = readdirSync(plugins).find((f) =>
    /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(f),
  );
  if (!launcher) throw new Error(`no equinox launcher in ${plugins}`);
  // A fresh OSGi configuration area: the shared one caches a bundle by
  // location and version, so a rebuilt jar at the same version would never
  // be read.
  const config = mkdtempSync(path.join(tmpdir(), "batlehub-jdtls-config-"));
  const data =
    o.data ?? mkdtempSync(path.join(tmpdir(), "batlehub-jdtls-data-"));
  const owned = [config, ...(o.data ? [] : [data])];
  const cleanup = () => {
    for (const d of owned) rmSync(d, { recursive: true, force: true });
  };
  cpSync(
    path.join(o.server, "config_linux", "config.ini"),
    path.join(config, "config.ini"),
  );
  const java =
    o.java ??
    (process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", "java")
      : "java");
  const proc = spawn(
    java,
    [
      "-Declipse.application=org.eclipse.jdt.ls.core.id1",
      "-Dosgi.bundles.defaultStartLevel=4",
      "-Declipse.product=org.eclipse.jdt.ls.core.product",
      "-Dlog.level=ALL",
      `-Xmx${o.heap ?? "1G"}`,
      "-jar",
      path.join(plugins, launcher),
      "-configuration",
      config,
      "-data",
      data,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const err: string[] = [];
  proc.stderr.on("data", (d) => err.push(String(d)));
  const exited = new Promise<void>((r) => proc.once("exit", () => r()));

  let buf = Buffer.alloc(0);
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  const notes: Note[] = [];
  const send = (msg: unknown) => {
    const s = JSON.stringify(msg);
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  };
  proc.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      const len = Number(
        /Content-Length: (\d+)/.exec(buf.subarray(0, i).toString())?.[1],
      );
      if (buf.length < i + 4 + len) return;
      const msg = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString());
      buf = buf.subarray(i + 4 + len);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      } else if (msg.method && msg.id !== undefined) {
        // A server → client request (client/registerCapability,
        // workspace/configuration…): answered empty.
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result:
            msg.method === "workspace/configuration"
              ? (msg.params?.items ?? []).map(() => null)
              : null,
        });
      } else notes.push(msg);
    }
  });

  const request = (method: string, params: unknown, timeoutMs = 120_000) =>
    new Promise<any>((resolve, reject) => {
      const my = ++id;
      const t = setTimeout(
        () => reject(new Error(`${method} timed out`)),
        timeoutMs,
      );
      pending.set(my, (m) => {
        clearTimeout(t);
        // The server's own sentence (a delegate's IllegalArgumentException
        // arrives as `error.message`), not the JSON around it.
        if (m.error)
          reject(
            new Error(
              m.error.message ?? `${method}: ${JSON.stringify(m.error)}`,
            ),
          );
        else resolve(m.result);
      });
      send({ jsonrpc: "2.0", id: my, method, params });
    });
  const notify = (method: string, params: unknown) =>
    send({ jsonrpc: "2.0", method, params });

  const server: Omit<Server, "init"> = {
    notes,
    request,
    notify,
    exec: (command, ...args) =>
      request("workspace/executeCommand", { command, arguments: args }),
    pid: proc.pid,
    async ready(timeoutMs = 300_000, progress) {
      const t0 = Date.now();
      let told = 60_000;
      const statuses = () => [
        ...new Set(
          notes
            .filter((n) => n.method === "language/status")
            .map((n) => String(n.params?.type)),
        ),
      ];
      while (!statuses().includes("ServiceReady")) {
        if (Date.now() - t0 > timeoutMs)
          throw new Error(
            `no ServiceReady in ${Math.round(timeoutMs / 1000)} s (last: ${statuses().at(-1) ?? "none"})`,
          );
        if (progress && Date.now() - t0 >= told) {
          told += 10_000;
          const last = notes
            .filter((n) => n.method === "language/status")
            .at(-1)?.params?.message;
          progress({ ms: Date.now() - t0, last });
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return { ms: Date.now() - t0, statuses: statuses() };
    },
    stderr: () => err.join(""),
    async stop() {
      if (proc.exitCode === null) {
        await request("shutdown", null, 5000).catch(() => {});
        notify("exit", null);
        const t = setTimeout(() => proc.kill("SIGTERM"), 5000);
        await exited;
        clearTimeout(t);
      }
      cleanup();
    },
  };

  const root = fileUri(o.workspace);
  let init: any;
  try {
    init = await request("initialize", {
      processId: process.pid,
      rootUri: root,
      workspaceFolders: [{ uri: root, name: path.basename(o.workspace) }],
      capabilities: {
        workspace: { executeCommand: { dynamicRegistration: false } },
        textDocument: {},
      },
      initializationOptions: {
        bundles: o.bundles ?? [],
        workspaceFolders: [root],
        settings: o.settings ?? {},
        extendedClientCapabilities: { classFileContentsSupport: false },
      },
    });
  } catch (e) {
    proc.kill("SIGTERM");
    cleanup();
    throw e;
  }
  notify("initialized", {});
  return { ...server, init };
}

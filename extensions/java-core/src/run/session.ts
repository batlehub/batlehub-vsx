// A `batlehub-run` is a debug session (RFC 0003 §5.1, decision 1): an inline
// adapter whose `launch` runs the plan and whose `disconnect` is the reverse
// stop, so the editor's Stop button, debug console and child-session tree
// are the UI. The order, the probes and the stop are `orchestrator.ts`'s;
// this file only starts each kind of step through the editor.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ServerStep } from "../api-types";
import { goalCommand } from "../build/tasks";
import { readSettings } from "../config";
import { parseXmx } from "../detect/resources";
import type { Core } from "../extension";
import { log } from "../log";
import { wire } from "../wire";
import { readLaunch } from "./configs";
import { Run, startProcess, startServer, type Started } from "./orchestrator";
import {
  plan,
  validate,
  type LaunchStep,
  type PlannedStep,
  type ProcessStep,
  type RunConfig,
  type TaskStep,
} from "./steps";

const DEBUGGER = "vscjava.vscode-java-debug";
/** Child sessions' exit codes, from their adapters' `exited` events. */
const exitCodes = new Map<string, number>();

wire((core: Core) => {
  core.context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("batlehub-run", {
      createDebugAdapterDescriptor: (session) =>
        new vscode.DebugAdapterInlineImplementation(
          new Orchestrator(core, session),
        ),
    }),
    vscode.debug.registerDebugAdapterTrackerFactory("*", {
      createDebugAdapterTracker: (session) => ({
        onDidSendMessage: (m: {
          type?: string;
          event?: string;
          body?: { exitCode?: number };
        }) => {
          if (
            m.type === "event" &&
            m.event === "exited" &&
            typeof m.body?.exitCode === "number"
          )
            exitCodes.set(session.id, m.body.exitCode);
        },
      }),
    }),
  );
});

function launchEntries(
  folder: vscode.WorkspaceFolder,
): Record<string, unknown>[] {
  try {
    const text = fs.readFileSync(
      path.join(folder.uri.fsPath, ".vscode", "launch.json"),
      "utf8",
    );
    return readLaunch(text).configurations;
  } catch {
    return [];
  }
}

/** A terminal fed by a step's output, no shell (§6.2); the next run of the same name replaces it. */
function terminal(name: string): (text: string) => void {
  for (const t of vscode.window.terminals) if (t.name === name) t.dispose();
  const write = new vscode.EventEmitter<string>();
  let pending: string[] | undefined = [];
  vscode.window
    .createTerminal({
      name,
      pty: {
        onDidWrite: write.event,
        open: () => {
          for (const p of pending ?? []) write.fire(p);
          pending = undefined;
        },
        close: () => {},
      },
    })
    .show(true);
  return (text) => {
    const t = text.replace(/\r?\n/g, "\r\n");
    if (pending) pending.push(t);
    else write.fire(t);
  };
}

interface Msg {
  seq: number;
  type: string;
  command?: string;
  arguments?: unknown;
}

class Orchestrator implements vscode.DebugAdapter {
  private readonly sent =
    new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.sent.event;
  private seq = 1;
  private run?: Run;
  private ended = false;

  constructor(
    private readonly core: Core,
    private readonly session: vscode.DebugSession,
  ) {}

  private send(m: object): void {
    this.sent.fire({ seq: this.seq++, ...m } as vscode.DebugProtocolMessage);
  }
  private event(event: string, body?: unknown): void {
    this.send({ type: "event", event, body });
  }
  private respond(req: Msg, body?: unknown): void {
    this.send({
      type: "response",
      request_seq: req.seq,
      success: true,
      command: req.command,
      body,
    });
  }
  private readonly say = (line: string): void => {
    this.event("output", { category: "console", output: `${line}\n` });
    log.info(line, "Run");
  };
  private end(exitCode: number): void {
    if (this.ended) return;
    this.ended = true;
    this.event("exited", { exitCode });
    this.event("terminated");
  }

  handleMessage(m: Msg): void {
    switch (m.command) {
      case "initialize":
        this.respond(m, {
          supportsTerminateRequest: true,
          supportsConfigurationDoneRequest: true,
        });
        this.event("initialized");
        return;
      case "launch":
        this.respond(m);
        void this.go(m.arguments as RunConfig).catch((e: Error) => {
          this.say(e.message);
          this.end(1);
        });
        return;
      case "threads":
        this.respond(m, { threads: [{ id: 1, name: this.session.name }] });
        return;
      case "disconnect":
      case "terminate":
        // The session is not reported over until the cascade has returned (§5.1).
        void (this.run?.stop() ?? Promise.resolve()).finally(() => {
          this.respond(m);
          this.end(0);
        });
        return;
      default:
        this.respond(m, {});
    }
  }

  dispose(): void {
    void this.run?.stop();
  }

  private async go(config: RunConfig): Promise<void> {
    const folder =
      this.session.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
    const fail = (msg: string) => {
      this.say(msg);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Java: run "{0}": {1}', config.name, msg),
      );
      this.end(1);
    };
    if (!this.core.trusted())
      return fail(
        "step 1: nothing runs in an untrusted workspace (trust it first)",
      );
    if (!folder) return fail("no workspace folder");
    const limit = this.core.snapshot()?.resources.limit;
    const kinds = this.core.registries.kinds;
    const errors = validate(config, {
      launches: launchEntries(folder)
        .map((c) => c.name)
        .filter((n): n is string => typeof n === "string"),
      kinds: [...kinds.keys()],
      limitMiB: limit === undefined ? undefined : Math.floor(limit / 2 ** 20),
    });
    if (errors.length) return fail(errors.join(" · "));
    const steps = plan(config, {
      memoryMiB: readSettings().defaultMemoryMiB,
      kinds,
    });
    this.run = new Run(steps, (s) => this.start(s, folder, config), this.say);
    const r = await this.run.run();
    this.end(r.exitCode ?? (r.ok ? 0 : 1));
  }

  /** JAVA_HOME and PATH of the JDK the core resolved for the folder, as its tasks get (§7 red lines). */
  private jdk(folder: vscode.WorkspaceFolder) {
    const snap = this.core.snapshot();
    const runtime = (
      snap?.folders.find((f) => f.folder === folder.uri.fsPath) ??
      snap?.folders[0]
    )?.resolution.runtime;
    const env: Record<string, string> = runtime
      ? {
          JAVA_HOME: runtime.path,
          PATH: `${runtime.path}/bin${path.delimiter}${process.env.PATH ?? ""}`,
        }
      : {};
    return { runtime, env };
  }

  /** A child session in the Run view's tree; `done` resolves with its adapter's exit code. */
  private async child(
    folder: vscode.WorkspaceFolder,
    cfg: vscode.DebugConfiguration,
  ): Promise<{ session: vscode.DebugSession; done: Promise<number | null> }> {
    let id: string | undefined;
    const started = new Promise<vscode.DebugSession>((resolve) => {
      const sub = vscode.debug.onDidStartDebugSession((d) => {
        if (d.parentSession?.id === this.session.id && d.name === cfg.name) {
          id = d.id;
          sub.dispose();
          resolve(d);
        }
      });
    });
    const done = new Promise<number | null>((resolve) => {
      const sub = vscode.debug.onDidTerminateDebugSession((d) => {
        if (d.id !== id) return;
        sub.dispose();
        resolve(exitCodes.get(d.id) ?? null);
        exitCodes.delete(d.id);
      });
    });
    if (
      !(await vscode.debug.startDebugging(folder, cfg, {
        parentSession: this.session,
      }))
    )
      throw new Error(`"${cfg.name}" did not start`);
    return { session: await started, done };
  }

  private async start(
    s: PlannedStep,
    folder: vscode.WorkspaceFolder,
    config: RunConfig,
  ): Promise<Started | undefined> {
    const settings = readSettings();
    const term = (label = s.label) =>
      settings.showTerminals ? terminal(`step ${s.n}: ${label}`) : undefined;
    const id = `run:${config.name}:${s.n}`;
    switch (s.kind) {
      case "wait":
        return undefined;
      case "task": {
        const want = (s.step as TaskStep).task;
        const t = (await vscode.tasks.fetchTasks()).find(
          (t) =>
            t.name === want ||
            `${t.source}: ${t.name}` === want ||
            `${t.definition.type}: ${t.name}` === want,
        );
        if (!t) throw new Error(`no task is named "${want}"`);
        const same = (e: { execution: vscode.TaskExecution }) =>
          e.execution.task.name === t.name &&
          e.execution.task.source === t.source;
        const done = new Promise<number | null>((resolve) => {
          const subs = [
            vscode.tasks.onDidEndTaskProcess((e) => {
              if (!same(e)) return;
              subs.forEach((x) => x.dispose());
              resolve(e.exitCode ?? null);
            }),
            // A task without a process (a compound) ends without a code.
            vscode.tasks.onDidEndTask((e) => {
              if (same(e)) setTimeout(() => resolve(null), 200);
            }),
          ];
        });
        const exec = await vscode.tasks.executeTask(t);
        return {
          done,
          stop: async () => {
            exec.terminate();
            return "terminated";
          },
        };
      }
      case "launch": {
        const name = (s.step as LaunchStep).launch;
        const cfg = launchEntries(folder).find(
          (c) => c.name === name,
        ) as vscode.DebugConfiguration;
        if (cfg.type === "java" && !vscode.extensions.getExtension(DEBUGGER))
          throw new Error(`"${name}" needs the Java debugger (${DEBUGGER})`);
        // Decision 12: the debugger's JVM is not ours, but it is in the sum, estimated.
        const vm = [cfg.vmArgs ?? []].flat().join(" ");
        const est =
          cfg.type === "java"
            ? this.core.processes.declare({
                id: `launch:${name}`,
                label: `${name} (estimated)`,
                memoryMiB: /-Xmx/.test(vm)
                  ? Math.round(parseXmx(vm) / 2 ** 20)
                  : settings.defaultMemoryMiB,
              })
            : undefined;
        try {
          const c = await this.child(folder, cfg);
          void c.done.finally(() => est?.dispose());
          return {
            done: c.done,
            stop: async () => {
              await vscode.debug.stopDebugging(c.session);
              return "stopped";
            },
          };
        } catch (e) {
          est?.dispose();
          throw e;
        }
      }
      case "process": {
        const p = s.step as ProcessStep;
        return startProcess(
          this.core.processes,
          s,
          {
            id,
            argv: p.process as [string, ...string[]],
            cwd: p.cwd ?? folder.uri.fsPath,
            env: { ...this.jdk(folder).env, ...p.env },
            stop: p.stop,
            stopGraceMs: config.stopGraceMs,
          },
          term(),
        );
      }
      case "server":
        return this.server(s, folder, config, id, term);
    }
  }

  /** §6.4: the kind's pure functions handed to `process.start`, then the attach when asked. */
  private async server(
    s: PlannedStep,
    folder: vscode.WorkspaceFolder,
    config: RunConfig,
    id: string,
    term: () => ((t: string) => void) | undefined,
  ): Promise<Started> {
    const st = s.step as ServerStep;
    let debug = !!st.debug;
    if (debug && !vscode.extensions.getExtension(DEBUGGER)) {
      // An agent nobody attaches to is an open port for nothing (§4.3).
      this.say(`step ${s.n}: debug ignored: debugger not installed`);
      debug = false;
    }
    const { runtime, env } = this.jdk(folder);
    const h = await startServer(
      this.core.processes,
      s,
      this.core.registries.kinds.get(st.server)!,
      {
        id,
        run: config.name,
        storageDir: (
          this.core.context.storageUri ?? this.core.context.globalStorageUri
        ).fsPath,
        folders: [folder, ...(vscode.workspace.workspaceFolders ?? [])].map(
          (f) => f.uri.fsPath,
        ),
        env,
        runtime,
        debug,
        stopGraceMs: config.stopGraceMs,
        goal: (g) => {
          const snap = this.core.snapshot();
          const fsnap =
            snap?.folders.find((f) => f.folder === folder.uri.fsPath) ??
            snap?.folders[0];
          if (!snap || !fsnap)
            throw new Error("the project is not detected yet");
          return goalCommand({ type: "batlehub-java", ...g }, fsnap, snap);
        },
      },
      term(),
    );
    if (!debug) return h;
    let attach: vscode.DebugSession | undefined;
    return {
      ...h,
      // JDWP on localhost only, every kind (§4.2, decision 10).
      ready: h.ready!.then(async () => {
        attach = (
          await this.child(folder, {
            type: "java",
            request: "attach",
            name: `${s.label} (attach)`,
            hostName: "localhost",
            port: st.debugPort ?? 5005,
          })
        ).session;
      }),
      stop: async () => {
        if (attach) await vscode.debug.stopDebugging(attach);
        return h.stop();
      },
    };
  }
}

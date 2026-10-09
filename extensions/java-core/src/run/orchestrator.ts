// The run engine (RFC 0003 §5.1): start the planned steps in order, each
// waited on by its probe, then stop whatever started in reverse — on the
// last step's end, on a failure, on Stop. Imports nothing from `vscode`: the
// session hands it one function that starts a step, so the order, the probes
// and the stop cascade are Node tests over real processes.
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  KindGoal,
  ProcessSpec,
  Runtime,
  RunStepKind,
  ServerStep,
} from "../api-types";
import type { Manager } from "../process/managed";
import { NoExitCode, portOpen, waitReady } from "../process/probe";
import { describeProbe, resolveDeploy, type PlannedStep } from "./steps";

/** A step that started: a process, a server, a task, a launch. */
export interface Started {
  /** Resolves with the exit code when the step ends by itself. */
  done: Promise<number | null>;
  /** A managed process probes itself (its log matcher is attached before the spawn). */
  ready?: Promise<void>;
  /** The output so far, for a `log` probe on a step that is not a process. */
  output?(): string;
  /** Resolves with what the console prints after "stopping N (label) …". */
  stop(): Promise<string>;
  /** Stripped from a rejection of `ready`, so the console says "step N". */
  id?: string;
}

/** Starts one step; undefined for a wait step (nothing to start, only a probe). */
export type StartStep = (s: PlannedStep) => Promise<Started | undefined>;

export interface RunResult {
  ok: boolean;
  /** The last step's exit code, when it ended by itself. */
  exitCode?: number | null;
  error?: string;
}

/**
 * A process or server step is one `process.start`: the declared cap, the
 * step's probe (so the log matcher is attached before the spawn), the stop.
 */
export async function startProcess(
  m: Manager,
  s: PlannedStep,
  spec: Omit<ProcessSpec, "memoryMiB" | "ready">,
  onOutput?: (text: string) => void,
): Promise<Started> {
  const p = await m.start({ ...spec, memoryMiB: s.memoryMiB!, ready: s.probe });
  if (onOutput) p.onOutput(onOutput);
  const done = new Promise<number | null>((r) => p.onExit(r));
  return {
    id: p.id,
    ready: p.ready,
    done,
    stop: async () => {
      const r = await p.stop();
      return `stopped (${r.stage}) · peak ${r.peakRssMiB ?? "unknown"} MiB of ${p.memoryMiB}`;
    },
  };
}

const fsIo = {
  realpath: (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return undefined;
    }
  },
  list: (d: string) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  },
};

/**
 * A `server` step (§6.4): the deploy resolved inside the workspace, the
 * kind's base laid out under `storageDir/servers/<kind>/<run>/` (never the
 * repository), then its argv handed to `process.start` like any process.
 */
export async function startServer(
  m: Manager,
  s: PlannedStep,
  kind: RunStepKind,
  o: {
    id: string;
    run: string;
    storageDir: string;
    folders: string[];
    env: Record<string, string>;
    runtime: Runtime | undefined;
    /** False when the debugger is absent: no agent nobody attaches to. */
    debug: boolean;
    stopGraceMs?: number;
    /** The core's task command builder, for a kind that starts a `goal`. */
    goal?: (g: KindGoal) => {
      cmd: string;
      args: string[];
      env: Record<string, string>;
    };
  },
  onOutput?: (text: string) => void,
): Promise<Started> {
  const st = s.step as ServerStep;
  let deploy = st.deploy;
  if (deploy) {
    const r = resolveDeploy(deploy, o.folders, fsIo);
    if ("error" in r) throw new Error(r.error);
    deploy = r.path;
  }
  const opts: ServerStep = { ...st, deploy, debug: o.debug };
  const base = path.join(
    o.storageDir,
    "servers",
    kind.id,
    o.run.replace(/[^\w.-]+/g, "_"),
  );
  fs.mkdirSync(base, { recursive: true });
  const home = await kind.locate?.();
  await kind.prepare?.(home, base, opts);
  const g = kind.goal?.(opts);
  let a: { cmd: string; args: string[]; env?: Record<string, string> };
  if (g) {
    if (!o.goal)
      throw new Error(
        `${kind.id}: a goal kind needs the core's task environment`,
      );
    a = o.goal(g);
  } else if (kind.argv) a = kind.argv(home, base, o.runtime, opts);
  else throw new Error(`${kind.id}: the kind has neither goal nor argv`);
  return startProcess(
    m,
    s,
    {
      id: o.id,
      argv: [a.cmd, ...a.args, ...(st.extraArgs ?? [])],
      cwd: o.folders[0],
      env: { ...o.env, ...a.env },
      stop: kind.stop?.(home, base),
      stopGraceMs: o.stopGraceMs,
      kind: kind.id,
    },
    onOutput,
  );
}

const secs = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

export class Run {
  private readonly started: {
    s: PlannedStep;
    h: Started;
    code?: number | null;
    ended: boolean;
  }[] = [];
  private stopping?: "user";
  private stopSignal!: () => void;
  private readonly stopped = new Promise<"stop">((r) => {
    this.stopSignal = () => r("stop");
  });
  private finished?: Promise<RunResult>;

  constructor(
    private readonly steps: PlannedStep[],
    private readonly start: StartStep,
    private readonly say: (line: string) => void,
  ) {}

  run(): Promise<RunResult> {
    return (this.finished ??= this.go());
  }

  /** The Stop button: the cascade runs, then `run()` resolves. */
  async stop(): Promise<RunResult | undefined> {
    this.stopping ??= "user";
    this.stopSignal();
    return this.finished;
  }

  private async go(): Promise<RunResult> {
    let result: RunResult = { ok: true };
    try {
      for (const s of this.steps) {
        if (this.stopping) break;
        await this.one(s);
      }
      result = await this.untilLastEnds();
    } catch (e) {
      const error = (e as Error).message;
      this.say(error);
      result = { ok: false, error };
    }
    await this.stopAll();
    return result;
  }

  private async one(s: PlannedStep): Promise<void> {
    const name = `step ${s.n} (${s.label})`;
    if (s.defaultedMemory)
      this.say(
        `${name}: no memoryMiB, declares the default ${s.memoryMiB} MiB`,
      );
    // Someone else's process on the probed port would answer for ours.
    if (
      (s.kind === "process" || s.kind === "server") &&
      s.probe.port !== undefined &&
      (await portOpen(s.probe.port))
    )
      // ponytail: the owner's pid is not looked up (/proc/net/tcp → fd scan); add it when someone asks who.
      throw new Error(
        `step ${s.n}: port ${s.probe.port} is already in use by another process`,
      );
    const t0 = Date.now();
    let h: Started | undefined;
    try {
      h = await this.start(s);
    } catch (e) {
      if ((e as Error).name === "SkippedForMemory") {
        this.say(`step ${s.n} skipped (memory)`);
        return;
      }
      throw new Error(`step ${s.n}: ${(e as Error).message}`);
    }
    const entry = h && {
      s,
      h,
      ended: false as boolean,
      code: undefined as number | null | undefined,
    };
    if (entry) {
      this.started.push(entry);
      void h!.done.then((c) => {
        entry.ended = true;
        entry.code = c;
      });
    }
    const ready =
      h?.ready ??
      waitReady(s.probe, {
        output: h?.output,
        exited: h?.done,
        exitCode: () => (entry?.ended ? entry.code : undefined),
      });
    const r = await Promise.race([
      ready.then(
        () => "ok" as const,
        (e: Error) => e,
      ),
      this.stopped,
    ]);
    if (r === "stop") return;
    // Not every debugger reports a code: an implicit `exit` probe says so and
    // goes on; one the user wrote is a check, and fails.
    if (r instanceof NoExitCode && !s.step.ready) {
      this.say(`step ${s.n} ended (its debugger reports no exit code)`);
      return;
    }
    if (r instanceof Error) {
      const why = h?.id ? r.message.replace(`${h.id} `, "") : r.message;
      throw new Error(`step ${s.n} ${why}`);
    }
    this.say(
      s.probe.exit !== undefined
        ? `step ${s.n} exited ${s.probe.exit}`
        : `step ${s.n} ready (${describeProbe(s.probe)} in ${secs(t0)})`,
    );
  }

  /** §4.2: the run ends when the last step ends — a process or server holds it until Stop. */
  private async untilLastEnds(): Promise<RunResult> {
    const last = this.started.at(-1);
    if (this.stopping || !last || last.s !== this.steps.at(-1))
      return { ok: true };
    if (!last.ended) {
      const r = await Promise.race([last.h.done, this.stopped]);
      if (r === "stop") return { ok: true };
      last.ended = true;
      last.code = r;
    }
    // An `exit` probe already printed the code it accepted.
    if (last.s.probe.exit === undefined)
      this.say(`step ${last.s.n} exited ${last.code ?? "by signal"}`);
    return { ok: true, exitCode: last.code };
  }

  /** Reverse order, whatever ended the run; a failed stop is logged and the next proceeds. */
  private async stopAll(): Promise<void> {
    if (this.stopping === "user") this.say("stopped by user");
    for (const e of [...this.started].reverse()) {
      const name = `stopping ${e.s.n} (${e.s.label}) …`;
      if (e.ended) {
        this.say(`${name} already done`);
        continue;
      }
      const t0 = Date.now();
      try {
        this.say(`${name} ${await e.h.stop()} in ${secs(t0)}`);
      } catch (err) {
        this.say(`${name} failed: ${(err as Error).message}`);
      }
    }
  }
}

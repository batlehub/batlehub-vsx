// The managed process (RFC 0003 §5.2, §6.3): the one way anything
// long-lived starts in the series. A declared memory cap summed against the
// budget before the start, no shell, a readiness probe, a clean stop in
// three stages, the peak RSS recorded, and a pid file swept at the next
// activation. Imports nothing from `vscode`: trust, the over-budget question
// and the storage paths are the host's, so a real child process is a plain
// Node test.
import { spawn, type ChildProcess } from "node:child_process";
import type {
  Estimate,
  ManagedProcess,
  Probe,
  ProcessSpec,
  StopStage,
} from "../api-types";
import * as fs from "node:fs";
import { waitReady } from "./probe";
import { sum, verdict, overMessage, type Declared } from "./budget";
import { appendHistory, type HistoryEntry } from "./history";
import {
  parseStat,
  readEntries,
  readStat,
  terminate,
  writeEntries,
  type PidEntry,
} from "./sweep";

export type { ManagedProcess, Probe, ProcessSpec, StopStage };

/** Over budget, the user chose `Skip`: the satellite shows "not started — memory". */
export class SkippedForMemory extends Error {
  constructor(readonly id: string) {
    super(`${id}: not started — memory`);
    this.name = "SkippedForMemory";
  }
}

export interface Host {
  trusted(): boolean;
  /** What the core declares but does not start: JDT.LS from its vmargs. */
  declaredElsewhere(): Declared[];
  budgetMiB(): number;
  /** The cgroup limit, undefined on a laptop. */
  limitMiB(): number | undefined;
  /** The modal of §4.2; asked once per id per session. */
  ask(message: string, id: string): Promise<"start" | "skip" | "cancel">;
  pidFile: string;
  historyFile: string;
  stopGraceMs(): number;
  log(line: string): void;
  /** The running set changed: the JDK tab's sum is stale. */
  changed?(): void;
}

const SAMPLE_MS = 5000;
/** The `log` probe keeps this much of the output to match a line split across chunks. */
const LOG_WINDOW = 64 * 1024;

/**
 * RSS of a process group from `/proc`: `VmHWM` of the leader (its own peak)
 * and `VmRSS` of every other member. Undefined off Linux.
 */
export function groupRssMiB(pgid: number): number | undefined {
  let dirs: string[];
  try {
    dirs = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return undefined;
  }
  let kib = 0;
  let seen = false;
  for (const d of dirs) {
    const st = readStat(Number(d));
    if (!st || parseStat(st)?.pgrp !== pgid) continue;
    let status: string;
    try {
      status = fs.readFileSync(`/proc/${d}/status`, "utf8");
    } catch {
      continue;
    }
    const key = Number(d) === pgid ? "VmHWM" : "VmRSS";
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(status);
    if (m) {
      kib += Number(m[1]);
      seen = true;
    }
  }
  return seen ? Math.round(kib / 1024) : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Manager {
  private readonly live = new Map<string, ManagedProcess>();
  private readonly answers = new Map<string, "start" | "skip">();
  private readonly estimates = new Map<string, Estimate>();
  private readonly kinds = new Map<string, string>();

  constructor(private readonly host: Host) {}

  /** The running caps and the estimates, for the JDK tab and the next sum. */
  declared(): Declared[] {
    return [
      ...[...this.live.values()].map((p) => ({ id: p.id, mib: p.memoryMiB })),
      ...[...this.estimates.values()].map((e) => ({
        id: e.id,
        mib: e.memoryMiB,
        label: e.label,
        estimate: true,
      })),
    ];
  }

  /** A JVM another extension starts: in the sum until disposed, never managed. */
  declare(e: Estimate): { dispose(): void } {
    if (!Number.isInteger(e.memoryMiB) || e.memoryMiB <= 0)
      throw new Error(`${e.id}: memoryMiB must be a positive integer`);
    this.estimates.set(e.id, e);
    this.host.changed?.();
    return {
      dispose: () => {
        if (this.estimates.get(e.id) === e) this.estimates.delete(e.id);
        this.host.changed?.();
      },
    };
  }

  async start(spec: ProcessSpec): Promise<ManagedProcess> {
    const h = this.host;
    if (!h.trusted())
      throw new Error(`${spec.id}: not started — the workspace is not trusted`);
    if (!Array.isArray(spec.argv) || !spec.argv.length)
      throw new Error(`${spec.id}: argv must be a non-empty array`);
    if (!Number.isInteger(spec.memoryMiB) || spec.memoryMiB <= 0)
      throw new Error(`${spec.id}: memoryMiB must be a positive integer`);
    const limit = h.limitMiB();
    if (limit !== undefined && spec.memoryMiB > limit)
      throw new Error(
        `${spec.id}: memoryMiB ${spec.memoryMiB} is above the container limit (${limit} MiB)`,
      );
    const running = this.live.get(spec.id);
    if (running)
      throw new Error(`${spec.id}: already running (pid ${running.pid})`);

    const all = [
      ...h.declaredElsewhere(),
      ...this.declared(),
      { id: spec.id, mib: spec.memoryMiB },
    ];
    const total = sum(all);
    if (verdict(total, h.budgetMiB(), limit) === "over") {
      const msg = overMessage(total, h.budgetMiB(), limit, spec.id);
      let a = this.answers.get(spec.id);
      if (!a) {
        const r = await h.ask(msg, spec.id);
        if (r === "cancel") throw new Error(`${spec.id}: cancelled — memory`);
        a = r;
        this.answers.set(spec.id, a);
      }
      h.log(`${msg} → ${a === "skip" ? "skipped (memory)" : "started anyway"}`);
      if (a === "skip") throw new SkippedForMemory(spec.id);
    }
    return this.spawn(spec);
  }

  private async spawn(spec: ProcessSpec): Promise<ManagedProcess> {
    const h = this.host;
    const streams = spec.stdio === "streams";
    const child: ChildProcess = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Attached before the first tick: no line can scroll past the matcher.
    const outputs = new Set<(t: string) => void>();
    const exits = new Set<(c: number | null) => void>();
    let buffer = "";
    const feed = (b: Buffer) => {
      const t = String(b);
      buffer = (buffer + t).slice(-LOG_WINDOW);
      for (const f of outputs) f(t);
    };
    if (!streams) child.stdout!.on("data", feed);
    child.stderr!.on("data", feed);

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (e) =>
        reject(new Error(`${spec.id}: ${spec.argv[0]}: ${e.message}`)),
      );
    });
    const pid = child.pid!;
    const startedAt = new Date().toISOString();
    const stat = parseStat(readStat(pid) ?? "");
    const entry: PidEntry = {
      id: spec.id,
      pid,
      pgid: pid,
      startTicks: stat?.startTicks ?? 0,
      argv0: spec.argv[0],
      startedAt,
    };
    writeEntries(h.pidFile, [...readEntries(h.pidFile), entry]);

    let exitCode: number | null | undefined;
    let peak = groupRssMiB(pid);
    const sample = () => {
      const now = groupRssMiB(pid);
      if (now !== undefined) peak = Math.max(peak ?? 0, now);
    };
    const sampler = setInterval(sample, SAMPLE_MS);
    let stopping:
      Promise<{ peakRssMiB?: number; stage: StopStage }> | undefined;

    const finish = (stage: StopStage) => {
      clearInterval(sampler);
      this.live.delete(spec.id);
      this.kinds.delete(spec.id);
      writeEntries(
        h.pidFile,
        readEntries(h.pidFile).filter((e) => e.pid !== pid),
      );
      const rec: HistoryEntry = {
        id: spec.id,
        declaredMiB: spec.memoryMiB,
        peakRssMiB: peak,
        startedAt,
        stoppedAt: new Date().toISOString(),
        stage,
      };
      appendHistory(h.historyFile, rec);
      h.changed?.();
      if (peak !== undefined && peak > spec.memoryMiB)
        h.log(
          `${spec.id}: peak ${peak} MiB is above its declared ${spec.memoryMiB} MiB`,
        );
      return { peakRssMiB: peak, stage };
    };

    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => {
        exitCode = code;
        resolve(exitCode);
        for (const f of exits) f(exitCode);
        if (!stopping) {
          h.log(`${spec.id} exited ${exitCode ?? "by signal"}`);
          finish("exited");
        }
      }),
    );

    const ready = waitReady(spec.ready ?? {}, {
      output: () => buffer,
      exited,
      exitCode: () => exitCode,
    }).then(
      () => {
        h.log(`${spec.id} ready`);
      },
      (e: Error) => {
        throw new Error(`${spec.id} ${e.message}`);
      },
    );
    ready.catch(() => {});

    const mp: ManagedProcess = {
      id: spec.id,
      pid,
      memoryMiB: spec.memoryMiB,
      ready,
      onOutput: (f) => (outputs.add(f), () => outputs.delete(f)),
      onExit: (f) => (exits.add(f), () => exits.delete(f)),
      streams: streams
        ? { reader: child.stdout!, writer: child.stdin! }
        : undefined,
      stop: () =>
        (stopping ??= (async () => {
          if (exitCode !== undefined)
            return { peakRssMiB: peak, stage: "exited" as const };
          sample();
          const grace = spec.stopGraceMs ?? h.stopGraceMs();
          const t0 = Date.now();
          let stage: StopStage | undefined;
          if (spec.stop) {
            if ("stdin" in spec.stop) {
              // The caller's own stdin when it holds the streams: not ours to write.
              if (!streams) child.stdin!.write(spec.stop.stdin);
            } else
              spawn(spec.stop.cmd, spec.stop.args, {
                cwd: spec.cwd,
                shell: false,
                stdio: "ignore",
              }).on("error", () => {});
            const done = await Promise.race([
              exited.then(() => true),
              sleep(grace).then(() => false),
            ]);
            if (done) stage = "graceful";
          }
          stage ??= await terminate(entry, grace);
          await Promise.race([exited, sleep(1000)]);
          h.log(
            `stopped ${spec.id} (${stage}) in ${((Date.now() - t0) / 1000).toFixed(1)} s · peak ${peak ?? "unknown"} MiB of ${spec.memoryMiB}`,
          );
          return finish(stage);
        })()),
    };
    this.live.set(spec.id, mp);
    if (spec.kind) this.kinds.set(spec.id, spec.kind);
    h.changed?.();
    h.log(`started ${spec.id} (pid ${pid}, ${spec.memoryMiB} MiB declared)`);
    return mp;
  }

  /** What is running now (contract 1.1 `process.running()`). */
  running(): { id: string; pid: number; memoryMiB: number; kind?: string }[] {
    return [...this.live.values()].map((p) => ({
      id: p.id,
      pid: p.pid,
      memoryMiB: p.memoryMiB,
      kind: this.kinds.get(p.id),
    }));
  }

  /** `deactivate()`: everything still running, in reverse start order. */
  async stopAll(): Promise<void> {
    for (const p of [...this.live.values()].reverse()) {
      try {
        await p.stop();
      } catch (e) {
        this.host.log(`stop ${p.id}: ${(e as Error).message}`);
      }
    }
  }
}

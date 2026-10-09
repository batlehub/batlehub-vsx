// A `batlehub-run` entry of launch.json (RFC 0003 §4.1, §6.1): an ordered
// list of steps, each with a readiness probe. Pure: what is runnable, the
// default probes and the plan. The session (`session.ts`) starts the steps
// and the engine (`orchestrator.ts`) orders and stops them.
import * as path from "node:path";
import type { Probe, ServerStep } from "../api-types";

export interface TaskStep {
  task: string;
  ready?: Probe;
}
export interface LaunchStep {
  launch: string;
  ready?: Probe;
}
export interface ProcessStep {
  process: string[];
  cwd?: string;
  env?: Record<string, string>;
  memoryMiB?: number;
  ready?: Probe;
  stop?: { cmd: string; args: string[] };
}
export interface WaitStep {
  ready: Probe;
}
export type Step = TaskStep | LaunchStep | ProcessStep | ServerStep | WaitStep;

export interface RunConfig {
  type: "batlehub-run";
  name: string;
  request?: string;
  steps: Step[];
  stopGraceMs?: number;
}

export type StepKind = "task" | "launch" | "process" | "server" | "wait";
const COMMANDS = ["task", "launch", "process", "server"] as const;

/** The step's kind, or undefined when it has several commands, or none and no probe. */
export function kindOf(step: unknown): StepKind | undefined {
  if (!step || typeof step !== "object") return undefined;
  const has = COMMANDS.filter((k) => k in step);
  if (has.length > 1) return undefined;
  if (has.length === 1) return has[0];
  return "ready" in step ? "wait" : undefined;
}

export interface PlannedStep {
  /** 1-based, as the console names it. */
  n: number;
  kind: StepKind;
  step: Step;
  probe: Probe;
  /** What the console and the terminal call it: the task, the launch, argv[0], the kind. */
  label: string;
  /** Declared for process and server steps. */
  memoryMiB?: number;
  /** True when the step declares `run.defaultMemoryMiB` because it named none. */
  defaultedMemory?: boolean;
}

/**
 * An implicit `exit` probe waits as long as the build or the test run takes:
 * the 60 s default is for readiness, not for `maven package`. (2³¹−1 ms is
 * the longest timer Node keeps; a larger one fires at once.)
 */
export const NO_TIMEOUT = 2 ** 31 - 1;

/** §4.1's table: what a step waits on when it names no probe. */
export function defaultProbe(
  kind: StepKind,
  step: Step,
  last: boolean,
  kindProbe?: (s: ServerStep) => Probe,
): Probe {
  if (step.ready) return step.ready;
  switch (kind) {
    case "task":
      return { exit: 0, timeoutMs: NO_TIMEOUT };
    // A last launch ends the run when it exits, and is judged by its code.
    case "launch":
      return last ? { exit: 0, timeoutMs: NO_TIMEOUT } : {};
    case "server":
      return kindProbe?.(step as ServerStep) ?? {};
    default:
      return {};
  }
}

const isPosInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;

/** §4.3's hard errors, one message each; empty means runnable. */
export function validate(
  config: { name?: unknown; steps?: unknown },
  known: { launches: string[]; kinds: string[]; limitMiB?: number },
): string[] {
  if (!Array.isArray(config.steps) || !config.steps.length)
    return ["`steps` must be a non-empty array"];
  const out: string[] = [];
  config.steps.forEach((step: Record<string, unknown>, i) => {
    const n = `step ${i + 1}`;
    const kind = kindOf(step);
    if (!kind) {
      out.push(
        `${n}: exactly one of task, launch, process or server — or none and a ready probe`,
      );
      return;
    }
    if (kind === "launch") {
      if (step.launch === config.name)
        out.push(`${n}: launch names the run itself`);
      else if (!known.launches.includes(step.launch as string))
        out.push(`${n}: no launch.json entry is named "${step.launch}"`);
    }
    if (kind === "process" && !Array.isArray(step.process)) {
      const argv =
        typeof step.process === "string"
          ? JSON.stringify(step.process.split(/\s+/).filter(Boolean))
          : '["cmd", "arg"]';
      out.push(`${n}: process must be an array, never a shell string: ${argv}`);
    } else if (
      kind === "process" &&
      (!(step.process as unknown[]).length ||
        !(step.process as unknown[]).every((a) => typeof a === "string"))
    )
      out.push(`${n}: process must be a non-empty array of strings`);
    if (kind === "server" && !known.kinds.includes(step.server as string))
      out.push(
        `${n}: no step kind "${step.server}" is registered (registered: ${known.kinds.join(", ") || "none"})`,
      );
    if (step.memoryMiB !== undefined) {
      if (!isPosInt(step.memoryMiB))
        out.push(`${n}: memoryMiB must be a positive integer`);
      else if (
        known.limitMiB !== undefined &&
        (step.memoryMiB as number) > known.limitMiB
      )
        out.push(
          `${n}: memoryMiB ${step.memoryMiB} is above the container limit (${known.limitMiB} MiB)`,
        );
    }
  });
  return out;
}

/** The steps with their defaults, in order; the stop order is its reverse. */
export function plan(
  config: RunConfig,
  defaults: {
    memoryMiB: number;
    kinds: Map<
      string,
      { defaultMemoryMiB: number; defaultProbe(s: ServerStep): Probe }
    >;
  },
): PlannedStep[] {
  return config.steps.map((step, i) => {
    const kind = kindOf(step)!;
    const last = i === config.steps.length - 1;
    const k =
      kind === "server"
        ? defaults.kinds.get((step as ServerStep).server)
        : undefined;
    const p: PlannedStep = {
      n: i + 1,
      kind,
      step,
      probe: defaultProbe(kind, step, last, k && ((s) => k.defaultProbe(s))),
      label:
        kind === "task"
          ? (step as TaskStep).task
          : kind === "launch"
            ? (step as LaunchStep).launch
            : kind === "process"
              ? path.basename((step as ProcessStep).process[0] ?? "")
              : kind === "server"
                ? (step as ServerStep).server
                : "wait",
    };
    if (kind === "process" || kind === "server") {
      const own = (step as ProcessStep).memoryMiB;
      p.memoryMiB = own ?? k?.defaultMemoryMiB ?? defaults.memoryMiB;
      p.defaultedMemory = own === undefined && !k;
    }
    return p;
  });
}

/** What a ready line says the step waited on: "port 8080", "http 200", "log", "exit 0", "alive". */
export function describeProbe(p: Probe): string {
  if (p.port !== undefined) return `port ${p.port}`;
  if (p.http) return `http ${p.http}`;
  if (p.log) return `log /${p.log}/`;
  if (p.exit !== undefined) return `exit ${p.exit}`;
  return "alive";
}

/**
 * A `deploy` (§4.3): a path must resolve, symlinks followed, under a
 * workspace folder; a module name is the first `.war`/`.jar` (by name) of its
 * `target/` or `build/libs/`. The file system is injected, so this stays pure.
 */
export function resolveDeploy(
  deploy: string,
  folders: string[],
  io: {
    realpath(p: string): string | undefined;
    list(dir: string): string[];
  },
): { path: string } | { error: string } {
  const roots = folders.map((f) => io.realpath(f) ?? f);
  const inside = (p: string) =>
    roots.some((r) => p === r || p.startsWith(r + path.sep));
  const isPath = /[\\/]/.test(deploy) || /\.(war|jar|ear)$/.test(deploy);
  if (isPath) {
    const abs = path.isAbsolute(deploy)
      ? deploy
      : path.join(folders[0] ?? "", deploy);
    const real = io.realpath(abs);
    if (!real) return { error: `deploy: ${deploy} does not exist` };
    if (!inside(real))
      return {
        error: `deploy: ${deploy} resolves to ${real}, outside every workspace folder`,
      };
    return { path: real };
  }
  for (const root of roots) {
    const mod = path.join(root, deploy);
    for (const dir of ["target", path.join("build", "libs")]) {
      const hit = io
        .list(path.join(mod, dir))
        .filter(
          (f) =>
            /\.(war|jar)$/.test(f) && !/-(sources|javadoc|plain)\.jar$/.test(f),
        )
        .sort()[0];
      if (hit) return { path: path.join(mod, dir, hit) };
    }
  }
  return {
    error: `deploy: module "${deploy}" has no packaged artifact — run \`maven package\` first (a task step does)`,
  };
}

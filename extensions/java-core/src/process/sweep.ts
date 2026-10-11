// Orphans (RFC 0003 §4.2, decision 9): every start is in
// `<workspaceStorage>/processes.json`; at activation an entry whose pid
// still has the recorded kernel start time is stopped — a recycled pid is
// never signalled — and the file is emptied.
import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "@batlehub/java-rules/io";
import { alive } from "@batlehub/java-rules/ledger";

export interface PidEntry {
  id: string;
  pid: number;
  pgid: number;
  startTicks: number;
  argv0: string;
  startedAt: string;
}

/**
 * Fields of `/proc/<pid>/stat` after the command name: read after the
 * *last* `)`, so a name holding `) (` cannot shift them. Field 5 is the
 * process group, field 22 the start time in clock ticks.
 */
export function parseStat(
  text: string,
): { pgrp: number; startTicks: number } | undefined {
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const f = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  // f[0] is field 3 (state).
  const pgrp = Number(f[2]);
  const startTicks = Number(f[19]);
  return Number.isFinite(startTicks) && Number.isFinite(pgrp)
    ? { pgrp, startTicks }
    : undefined;
}

export type SweepDecision = "gone" | "recycled" | "stop";

export function decide(e: PidEntry, stat: string | undefined): SweepDecision {
  const s = stat === undefined ? undefined : parseStat(stat);
  if (!s) return "gone";
  return s.startTicks === e.startTicks ? "stop" : "recycled";
}

/**
 * Off Linux there is no `/proc` and no start time (RFC 0003 §9): the pid
 * alive and running the program it was started as is ours; another program
 * behind the same pid is a recycled one, never signalled.
 */
export function decideByName(
  e: Pick<PidEntry, "argv0">,
  isAlive: boolean,
  comm: string | undefined,
): SweepDecision {
  if (!isAlive) return "gone";
  const name = (s: string) => path.basename(s.trim());
  return comm && name(comm) === name(e.argv0) ? "stop" : "recycled";
}

/** The decision for one entry, by `/proc` on Linux and by `kill(pid, 0)` + `ps -o comm=` elsewhere. */
export async function stateOf(
  e: Pick<PidEntry, "pid" | "startTicks" | "argv0">,
): Promise<SweepDecision> {
  if (process.platform === "linux")
    return decide(e as PidEntry, readStat(e.pid));
  if (!alive(e.pid)) return "gone";
  const ps = await run("ps", ["-o", "comm=", "-p", String(e.pid)], {
    timeout: 5000,
  });
  return decideByName(e, true, ps.code === 0 ? ps.stdout : undefined);
}

export function readStat(pid: number): string | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
}

export function readEntries(file: string): PidEntry[] {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(v) ? (v as PidEntry[]) : [];
  } catch {
    return [];
  }
}

export function writeEntries(file: string, entries: PidEntry[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const signal = (pgid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(-pgid, sig);
  } catch {
    // already gone
  }
};

/** SIGTERM to the group, SIGKILL after `graceMs` if the same process is still there. */
export async function terminate(
  e: Pick<PidEntry, "pid" | "pgid" | "startTicks" | "argv0">,
  graceMs: number,
): Promise<"term" | "kill"> {
  signal(e.pgid, "SIGTERM");
  const until = Date.now() + graceMs;
  while (Date.now() < until) {
    if ((await stateOf(e)) !== "stop") return "term";
    await sleep(50);
  }
  signal(e.pgid, "SIGKILL");
  return "kill";
}

export async function sweep(
  file: string,
  graceMs: number,
): Promise<{ entry: PidEntry; stage: "term" | "kill" }[]> {
  const out: { entry: PidEntry; stage: "term" | "kill" }[] = [];
  for (const e of readEntries(file))
    if ((await stateOf(e)) === "stop")
      out.push({ entry: e, stage: await terminate(e, graceMs) });
  if (fs.existsSync(file)) writeEntries(file, []);
  return out;
}

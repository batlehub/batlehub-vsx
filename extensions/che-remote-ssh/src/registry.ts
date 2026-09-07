// The forwards that exist on this machine, written down.
//
// A tunnel must outlive the window that opened it: closing the window you
// started from should not drop the session you started. So `kubectl
// port-forward` is spawned detached, and what would otherwise be lost with
// the process that spawned it is written here instead.
//
// The file is what any window reads to reclaim a tunnel nothing uses any
// more, whether or not the window that opened it is still around.
//
// A pid is not on its own a licence to kill: pids are reused. Before
// signalling one, what is running under it is checked to still look like the
// forward that was recorded.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

export interface ForwardRecord {
  /** `ssh-remote+<workspace>`, the same key a lease is filed under. */
  authority: string;
  namespace: string;
  pod: string;
  port: number;
  pid: number;
  /** When it was started, in milliseconds since the epoch. */
  since: number;
}

export function recordFileName(authority: string): string {
  const safe = authority.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return `${safe || "unnamed"}.forward`;
}

export async function writeRecord(dir: string, record: ForwardRecord): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, recordFileName(record.authority)), JSON.stringify(record), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function forgetRecord(dir: string, authority: string): Promise<void> {
  await rm(path.join(dir, recordFileName(authority)), { force: true });
}

function isRecord(value: unknown): value is ForwardRecord {
  const d = value as Record<string, unknown> | null;
  return (
    typeof d?.authority === "string" &&
    typeof d.namespace === "string" &&
    typeof d.pod === "string" &&
    typeof d.port === "number" &&
    typeof d.pid === "number" &&
    typeof d.since === "number"
  );
}

export async function readRecords(dir: string): Promise<ForwardRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: ForwardRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".forward")) continue;
    try {
      const doc: unknown = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      if (isRecord(doc)) out.push(doc);
    } catch {
      // A half-written record is not a record.
    }
  }
  return out;
}

export interface ProcessProbe {
  /** Does anything run under this pid? */
  alive: (pid: number) => boolean;
  /** The command line of that process, when the platform offers one. */
  commandLine?: (pid: number) => string | undefined;
}

export const nodeProbe: ProcessProbe = {
  alive: (pid) => {
    try {
      // Signal 0 asks the kernel about the process without touching it.
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  commandLine: (pid) => {
    if (process.platform !== "linux") return undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require("node:fs").readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      return undefined;
    }
  },
};

/**
 * Is this pid still the forward that was recorded? Existence alone is not
 * enough, because the number will eventually belong to something else. Where
 * a command line can be read, it has to still name a port-forward for this
 * pod; where it cannot, existence is all there is and is accepted.
 */
export function stillOurs(record: ForwardRecord, probe: ProcessProbe = nodeProbe): boolean {
  if (!probe.alive(record.pid)) return false;
  const line = probe.commandLine?.(record.pid);
  if (line === undefined) return true;
  return line.includes("port-forward") && line.includes(record.pod);
}

/** Stop a forward that is still the one recorded. Silent when it has gone. */
export function killRecord(record: ForwardRecord, probe: ProcessProbe = nodeProbe): boolean {
  if (!stillOurs(record, probe)) return false;
  try {
    process.kill(record.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

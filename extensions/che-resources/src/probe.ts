// The rules, without the editor: what each resource reads, from the cgroup of
// the container when there is one (a pod's limits, not the node's), and when a
// reading has just gone over its threshold.
import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const KINDS = ["disk", "inodes", "memory", "cpu", "pids"] as const;
export type Kind = (typeof KINDS)[number];

export interface Reading {
  kind: Kind;
  /** What is measured: a project path for disk and inodes, empty otherwise. */
  where: string;
  /** Used, in percent of the limit. */
  pct: number;
  /** Used and limit, for a human: "15.2 GiB of 16.0 GiB". */
  detail: string;
}

export const CGROUP = "/sys/fs/cgroup";

// A folder that is a git project, or holds some one level down: the layout of
// /projects in a Che workspace.
export function gitProjects(dirs: string[]): string[] {
  const out = new Set<string>();
  for (const d of dirs) {
    if (existsSync(path.join(d, ".git"))) {
      out.add(d);
      continue;
    }
    try {
      for (const e of readdirSync(d, { withFileTypes: true }))
        if (e.isDirectory() && existsSync(path.join(d, e.name, ".git")))
          out.add(path.join(d, e.name));
    } catch {
      // gone or unreadable: nothing to watch there
    }
  }
  return [...out];
}

// Space and inodes, one pair per filesystem: twenty projects on one volume are one disk.
export function disks(projects: string[]): Reading[] {
  const seen = new Set<number>();
  const out: Reading[] = [];
  for (const p of projects) {
    try {
      const dev = statSync(p).dev;
      if (seen.has(dev)) continue;
      seen.add(dev);
      const s = statfsSync(p);
      // bavail, not bfree: the blocks reserved for root are not ours to write.
      const size = s.blocks * s.bsize;
      const used = size - s.bavail * s.bsize;
      out.push({
        kind: "disk",
        where: p,
        pct: pct(used, size),
        detail: `${human(used)} of ${human(size)}`,
      });
      // A filesystem without an inode table (btrfs, some overlays) reports 0 files.
      if (s.files)
        out.push({
          kind: "inodes",
          where: p,
          pct: pct(s.files - s.ffree, s.files),
          detail: `${s.files - s.ffree} of ${s.files} inodes`,
        });
    } catch {
      // removed between the scan and the stat
    }
  }
  return out;
}

// The working set, as the kubelet and the OOM killer count it: the page cache
// that can be dropped (inactive_file) is not pressure.
export function memory(cg = CGROUP): Reading {
  const max = read(cg, "memory.max");
  const current = read(cg, "memory.current");
  if (current !== undefined) {
    const inactive = Number(/^inactive_file (\d+)$/m.exec(text(cg, "memory.stat") ?? "")?.[1] ?? 0);
    const limit = max ?? os.totalmem();
    const used = Math.max(0, current - inactive);
    return {
      kind: "memory",
      where: "",
      pct: pct(used, limit),
      detail: `${human(used)} of ${human(limit)}`,
    };
  }
  const used = os.totalmem() - os.freemem();
  return {
    kind: "memory",
    where: "",
    pct: pct(used, os.totalmem()),
    detail: `${human(used)} of ${human(os.totalmem())}`,
  };
}

// CPU is a rate: the reading is the average since the previous sample, against
// the quota of cpu.max, or every CPU the container may run on when unlimited.
export function cpuSampler(cg = CGROUP, now = () => performance.now()): () => Reading | undefined {
  const usage = (): number | undefined => {
    const m = /^usage_usec (\d+)$/m.exec(text(cg, "cpu.stat") ?? "");
    if (m) return Number(m[1]);
    // no cgroup: the host's own counters, in µs
    return (
      os.cpus().reduce((a, c) => a + c.times.user + c.times.sys + c.times.nice + c.times.irq, 0) *
      1000
    );
  };
  const [quota, period] = (text(cg, "cpu.max") ?? "max").trim().split(/\s+/);
  const cores =
    quota && quota !== "max" ? Number(quota) / Number(period) : os.availableParallelism();
  let last = { at: now(), usec: usage() };
  return () => {
    const next = { at: now(), usec: usage() };
    const elapsed = (next.at - last.at) * 1000;
    // Under a second the average is noise: keep the older sample for the next call.
    if (elapsed < 1e6) return undefined;
    const prev = last;
    last = next;
    if (prev.usec === undefined || next.usec === undefined) return undefined;
    const used = (next.usec - prev.usec) / elapsed; // in cores
    return {
      kind: "cpu",
      where: "",
      pct: pct(used, cores),
      detail: `${used.toFixed(2)} of ${+cores.toFixed(2)} cores`,
    };
  };
}

// Processes: a pod's pids.max is the wall a `fork` runs into. No limit, no reading.
export function pids(cg = CGROUP): Reading | undefined {
  const max = read(cg, "pids.max");
  const current = read(cg, "pids.current");
  if (max === undefined || current === undefined) return undefined;
  return {
    kind: "pids",
    where: "",
    pct: pct(current, max),
    detail: `${current} of ${max} processes`,
  };
}

// The readings that went over their threshold since the last call; `high`
// carries the state between calls, so a resource warns once, not every tick,
// and warns again after it has come back under. A threshold of 0 is off.
export function crossings(
  rs: Reading[],
  thresholds: Record<Kind, number>,
  high: Set<string>,
): Reading[] {
  const out: Reading[] = [];
  for (const r of rs) {
    const key = `${r.kind}:${r.where}`;
    if (!over(r, thresholds)) high.delete(key);
    else if (!high.has(key)) {
      high.add(key);
      out.push(r);
    }
  }
  return out;
}

export const over = (r: Reading, thresholds: Record<Kind, number>): boolean =>
  thresholds[r.kind] > 0 && r.pct >= thresholds[r.kind];

export function human(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

const pct = (used: number, limit: number): number => (limit > 0 ? (used / limit) * 100 : 0);

function text(cg: string, file: string): string | undefined {
  try {
    return readFileSync(path.join(cg, file), "utf8");
  } catch {
    return undefined;
  }
}

// A cgroup number; "max" (no limit) and a missing file are both undefined.
function read(cg: string, file: string): number | undefined {
  const t = text(cg, file)?.trim();
  return t && t !== "max" ? Number(t) : undefined;
}

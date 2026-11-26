import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cpuSampler,
  crossings,
  disks,
  gitProjects,
  human,
  memory,
  pids,
  type Kind,
  type Reading,
} from "../src/probe";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "che-resources-"));
// A fake cgroup v2 directory: one file per entry.
const cgroup = (files: Record<string, string>) => {
  const d = tmp();
  for (const [f, v] of Object.entries(files)) writeFileSync(path.join(d, f), v);
  return d;
};
const T: Record<Kind, number> = { disk: 95, inodes: 95, memory: 90, cpu: 90, pids: 0 };
const r = (kind: Kind, pct: number, where = ""): Reading => ({ kind, where, pct, detail: "" });

describe("gitProjects", () => {
  it("finds a project, or the projects one level under a folder", () => {
    const root = tmp();
    mkdirSync(path.join(root, "a", ".git"), { recursive: true });
    mkdirSync(path.join(root, "b"));
    mkdirSync(path.join(root, "c", ".git"), { recursive: true });
    expect(gitProjects([root]).sort()).toEqual([path.join(root, "a"), path.join(root, "c")]);
    expect(gitProjects([path.join(root, "a"), path.join(root, "missing")])).toEqual([
      path.join(root, "a"),
    ]);
  });
});

describe("disks", () => {
  it("reports one real filesystem once, space and inodes, with sane numbers", () => {
    const rs = disks([os.tmpdir(), os.tmpdir(), "/nonexistent"]);
    expect(rs.filter((x) => x.kind === "disk")).toHaveLength(1);
    expect(rs.filter((x) => x.kind === "inodes").length).toBeLessThanOrEqual(1);
    for (const x of rs)
      (expect(x.pct).toBeGreaterThanOrEqual(0), expect(x.pct).toBeLessThanOrEqual(100));
  });
});

describe("memory", () => {
  it("counts the working set against memory.max, page cache left out", () => {
    const cg = cgroup({
      "memory.max": "1000\n",
      "memory.current": "900\n",
      "memory.stat": "anon 1\ninactive_file 300\n",
    });
    expect(memory(cg)).toMatchObject({ kind: "memory", pct: 60 });
  });
  it("falls back to the host's memory without a limit or a cgroup", () => {
    expect(memory(cgroup({ "memory.max": "max\n", "memory.current": "0\n" })).pct).toBe(0);
    expect(memory("/nonexistent").pct).toBeGreaterThan(0);
  });
});

describe("cpu", () => {
  it("averages usage since the last sample against the quota", () => {
    const cg = cgroup({ "cpu.max": "200000 100000\n", "cpu.stat": "usage_usec 0\n" });
    let t = 0;
    const sample = cpuSampler(cg, () => t);
    t = 500;
    expect(sample()).toBeUndefined(); // under a second: noise
    t = 2000;
    writeFileSync(path.join(cg, "cpu.stat"), "usage_usec 3000000\n"); // 3 s of CPU in 2 s, on 2 cores
    expect(sample()).toMatchObject({ kind: "cpu", pct: 75 });
  });
  it("reads the host's counters without a cgroup", () => {
    let t = 0;
    const sample = cpuSampler("/nonexistent", () => t);
    t = 1000;
    expect(sample()?.pct).toBeGreaterThanOrEqual(0);
  });
});

describe("pids", () => {
  it("reads pids.max, and nothing when unlimited", () => {
    expect(pids(cgroup({ "pids.max": "200\n", "pids.current": "150\n" }))).toMatchObject({
      pct: 75,
    });
    expect(pids(cgroup({ "pids.max": "max\n", "pids.current": "150\n" }))).toBeUndefined();
  });
});

describe("crossings", () => {
  it("warns once per crossing, and again after coming back under", () => {
    const high = new Set<string>();
    expect(crossings([r("disk", 90, "/p")], T, high)).toEqual([]);
    expect(crossings([r("disk", 96, "/p")], T, high)).toEqual([r("disk", 96, "/p")]);
    expect(crossings([r("disk", 97, "/p")], T, high)).toEqual([]);
    expect(crossings([r("disk", 94, "/p")], T, high)).toEqual([]);
    expect(crossings([r("disk", 98, "/p")], T, high)).toEqual([r("disk", 98, "/p")]);
  });
  it("keeps each resource apart, and a threshold of 0 is off", () => {
    const high = new Set<string>();
    expect(crossings([r("memory", 95), r("cpu", 50), r("pids", 100)], T, high)).toEqual([
      r("memory", 95),
    ]);
    expect(crossings([r("memory", 95), r("cpu", 95)], T, high)).toEqual([r("cpu", 95)]);
  });
});

it("human", () => {
  expect(human(512)).toBe("512 B");
  expect(human(1536 * 1024 ** 2)).toBe("1.5 GiB");
});

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  effectiveBudget,
  overMessage,
  sum,
  verdict,
} from "../src/process/budget";
import { MAX_HISTORY, pushHistory, readHistory } from "../src/process/history";
import { Manager, SkippedForMemory, type Host } from "../src/process/managed";
import {
  decide,
  parseStat,
  readEntries,
  sweep,
  type PidEntry,
} from "../src/process/sweep";

describe("the sum (RFC 0003 §4.2)", () => {
  it("clamps the budget to the limit and asks nothing without one", () => {
    expect(
      sum([
        { id: "a", mib: 768 },
        { id: "b", mib: 512 },
      ]),
    ).toBe(1280);
    expect(effectiveBudget(8192, 4096)).toBe(4096);
    expect(effectiveBudget(8192, 16384)).toBe(8192);
    expect(verdict(1024, 1024, 16384)).toBe("fits");
    expect(verdict(1025, 1024, 16384)).toBe("over");
    expect(verdict(9000, 8192, 4096)).toBe("over");
    expect(verdict(99999, 8192, undefined)).toBe("fits");
    expect(overMessage(1280, 1024, 16384, "run:IT:2")).toBe(
      "run:IT:2: 1 280 MiB declared of a 1 024 MiB budget",
    );
  });
});

describe("the sweep's reading of /proc", () => {
  // A command name holding `) (` must not shift the fields.
  const stat = (ticks: number) =>
    `4242 (evil) (name) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${ticks} 1000 100`;
  it("reads pgrp and start time after the last parenthesis", () => {
    expect(parseStat(stat(777))).toEqual({ pgrp: 4242, startTicks: 777 });
    expect(parseStat("garbage")).toBeUndefined();
  });
  it("stops only the process it started", () => {
    const e: PidEntry = {
      id: "x",
      pid: 4242,
      pgid: 4242,
      startTicks: 777,
      argv0: "node",
      startedAt: "",
    };
    expect(decide(e, undefined)).toBe("gone");
    expect(decide(e, stat(777))).toBe("stop");
    expect(decide(e, stat(778))).toBe("recycled");
  });
});

describe("the history", () => {
  it("keeps the last 50", () => {
    let l: ReturnType<typeof pushHistory> = [];
    for (let i = 0; i < MAX_HISTORY + 5; i++)
      l = pushHistory(l, {
        id: `p${i}`,
        declaredMiB: 1,
        startedAt: "",
        stoppedAt: "",
        stage: "term",
      });
    expect(l).toHaveLength(MAX_HISTORY);
    expect(l[0]!.id).toBe("p5");
  });
});

// Real child processes: `node -e` scripts, as RFC 0003 §10's host layer.
const linux = process.platform === "linux";
describe.skipIf(!linux)("the managed process", () => {
  const dirs: string[] = [];
  const lines: string[] = [];
  const managers: Manager[] = [];
  const mk = (over: Partial<Host> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-"));
    dirs.push(dir);
    const host: Host = {
      trusted: () => true,
      declaredElsewhere: () => [],
      budgetMiB: () => 8192,
      limitMiB: () => 16384,
      ask: async () => "start",
      pidFile: path.join(dir, "processes.json"),
      historyFile: path.join(dir, "processes-history.json"),
      stopGraceMs: () => 2000,
      log: (l) => lines.push(l),
      ...over,
    };
    const m = new Manager(host);
    managers.push(m);
    return { m, host };
  };
  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
  const listener = (port: number, extra = "") =>
    [
      process.execPath,
      "-e",
      `require("net").createServer().listen(${port}, "127.0.0.1"); ${extra}`,
    ] as [string, ...string[]];
  const open = (port: number) =>
    new Promise<boolean>((r) => {
      const s = net.connect({ host: "127.0.0.1", port });
      s.once("connect", () => (s.destroy(), r(true)));
      s.once("error", () => r(false));
    });

  afterEach(async () => {
    for (const m of managers.splice(0)) await m.stopAll();
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  it("starts, waits on the port, stops with SIGTERM and records the peak", async () => {
    const { m, host } = mk();
    const port = await freePort();
    const p = await m.start({
      id: "srv",
      argv: listener(port),
      memoryMiB: 128,
      ready: { port, timeoutMs: 10000, intervalMs: 50 },
    });
    await p.ready;
    expect(readEntries(host.pidFile).map((e) => e.id)).toEqual(["srv"]);
    expect(m.declared()).toEqual([{ id: "srv", mib: 128 }]);
    const r = await p.stop();
    expect(r.stage).toBe("term");
    expect(r.peakRssMiB).toBeGreaterThan(0);
    expect(await open(port)).toBe(false);
    expect(readEntries(host.pidFile)).toEqual([]);
    const h = readHistory(host.historyFile);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ id: "srv", declaredMiB: 128, stage: "term" });
    expect(JSON.stringify(h)).not.toContain("listen");
  });

  it("SIGKILLs a process that ignores SIGTERM after the grace", async () => {
    const { m } = mk({ stopGraceMs: () => 300 });
    const p = await m.start({
      id: "stubborn",
      argv: [
        process.execPath,
        "-e",
        `process.on("SIGTERM", () => {}); console.log("up"); setInterval(() => {}, 1000)`,
      ],
      memoryMiB: 64,
      ready: { log: "^up", timeoutMs: 10000, intervalMs: 20 },
    });
    await p.ready;
    expect((await p.stop()).stage).toBe("kill");
  });

  it("matches a log line printed in the first millisecond", async () => {
    const { m } = mk();
    const p = await m.start({
      id: "early",
      argv: [
        process.execPath,
        "-e",
        `process.stdout.write("Start"); process.stdout.write("ed in 1 ms\\n"); setInterval(() => {}, 1000)`,
      ],
      memoryMiB: 64,
      ready: { log: "Started in", timeoutMs: 10000, intervalMs: 20 },
    });
    await expect(p.ready).resolves.toBeUndefined();
  });

  it("fails readiness that never comes, naming the last answer", async () => {
    const { m } = mk();
    const port = await freePort();
    const p = await m.start({
      id: "web",
      argv: [
        process.execPath,
        "-e",
        `require("http").createServer((q, s) => { s.statusCode = 404; s.end(); }).listen(${port}, "127.0.0.1")`,
      ],
      memoryMiB: 64,
      ready: {
        http: `http://127.0.0.1:${port}/nope`,
        timeoutMs: 1500,
        intervalMs: 100,
      },
    });
    await expect(p.ready).rejects.toThrow(
      /not ready after 1.5 s: http 404 \(last\)/,
    );
  });

  it("refuses to start in an untrusted workspace", async () => {
    const { m, host } = mk({ trusted: () => false });
    await expect(
      m.start({ id: "x", argv: [process.execPath, "-e", ""], memoryMiB: 64 }),
    ).rejects.toThrow(/not trusted/);
    expect(readEntries(host.pidFile)).toEqual([]);
  });

  // Case 6: the budget forced to 1 024 MiB, JDT.LS declared at 768, a step at 512.
  it("asks before going over budget; Skip spawns nothing and is remembered", async () => {
    const asked: string[] = [];
    const { m, host } = mk({
      budgetMiB: () => 1024,
      declaredElsewhere: () => [{ id: "jdtls", mib: 768 }],
      ask: async (msg) => (asked.push(msg), "skip"),
    });
    const spec = {
      id: "step2",
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"] as [
        string,
        ...string[],
      ],
      memoryMiB: 512,
    };
    await expect(m.start(spec)).rejects.toBeInstanceOf(SkippedForMemory);
    await expect(m.start(spec)).rejects.toBeInstanceOf(SkippedForMemory);
    expect(asked).toEqual(["step2: 1 280 MiB declared of a 1 024 MiB budget"]);
    expect(readEntries(host.pidFile)).toEqual([]);
  });

  // Case 7: the extension host died with a process running; the next activation sweeps it.
  it("sweeps an orphan at the next activation, and only it", async () => {
    const { m, host } = mk();
    const port = await freePort();
    const p = await m.start({
      id: "orphan",
      argv: listener(port),
      memoryMiB: 64,
      ready: { port, timeoutMs: 10000, intervalMs: 50 },
    });
    await p.ready;
    // A stale entry whose pid now belongs to someone else (ourselves, other ticks).
    const entries = readEntries(host.pidFile);
    fs.writeFileSync(
      host.pidFile,
      JSON.stringify([
        ...entries,
        {
          ...entries[0]!,
          id: "recycled",
          pid: process.pid,
          pgid: process.pid,
          startTicks: 1,
        },
      ]),
    );
    const swept = await sweep(host.pidFile, 2000);
    expect(swept.map((s) => [s.entry.id, s.stage])).toEqual([
      ["orphan", "term"],
    ]);
    expect(await open(port)).toBe(false);
    expect(readEntries(host.pidFile)).toEqual([]);
  });
});

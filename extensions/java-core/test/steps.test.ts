import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Probe, RunStepKind, ServerStep } from "../src/api-types";
import { Manager, type Host } from "../src/process/managed";
import {
  Run,
  startProcess,
  startServer,
  type Started,
} from "../src/run/orchestrator";
import {
  NO_TIMEOUT,
  plan,
  resolveDeploy,
  validate,
  type PlannedStep,
  type RunConfig,
} from "../src/run/steps";

const known = { launches: ["Run IT"], kinds: ["fake"], limitMiB: 4096 };

describe("validate (RFC 0003 §4.3)", () => {
  it("passes a runnable config", () => {
    expect(
      validate(
        {
          name: "R",
          steps: [
            { task: "batlehub-java: maven package" },
            { process: ["jwebserver"], memoryMiB: 128, ready: { port: 8000 } },
            { ready: { port: 5432 } },
            { server: "fake" },
            { launch: "Run IT" },
          ],
        },
        known,
      ),
    ).toEqual([]);
  });
  it("names every hard error", () => {
    expect(validate({ name: "R", steps: [] }, known)).toEqual([
      "`steps` must be a non-empty array",
    ]);
    expect(
      validate(
        {
          name: "R",
          steps: [
            { task: "a", launch: "Run IT" },
            {},
            { launch: "R" },
            { launch: "Nope" },
            { process: "java -jar app.jar" },
            { server: "tomcat" },
            { process: ["x"], memoryMiB: 0 },
            { process: ["x"], memoryMiB: 9000 },
          ],
        },
        known,
      ),
    ).toEqual([
      "step 1: exactly one of task, launch, process or server — or none and a ready probe",
      "step 2: exactly one of task, launch, process or server — or none and a ready probe",
      "step 3: launch names the run itself",
      'step 4: no launch.json entry is named "Nope"',
      'step 5: process must be an array, never a shell string: ["java","-jar","app.jar"]',
      'step 6: no step kind "tomcat" is registered (registered: fake)',
      "step 7: memoryMiB must be a positive integer",
      "step 8: memoryMiB 9000 is above the container limit (4096 MiB)",
    ]);
  });
});

describe("plan (RFC 0003 §4.1 defaults)", () => {
  const kinds = new Map([
    [
      "fake",
      {
        defaultMemoryMiB: 768,
        defaultProbe: (s: ServerStep): Probe => ({ port: s.port ?? 8080 }),
      },
    ],
  ]);
  it("applies the probe and memory defaults", () => {
    const p = plan(
      {
        type: "batlehub-run",
        name: "R",
        steps: [
          { task: "t" },
          { launch: "a" },
          { process: ["/usr/bin/jwebserver", "-p", "1"] },
          { server: "fake", port: 9000 },
          { launch: "b" },
        ],
      },
      { memoryMiB: 512, kinds },
    );
    expect(
      p.map((s) => [s.label, s.probe, s.memoryMiB, s.defaultedMemory]),
    ).toEqual([
      ["t", { exit: 0, timeoutMs: NO_TIMEOUT }, undefined, undefined],
      ["a", {}, undefined, undefined],
      ["jwebserver", {}, 512, true],
      ["fake", { port: 9000 }, 768, false],
      ["b", { exit: 0, timeoutMs: NO_TIMEOUT }, undefined, undefined],
    ]);
  });
});

describe("resolveDeploy (RFC 0003 §4.3, §7)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });
  const io = {
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
  it("refuses a symlink out of the workspace, finds a module's artifact", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-"));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
    dirs.push(ws, out);
    fs.writeFileSync(path.join(out, "secret"), "x");
    fs.symlinkSync(path.join(out, "secret"), path.join(ws, "app.war"));
    fs.mkdirSync(path.join(ws, "webapp", "target"), { recursive: true });
    fs.writeFileSync(path.join(ws, "webapp", "target", "webapp-1.0.war"), "");
    expect(resolveDeploy("app.war", [ws], io)).toEqual({
      error: `deploy: app.war resolves to ${fs.realpathSync(path.join(out, "secret"))}, outside every workspace folder`,
    });
    expect(resolveDeploy("webapp", [ws], io)).toEqual({
      path: path.join(
        fs.realpathSync(ws),
        "webapp",
        "target",
        "webapp-1.0.war",
      ),
    });
    expect(resolveDeploy("api", [ws], io)).toEqual({
      error:
        'deploy: module "api" has no packaged artifact — run `maven package` first (a task step does)',
    });
  });
});

// The engine over real `node -e` children through the real Manager.
describe.skipIf(process.platform !== "linux")("the run (RFC 0003 §5.1)", () => {
  const dirs: string[] = [];
  const managers: Manager[] = [];
  afterEach(async () => {
    for (const m of managers.splice(0)) await m.stopAll();
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });
  const manager = (over: Partial<Host> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-"));
    dirs.push(dir);
    const m = new Manager({
      trusted: () => true,
      declaredElsewhere: () => [],
      budgetMiB: () => 8192,
      limitMiB: () => 16384,
      ask: async () => "start",
      pidFile: path.join(dir, "processes.json"),
      historyFile: path.join(dir, "history.json"),
      stopGraceMs: () => 2000,
      log: () => {},
      ...over,
    });
    managers.push(m);
    return { m, dir };
  };
  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
  const open = (port: number) =>
    new Promise<boolean>((r) => {
      const s = net.connect({ host: "127.0.0.1", port });
      s.once("connect", () => (s.destroy(), r(true)));
      s.once("error", () => r(false));
    });
  /** A listener that appends "<name> up" / "<name> down" to `log` — the order is the proof. */
  const server = (port: number, name: string, log: string) => [
    process.execPath,
    "-e",
    `const fs=require("fs");require("net").createServer().listen(${port},"127.0.0.1",()=>fs.appendFileSync(${JSON.stringify(log)},"${name} up\\n"));process.on("SIGTERM",()=>{fs.appendFileSync(${JSON.stringify(log)},"${name} down\\n");process.exit(0)})`,
  ];
  const cfg = (steps: RunConfig["steps"]): RunConfig => ({
    type: "batlehub-run",
    name: "R",
    steps,
  });
  const go = (
    m: Manager,
    c: RunConfig,
    extra?: (s: PlannedStep) => Promise<Started | undefined>,
  ) => {
    const lines: string[] = [];
    const run = new Run(
      plan(c, { memoryMiB: 64, kinds: new Map() }),
      async (s) =>
        (await extra?.(s)) ??
        (s.kind === "process"
          ? startProcess(m, s, {
              id: `run:R:${s.n}`,
              argv: (s.step as { process: [string, ...string[]] }).process,
            })
          : undefined),
      (l) => lines.push(l),
    );
    return { run, lines };
  };

  it("starts in order, waits on each port, and Stop stops in reverse (cases 1 and 4)", async () => {
    const { m, dir } = manager();
    const log = path.join(dir, "order.log");
    const [a, b] = [await freePort(), await freePort()];
    const { run, lines } = go(
      m,
      cfg([
        {
          process: server(a, "a", log),
          memoryMiB: 64,
          ready: { port: a, intervalMs: 50 },
        },
        { process: server(b, "b", log), ready: { port: b, intervalMs: 50 } },
      ]),
    );
    const finished = run.run();
    for (let i = 0; i < 100 && !(await open(b)); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(await open(a)).toBe(true);
    const r = await run.stop();
    expect(r).toEqual({ ok: true });
    expect(await finished).toEqual({ ok: true });
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "a up",
      "b up",
      "b down",
      "a down",
    ]);
    expect(lines[0]).toMatch(/^step 1 ready \(port \d+ in \d+\.\d s\)$/);
    expect(lines).toContain(
      `step 2 (${path.basename(process.execPath)}): no memoryMiB, declares the default 64 MiB`,
    );
    expect(lines).toContain("stopped by user");
    expect(lines.at(-2)).toMatch(
      /^stopping 2 \(\S+\) … stopped \(term\) · peak \d+ MiB of 64 in \d+\.\d s$/,
    );
    expect(lines.at(-1)).toMatch(
      /^stopping 1 \(\S+\) … stopped \(term\) · peak \d+ MiB of 64 in/,
    );
    expect(await open(a)).toBe(false);
  });

  it("a probe that never answers fails the run and still stops step 1 (case 3)", async () => {
    const { m, dir } = manager();
    const log = path.join(dir, "order.log");
    const [a, b] = [await freePort(), await freePort()];
    const { run, lines } = go(
      m,
      cfg([
        {
          process: server(a, "a", log),
          memoryMiB: 64,
          ready: { port: a, intervalMs: 50 },
        },
        // Alive, but never listening on `b`.
        {
          process: [process.execPath, "-e", "setInterval(()=>{},1000)"],
          memoryMiB: 64,
          ready: { port: b, timeoutMs: 300, intervalMs: 50 },
        },
      ]),
    );
    expect(await run.run()).toEqual({
      ok: false,
      error: "step 2 not ready after 0.3 s: closed (last)",
    });
    expect(lines.at(-2)).toMatch(/^stopping 2 \(\S+\) … stopped \(term\)/);
    expect(lines.at(-1)).toMatch(/^stopping 1 \(\S+\) … stopped \(term\)/);
    expect(await open(a)).toBe(false);
  });

  it("a last step that ends ends the run; what already ended says so (case 2)", async () => {
    const { m, dir } = manager();
    const log = path.join(dir, "order.log");
    const a = await freePort();
    let resolveTask!: (c: number) => void;
    const task: Started = {
      done: new Promise((r) => (resolveTask = r)),
      stop: async () => "terminated",
    };
    const { run, lines } = go(
      m,
      cfg([
        { task: "build" },
        {
          process: server(a, "a", log),
          memoryMiB: 64,
          ready: { port: a, intervalMs: 50 },
        },
        { launch: "IT" },
      ]),
      async (s) => {
        if (s.kind === "task") {
          setTimeout(() => resolveTask(0), 20);
          return task;
        }
        if (s.kind === "launch")
          return {
            done: new Promise((r) => setTimeout(() => r(0), 100)),
            stop: async () => "stopped",
          };
        return undefined;
      },
    );
    expect(await run.run()).toEqual({ ok: true, exitCode: 0 });
    expect(lines[0]).toBe("step 1 exited 0");
    expect(lines).toContain("step 3 exited 0");
    expect(lines.at(-3)).toBe("stopping 3 (IT) … already done");
    expect(lines.at(-2)).toMatch(/^stopping 2 \(\S+\) … stopped \(term\)/);
    expect(lines.at(-1)).toBe("stopping 1 (build) … already done");
    expect(await open(a)).toBe(false);
  });

  it("a launch whose debugger reports no exit code ends the run only when the probe was implicit", async () => {
    const { m } = manager();
    const launch = async () => ({
      done: Promise.resolve(null),
      stop: async () => "stopped",
    });
    const a = go(m, cfg([{ launch: "IT" }]), launch);
    expect(await a.run.run()).toEqual({ ok: true, exitCode: null });
    expect(a.lines[0]).toBe("step 1 ended (its debugger reports no exit code)");
    const b = go(m, cfg([{ launch: "IT", ready: { exit: 0 } }]), launch);
    expect(await b.run.run()).toEqual({
      ok: false,
      error: "step 1 ended without an exit code, expected 0",
    });
  });

  it("over budget, Skip marks the step and the run continues (case 6)", async () => {
    const { m } = manager({ budgetMiB: () => 100, ask: async () => "skip" });
    const { run, lines } = go(
      m,
      cfg([
        {
          process: [process.execPath, "-e", "setInterval(()=>{},1000)"],
          memoryMiB: 512,
        },
        { task: "after" },
      ]),
      async (s) =>
        s.kind === "task"
          ? { done: Promise.resolve(0), stop: async () => "" }
          : undefined,
    );
    expect(await run.run()).toEqual({ ok: true, exitCode: 0 });
    expect(lines).toEqual([
      "step 1 skipped (memory)",
      "step 2 exited 0",
      "stopping 2 (after) … already done",
    ]);
  });

  it("a server step is the kind's pure functions handed to process.start (§6.4, phase 4)", async () => {
    const { m, dir } = manager();
    const ws = path.join(dir, "ws");
    fs.mkdirSync(path.join(ws, "webapp", "target"), { recursive: true });
    fs.writeFileSync(path.join(ws, "webapp", "target", "webapp.war"), "war");
    const port = await freePort();
    const seen: Record<string, unknown> = {};
    const kind: RunStepKind = {
      id: "fake",
      defaultMemoryMiB: 96,
      defaultProbe: (st) => ({ port: st.port!, intervalMs: 50 }),
      prepare: async (_home, base, st) => {
        fs.copyFileSync(st.deploy!, path.join(base, "app.war"));
        seen.prepared = st;
      },
      argv: (_home, base, _jdk, st) => ({
        cmd: process.execPath,
        args: [
          "-e",
          `require("net").createServer().listen(${st.port},"127.0.0.1");require("fs").writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))},JSON.stringify(process.argv.slice(1)))`,
          base,
        ],
        env: { FAKE: "1" },
      }),
      // A graceful stop the kind names: kill the listener by its port's pid file would be the real thing;
      // here it is a command that exits, so the managed stop falls through to SIGTERM within the grace.
      stop: () => ({ cmd: process.execPath, args: ["-e", "0"] }),
    };
    const steps = plan(
      {
        type: "batlehub-run",
        name: "Srv run",
        steps: [
          { server: "fake", port, deploy: "webapp", extraArgs: ["--extra"] },
        ],
      },
      { memoryMiB: 512, kinds: new Map([["fake", kind]]) },
    );
    expect(steps[0]!.memoryMiB).toBe(96);
    const lines: string[] = [];
    const run = new Run(
      steps,
      (s) =>
        startServer(m, s, kind, {
          id: "run:Srv run:1",
          run: "Srv run",
          storageDir: dir,
          folders: [ws],
          env: {},
          runtime: undefined,
          debug: false,
          stopGraceMs: 500,
        }),
      (l) => lines.push(l),
    );
    const finished = run.run();
    for (
      let i = 0;
      i < 100 && !lines.some((l) => l.startsWith("step 1 ready"));
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    const base = path.join(dir, "servers", "fake", "Srv_run");
    expect(fs.readFileSync(path.join(base, "app.war"), "utf8")).toBe("war");
    expect((seen.prepared as ServerStep).deploy).toBe(
      path.join(fs.realpathSync(ws), "webapp", "target", "webapp.war"),
    );
    expect((seen.prepared as ServerStep).debug).toBe(false);
    for (let i = 0; i < 40 && !fs.existsSync(path.join(dir, "argv.json")); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8")),
    ).toEqual([base, "--extra"]);
    await run.stop();
    await finished;
    expect(lines[0]).toMatch(/^step 1 ready \(port \d+ in/);
    expect(lines.at(-1)).toMatch(
      /^stopping 1 \(fake\) … stopped \((term|graceful)\)/,
    );
    expect(await open(port)).toBe(false);
  });

  it("a goal kind runs the core's command, stops on stdin, and is listed as running (RFC 0011 §5.1)", async () => {
    const { m, dir } = manager();
    const port = await freePort();
    const log = path.join(dir, "quit.log");
    // A dev mode that quits on "q": the stdin stop must reach it before SIGTERM.
    const script = `require("net").createServer().listen(${port},"127.0.0.1");process.stdin.on("data",(d)=>{if(String(d).includes("q")){require("fs").writeFileSync(${JSON.stringify(log)},"quit");process.exit(0)}})`;
    const kind: RunStepKind = {
      id: "dev",
      defaultMemoryMiB: 64,
      defaultProbe: () => ({ port, intervalMs: 50 }),
      goal: (st) => ({
        tool: "maven",
        goal: "dev:run",
        args: [st.debug ? "-Ddebug=5005" : "-Ddebug=false"],
      }),
      stop: () => ({ stdin: "q\n" }),
    };
    const seen: unknown[] = [];
    const steps = plan(
      { type: "batlehub-run", name: "Dev", steps: [{ server: "dev" }] },
      { memoryMiB: 512, kinds: new Map([["dev", kind]]) },
    );
    const lines: string[] = [];
    const run = new Run(
      steps,
      (s) =>
        startServer(m, s, kind, {
          id: "run:Dev:1",
          run: "Dev",
          storageDir: dir,
          folders: [dir],
          env: {},
          runtime: undefined,
          debug: false,
          stopGraceMs: 2000,
          goal: (g) => {
            seen.push(g);
            return { cmd: process.execPath, args: ["-e", script], env: {} };
          },
        }),
      (l) => lines.push(l),
    );
    const finished = run.run();
    for (
      let i = 0;
      i < 100 && !lines.some((l) => l.startsWith("step 1 ready"));
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([
      { tool: "maven", goal: "dev:run", args: ["-Ddebug=false"] },
    ]);
    expect(m.running()).toEqual([
      { id: "run:Dev:1", pid: expect.any(Number), memoryMiB: 64, kind: "dev" },
    ]);
    await run.stop();
    await finished;
    expect(fs.readFileSync(log, "utf8")).toBe("quit");
    expect(lines.at(-1)).toMatch(/^stopping 1 \(dev\) … stopped \(graceful\)/);
    expect(m.running()).toEqual([]);
  });

  it("a deploy outside the workspace fails the step before anything starts", async () => {
    const { m, dir } = manager();
    const kind: RunStepKind = {
      id: "fake",
      defaultMemoryMiB: 64,
      defaultProbe: () => ({}),
      argv: () => ({ cmd: "true", args: [] }),
    };
    const steps = plan(
      {
        type: "batlehub-run",
        name: "R",
        steps: [{ server: "fake", deploy: "/etc/passwd" }],
      },
      { memoryMiB: 64, kinds: new Map([["fake", kind]]) },
    );
    const run = new Run(
      steps,
      (s) =>
        startServer(m, s, kind, {
          id: "x",
          run: "R",
          storageDir: dir,
          folders: [path.join(dir, "ws")],
          env: {},
          runtime: undefined,
          debug: false,
        }),
      () => {},
    );
    expect(await run.run()).toEqual({
      ok: false,
      error:
        "step 1: deploy: /etc/passwd resolves to /etc/passwd, outside every workspace folder",
    });
  });

  it("refuses to start on a port someone else holds", async () => {
    const { m } = manager();
    const held = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => held.once("listening", r));
    const port = (held.address() as net.AddressInfo).port;
    const { run } = go(
      m,
      cfg([
        {
          process: [process.execPath, "-e", "0"],
          memoryMiB: 64,
          ready: { port },
        },
      ]),
    );
    expect(await run.run()).toEqual({
      ok: false,
      error: `step 1: port ${port} is already in use by another process`,
    });
    held.close();
  });
});

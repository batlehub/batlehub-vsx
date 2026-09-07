import { describe, expect, it, vi } from "vitest";
import { PortForward, PortForwardPool, type ForwardProcess } from "../src/portforward";

/** A kubectl that does whatever the test needs it to do. */
class FakeProcess implements ForwardProcess {
  readonly pid = 4242;
  killed = false;
  private exitListener: ((code: number | null) => void) | undefined;
  stderr = {
    on: (_e: "data", cb: (chunk: unknown) => void) => {
      this.emitStderr = cb;
    },
  };
  private emitStderr: ((chunk: unknown) => void) | undefined;

  kill(): boolean {
    this.killed = true;
    return true;
  }
  on(_event: "exit", listener: (code: number | null) => void): void {
    this.exitListener = listener;
  }
  say(text: string): void {
    this.emitStderr?.(text);
  }
  die(code: number | null = 1): void {
    this.exitListener?.(code);
  }
}

function harness(ready: () => Promise<boolean> = () => Promise.resolve(true)) {
  const spawned: { args: string[]; proc: FakeProcess }[] = [];
  const clock = { t: 0 };
  const deps = {
    bin: () => "kubectl",
    spawn: (_bin: string, args: string[]) => {
      const proc = new FakeProcess();
      spawned.push({ args, proc });
      return proc;
    },
    freePort: () => Promise.resolve(2222),
    waitReady: ready,
    log: () => {},
    now: () => clock.t,
  };
  const spec = {
    namespace: "dev-ws-max",
    pod: "pod-1",
    args: (port: number) => ["port-forward", `${port}:2022`],
  };
  return { deps, spec, spawned, clock };
}

describe("PortForward", () => {
  it("resolves only once the listener accepts, and reports the port", async () => {
    const { deps, spec, spawned } = harness();
    const forward = new PortForward(spec, deps);
    expect(await forward.start()).toBe(2222);
    expect(forward.state).toBe("running");
    expect(spawned[0]!.args).toEqual(["port-forward", "2222:2022"]);
  });

  it("fails with what kubectl printed when nothing ever accepts", async () => {
    const { deps, spec, spawned } = harness(() => Promise.resolve(false));
    const forward = new PortForward(spec, { ...deps, startAttempts: 1 });
    const started = forward.start();
    // The stderr listener is attached during the spawn, so speak after it.
    await Promise.resolve();
    spawned[0]?.proc.say("error: unable to forward");
    await expect(started).rejects.toThrow(/never accepted a connection/);
    expect(forward.state).toBe("failed");
    expect(spawned[0]!.proc.killed).toBe(true);
  });

  it("restarts a forward that dies while it is still wanted", async () => {
    const { deps, spec, spawned } = harness();
    const forward = new PortForward(spec, deps);
    await forward.start();
    spawned[0]!.proc.die(1);
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    expect(forward.state).toBe("running");
  });

  it("gives up on a forward that binds and dies at once", async () => {
    const { deps, spec, spawned } = harness();
    const forward = new PortForward(spec, { ...deps, maxRestarts: 2 });
    await forward.start();
    for (let i = 0; i < 3; i++) {
      spawned.at(-1)!.proc.die(1);
      await vi.waitFor(() => expect(forward.state).not.toBe("starting"));
    }
    // Two restarts, then no more: a flapping forward must not loop forever.
    expect(spawned).toHaveLength(3);
    expect(forward.state).toBe("failed");
  });

  it("returns the restart budget to a forward that stayed up", async () => {
    const { deps, spec, spawned, clock } = harness();
    const forward = new PortForward(spec, { ...deps, maxRestarts: 2, healthyAfterMs: 60_000 });
    await forward.start();
    for (let i = 0; i < 4; i++) {
      clock.t += 120_000;
      spawned.at(-1)!.proc.die(1);
      await vi.waitFor(() => expect(forward.state).toBe("running"));
    }
    expect(spawned).toHaveLength(5);
    expect(forward.state).toBe("running");
  });

  it("does not restart one that was stopped on purpose", async () => {
    const { deps, spec, spawned } = harness();
    const forward = new PortForward(spec, deps);
    await forward.start();
    forward.stop();
    spawned[0]!.proc.die(0);
    await new Promise((r) => setTimeout(r, 10));
    expect(spawned).toHaveLength(1);
    expect(forward.state).toBe("stopped");
  });
});

describe("PortForwardPool", () => {
  it("reuses the forward a pod already has", async () => {
    const { deps, spec, spawned } = harness();
    const pool = new PortForwardPool(deps);
    expect(await pool.ensure(spec)).toBe(2222);
    expect(await pool.ensure(spec)).toBe(2222);
    expect(spawned).toHaveLength(1);
  });

  it("stops every forward when the extension unloads", async () => {
    const { deps, spec, spawned } = harness();
    const pool = new PortForwardPool(deps);
    await pool.ensure(spec);
    await pool.ensure({ ...spec, pod: "pod-2" });
    pool.dispose();
    expect(spawned.map((s) => s.proc.killed)).toEqual([true, true]);
    expect(pool.get("dev-ws-max", "pod-1")).toBeUndefined();
  });

  it("keeps nothing behind when a forward refuses to start", async () => {
    const { deps, spec } = harness(() => Promise.resolve(false));
    const pool = new PortForwardPool(deps);
    await expect(pool.ensure(spec)).rejects.toThrow();
    expect(pool.get("dev-ws-max", "pod-1")).toBeUndefined();
  });
});

describe("the port race", () => {
  it("tries another port when the first never comes up", async () => {
    // freePort answers, then the kernel gives that port to someone else
    // before kubectl binds it. Observed once in nineteen real starts.
    const spawned: string[][] = [];
    let port = 2000;
    let readyFrom = 2001;
    const forward = new PortForward(
      { namespace: "ns", pod: "pod-1", args: (p) => [`${p}:2022`] },
      {
        bin: () => "kubectl",
        spawn: (_bin, args) => {
          spawned.push(args);
          return {
            pid: 1,
            kill: () => true,
            on: () => undefined,
          };
        },
        freePort: () => Promise.resolve(port++),
        waitReady: (p) => Promise.resolve(p >= readyFrom),
        log: () => {},
      },
    );
    expect(await forward.start()).toBe(2001);
    expect(spawned).toEqual([["2000:2022"], ["2001:2022"]]);
  });

  it("gives up after its attempts rather than churn through ports", async () => {
    let port = 3000;
    const forward = new PortForward(
      { namespace: "ns", pod: "pod-1", args: (p) => [`${p}:2022`] },
      {
        bin: () => "kubectl",
        spawn: () => ({ pid: 1, kill: () => true, on: () => undefined }),
        freePort: () => Promise.resolve(port++),
        waitReady: () => Promise.resolve(false),
        startAttempts: 3,
        log: () => {},
      },
    );
    await expect(forward.start()).rejects.toThrow(/never accepted a connection/);
    expect(port).toBe(3003);
  });
});

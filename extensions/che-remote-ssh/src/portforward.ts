// The long-running half of the connection: `kubectl port-forward`, kept
// alive for as long as a window is using it.
//
// This is where the upstream extension gives up. It spawns the forward
// detached, remembers the port in a file, and leaves a `process.kill`
// commented out, so a forward whose pod has gone survives as a port that
// accepts connections and answers nothing. Here a forward is owned: it is
// restarted when it dies while still wanted, given up on after a few
// failures rather than looping, and stopped when the extension unloads.
//
// The spawner is injected, so all of that is tested without a cluster.

export interface ForwardProcess {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null) => void): void;
  stderr?: { on(event: "data", listener: (chunk: unknown) => void): void } | null;
}

export type Spawner = (bin: string, args: string[]) => ForwardProcess;

export interface ForwardSpec {
  namespace: string;
  pod: string;
  /** Argv built by kubectl.ts, given the port this forward was assigned. */
  args: (localPort: number) => string[];
}

export interface ForwardDeps {
  /** Resolved at each spawn: the binary can differ from one instance to another. */
  bin: () => string;
  spawn: Spawner;
  freePort: () => Promise<number>;
  waitReady: (port: number) => Promise<boolean>;
  log?: (m: string) => void;
  /** Restarts of one forward before it is given up on. */
  maxRestarts?: number;
  /**
   * Where the forward's own output is kept. Named in the error when one
   * never comes up: a detached forward writes to a file rather than to a
   * pipe, so that closing this window cannot break its stderr.
   */
  diagnosticsPath?: string;
  /**
   * How long a forward has to stay up before it counts as healthy and its
   * restart budget is returned. Without this, a forward that binds and dies
   * at once refills its budget on every attempt and restarts forever.
   */
  healthyAfterMs?: number;
  now?: () => number;
  /** Attempts, each on its own port, before a start is called a failure. */
  startAttempts?: number;
}

export type ForwardState = "starting" | "running" | "stopped" | "failed";

export class ForwardError extends Error {}

/** One `kubectl port-forward`, owned from start to stop. */
export class PortForward {
  private child: ForwardProcess | undefined;
  private restarts = 0;
  private wanted = false;
  private lastStderr = "";
  private startedAt = 0;
  state: ForwardState = "stopped";
  port = 0;
  /** The detached kubectl, which outlives the window that started it. */
  pid: number | undefined;

  constructor(
    readonly spec: ForwardSpec,
    private readonly deps: ForwardDeps,
  ) {}

  get key(): string {
    return `${this.spec.namespace}/${this.spec.pod}`;
  }

  /**
   * Start, and resolve only once the listener actually accepts.
   *
   * A port is free when it is asked for and bound a moment later, and the
   * kernel can hand it to something else in between. That race is rare and
   * real, so a first attempt that never comes up is retried once on a fresh
   * port before it is called a failure.
   */
  async start(): Promise<number> {
    this.wanted = true;
    this.restarts = 0;
    if (this.state === "running" && (await this.deps.waitReady(this.port))) return this.port;
    for (let attempt = 0; ; attempt++) {
      this.port = await this.deps.freePort();
      try {
        await this.spawnOnce();
        return this.port;
      } catch (err) {
        if (attempt >= (this.deps.startAttempts ?? 2) - 1) throw err;
        this.deps.log?.(`${this.key} did not come up on ${this.port}; trying another port`);
      }
    }
  }

  private async spawnOnce(): Promise<void> {
    this.state = "starting";
    const args = this.spec.args(this.port);
    this.deps.log?.(`port-forward ${this.key} on 127.0.0.1:${this.port}`);
    const child = this.deps.spawn(this.deps.bin(), args);
    this.child = child;
    this.pid = child.pid;
    this.lastStderr = "";
    child.stderr?.on("data", (chunk) => {
      this.lastStderr = String(chunk).trim().slice(0, 500);
    });
    child.on("exit", (code) => this.onExit(code));
    if (!(await this.deps.waitReady(this.port))) {
      this.state = "failed";
      child.kill();
      throw new ForwardError(
        `the forward for ${this.key} never accepted a connection` +
          (this.lastStderr ? `: ${this.lastStderr}` : "") +
          (this.deps.diagnosticsPath ? ` (see ${this.deps.diagnosticsPath})` : ""),
      );
    }
    this.state = "running";
    this.startedAt = (this.deps.now ?? Date.now)();
  }

  private onExit(code: number | null): void {
    this.child = undefined;
    if (!this.wanted) {
      this.state = "stopped";
      return;
    }
    const now = (this.deps.now ?? Date.now)();
    if (this.startedAt > 0 && now - this.startedAt >= (this.deps.healthyAfterMs ?? 60_000)) {
      // It ran long enough to have worked; the failures before it are spent.
      this.restarts = 0;
    }
    if (this.restarts >= (this.deps.maxRestarts ?? 3)) {
      this.state = "failed";
      this.deps.log?.(
        `port-forward ${this.key} gave up after ${this.restarts} restarts` +
          (this.deps.diagnosticsPath ? ` (see ${this.deps.diagnosticsPath})` : ""),
      );
      return;
    }
    this.restarts += 1;
    this.deps.log?.(
      `port-forward ${this.key} exited (${code ?? "signal"}), restart ${this.restarts}` +
        // A detached forward writes to the file, not to a pipe: its stderr is
        // null here, so the reason for the exit is only ever in there.
        (this.lastStderr
          ? `: ${this.lastStderr}`
          : this.deps.diagnosticsPath
            ? ` (see ${this.deps.diagnosticsPath})`
            : ""),
    );
    void this.spawnOnce().catch((err: unknown) => {
      this.state = "failed";
      this.deps.log?.(`port-forward ${this.key} restart failed: ${String(err)}`);
    });
  }

  /** Stop for good; a later exit event must not restart it. */
  stop(): void {
    this.wanted = false;
    this.state = "stopped";
    this.child?.kill();
    this.child = undefined;
  }
}

/** The forwards this extension holds, one per pod, stopped together. */
export class PortForwardPool {
  private readonly forwards = new Map<string, PortForward>();

  constructor(private readonly deps: ForwardDeps) {}

  /** The port for this pod, starting a forward or reusing the live one. */
  async ensure(spec: ForwardSpec): Promise<number> {
    const key = `${spec.namespace}/${spec.pod}`;
    const existing = this.forwards.get(key);
    if (existing && existing.state === "running") return existing.start();
    existing?.stop();
    const forward = new PortForward(spec, this.deps);
    this.forwards.set(key, forward);
    try {
      return await forward.start();
    } catch (err) {
      this.forwards.delete(key);
      throw err;
    }
  }

  get(namespace: string, pod: string): PortForward | undefined {
    return this.forwards.get(`${namespace}/${pod}`);
  }

  stop(namespace: string, pod: string): void {
    const key = `${namespace}/${pod}`;
    this.forwards.get(key)?.stop();
    this.forwards.delete(key);
  }

  dispose(): void {
    for (const forward of this.forwards.values()) forward.stop();
    this.forwards.clear();
  }
}

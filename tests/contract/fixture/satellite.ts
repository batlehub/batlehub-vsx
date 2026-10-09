// A fixture satellite (RFC 0003 §10 "Contract"): it registers a run step
// kind and starts a managed process through contract 1.1. Never run — it is
// type-checked against the current api.d.ts, so a change to RunStepKind,
// ServerStep or ProcessService that would break a satellite breaks here first.
import type * as vscode from "vscode";
import type { JavaCoreApi, RunStepKind } from "../../../extensions/java-core/api";

const kind: RunStepKind = {
  id: "fixture-dev",
  defaultMemoryMiB: 768,
  defaultProbe: (step) => ({ http: `http://localhost:${step.port ?? 8080}/`, timeoutMs: 90_000 }),
  locate: async () => undefined,
  prepare: async (_home, _base, step) => {
    void step.deploy;
  },
  argv: (_home, base, jdk, step) => ({
    cmd: jdk ? `${jdk.path}/bin/java` : "java",
    args: [
      ...(step.jvmArgs ?? []),
      ...(step.debug ? [`-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=localhost:${step.debugPort ?? 5005}`] : []),
      "-jar",
      `${base}/app.jar`,
    ],
    env: { SERVER_PORT: String(step.port ?? 8080) },
  }),
  stop: (_home, base) => ({ cmd: `${base}/stop.sh`, args: [] }),
};

// A kind that starts a build-tool goal in the core's task environment, and
// stops on stdin — dev mode's shape (RFC 0011).
const devKind: RunStepKind = {
  id: "fixture-goal",
  defaultMemoryMiB: 1024,
  defaultProbe: () => ({ log: "Listening on:" }),
  goal: (step) => ({ tool: "maven", goal: "fixture:dev", args: [step.debug ? `-Ddebug=${step.debugPort ?? 5005}` : "-Ddebug=false"] }),
  stop: () => ({ stdin: "q\n" }),
};

export async function activate(core: JavaCoreApi): Promise<vscode.Disposable[]> {
  core.assertContract(1);
  const p = await core.process.start({
    id: "fixture-ls",
    argv: ["java", "-Xmx256m", "-jar", "ls.jar"],
    memoryMiB: 384,
    ready: { log: "listening" },
    stdio: "streams",
  });
  p.onExit(() => {});
  const running: boolean = core.process.running().some((r) => r.kind === devKind.id && r.pid > 0);
  void running;
  return [core.registerRunStepKind(kind), core.registerRunStepKind(devKind), core.process.onDidChange(() => {}), core.process.declare({ id: "fixture-tools", memoryMiB: 512, label: "Fixture tools" })];
}

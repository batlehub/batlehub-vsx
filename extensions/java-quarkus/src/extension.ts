// The Quarkus satellite (RFC 0011): detect Quarkus from the core's project
// model, give the MicroProfile language server the core's JDK (one bridged
// key), run dev mode as an RFC 0003 managed process through a `quarkus-dev`
// run step kind, and show it in a `Quarkus` tab. It never starts a process
// itself and never talks to JDT.LS or to the Red Hat extensions' APIs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { JavaCoreApi, Module, RunningProcess } from "../../java-core/api";
import {
  BRIDGE_KEY,
  catalogue,
  extensionGoal,
  gradlePlatform,
  installedExtensions,
  BRIDGE_MIN_MAJOR,
  CONTRACT_MAJOR,
  type Detected,
  detectGradle,
  detectPom,
  devLaunch,
  devPort,
  type DevState,
  KIND,
  makeKind,
  needsBridge,
  releaseMajor,
  tabHtml,
  TEMPLATE_NAME,
} from "./quarkus";

const channel = vscode.window.createOutputChannel("BatleHub Java: Quarkus");
const log = (m: string) =>
  channel.appendLine(`[${new Date().toISOString()}] ${m}`);
const RED_HAT = ["redhat.vscode-quarkus", "redhat.vscode-microprofile"];

const settings = () => {
  const c = vscode.workspace.getConfiguration("batlehub.java.quarkus");
  return {
    enabled: c.get<boolean>("enabled") ?? true,
    devPort: c.get<number>("devPort") ?? 0,
    debugPort: c.get<number>("debugPort") ?? 5005,
    readiness: c.get<string>("readiness") ?? "/q/health/ready",
    devMemoryMiB: c.get<number>("devMemoryMiB") ?? 1024,
    bridge: c.get<string>("bridge") ?? "auto",
  };
};

const read = (p: string) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

/** The first Quarkus module of the folder, from the core's model (no second scan). */
async function detect(
  api: JavaCoreApi,
  folder: vscode.WorkspaceFolder,
): Promise<
  (Detected & { module: string; root: string; buildFile: string }) | undefined
> {
  const walk = (ms: Module[]): Module[] =>
    ms.flatMap((m) => [m, ...walk(m.children)]);
  for (const m of walk(await api.project.modules(folder))) {
    const text = read(m.buildFile) ?? "";
    const d = m.tool === "maven" ? detectPom(text) : detectGradle(text);
    if (!d) continue;
    // `quarkus create app --gradle` names the platform in gradle.properties.
    const gp =
      m.tool === "gradle"
        ? gradlePlatform(read(path.join(m.root, "gradle.properties")))
        : {};
    return {
      ...d,
      version: d.version ?? gp.version,
      group: d.group ?? gp.group ?? "io.quarkus.platform",
      module: m.name,
      root: m.root,
      buildFile: m.buildFile,
    };
  }
  return undefined;
}

/**
 * An artifact of the platform in the local repository — Maven's, or Gradle's
 * cache (one hash directory per file) — or undefined: nothing is downloaded
 * here (§5.3).
 */
function localArtifact(
  group: string,
  artifact: string,
  version: string,
  file: string,
): string | undefined {
  const m2 = path.join(
    os.homedir(),
    ".m2",
    "repository",
    ...group.split("."),
    artifact,
    version,
    file,
  );
  const maven = read(m2);
  if (maven) return maven;
  const gradle = path.join(
    os.homedir(),
    ".gradle",
    "caches",
    "modules-2",
    "files-2.1",
    group,
    artifact,
    version,
  );
  try {
    for (const h of fs.readdirSync(gradle)) {
      const t = read(path.join(gradle, h, file));
      if (t) return t;
    }
  } catch {
    /* not in Gradle's cache either */
  }
  return undefined;
}

/** The first `java` on PATH, through its symlinks, to its JDK's `release` file. */
function pathJavaMajor(): number | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const bin = path.join(dir, "java");
    if (!fs.existsSync(bin)) continue;
    try {
      return releaseMajor(
        read(path.join(path.dirname(fs.realpathSync(bin)), "..", "release")),
      );
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  context.subscriptions.push(channel);
  const core =
    vscode.extensions.getExtension<JavaCoreApi>("batlehub.java-core");
  if (!core) return;
  const api = await core.activate();
  try {
    api.assertContract(CONTRACT_MAJOR);
  } catch (e) {
    log(`contract refused: ${(e as Error).message}`);
    return;
  }
  // §4.3: an older core has no managed process to run dev mode through, and
  // there is no untracked start.
  if (!api.process?.running || !api.registerRunStepKind || !api.manifest) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Quarkus: BatleHub Java {0}.{1} lacks the managed process (contract 1.1); update batlehub.java-core.",
        api.contractVersion.major,
        api.contractVersion.minor,
      ),
    );
    return;
  }
  if (!settings().enabled) return;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const found = await detect(api, folder);
  if (!found) {
    log("no Quarkus module: nothing registered");
    return;
  }
  log(
    `detected Quarkus ${found.version ?? "(version not named)"} (${found.tool}, module ${found.module})`,
  );
  const propsFile = path.join(
    found.root,
    "src",
    "main",
    "resources",
    "application.properties",
  );
  const port = () => devPort(read(propsFile), settings().devPort);
  const kind = makeKind(() => ({
    ...settings(),
    tool: found.tool,
    properties: () => read(propsFile),
  }));

  // §4.3: Quarkus 3 needs a JDK ≥ 17.
  const runtime = (await api.jdk.resolve(folder)).runtime;
  if (!runtime || runtime.major < 17)
    void vscode.window
      .showErrorMessage(
        vscode.l10n.t(
          "Quarkus: Quarkus 3 needs a JDK 17 or newer, and BatleHub Java resolved {0}.",
          runtime ? runtime.name : vscode.l10n.t("none"),
        ),
        vscode.l10n.t("Install a JDK…"),
      )
      .then(
        (r) => r && vscode.commands.executeCommand("batlehub.java.installJdk"),
      );

  let bridged: string | undefined;

  // §4.3: the Red Hat pair absent is a warning; dev mode needs neither.
  const missing = RED_HAT.filter((id) => !vscode.extensions.getExtension(id));
  if (missing.length) {
    log(
      `not installed: ${missing.join(", ")} — no application.properties completion`,
    );
    const install = vscode.l10n.t("Install");
    void vscode.window
      .showWarningMessage(
        vscode.l10n.t(
          "Quarkus: {0} not installed — dev mode works, application.properties has no completion.",
          missing.join(", "),
        ),
        install,
      )
      .then(async (r) => {
        if (r === install)
          for (const id of missing)
            await vscode.commands.executeCommand(
              "workbench.extensions.installExtension",
              id,
            );
      });
  } else
    // The MicroProfile server is Red Hat's child: in the sum, as an estimate (§4.2).
    context.subscriptions.push(
      api.process.declare({
        id: "microprofile-ls",
        memoryMiB: 256,
        label: "MicroProfile LS",
      }),
    );

  // Dev mode's state: the core's managed process of our kind, and the run session holding it.
  let session: vscode.DebugSession | undefined;
  const devProcess = (): RunningProcess | undefined =>
    api.process.running().find((p) => p.kind === KIND);
  const dev = (): DevState => {
    const p = devProcess();
    return p
      ? { state: "running", pid: p.pid, port: port() }
      : { state: "stopped" };
  };
  const isDevRun = (s: vscode.DebugSession) =>
    s.type === "batlehub-run" &&
    Array.isArray(s.configuration.steps) &&
    (s.configuration.steps as { server?: string }[]).some(
      (x) => x.server === KIND,
    );

  const installed = () =>
    installedExtensions(read(found.buildFile) ?? "", found.tool);
  // §4.3: Debug needs the Java debugger and a debug port; the attach is the core's.
  const debugAvailable = (): { ok: boolean; reason?: string } =>
    !vscode.extensions.getExtension("vscjava.vscode-java-debug")
      ? {
          ok: false,
          reason: vscode.l10n.t(
            "needs the Java debugger (vscjava.vscode-java-debug)",
          ),
        }
      : settings().debugPort > 0
        ? { ok: true }
        : {
            ok: false,
            reason: vscode.l10n.t("batlehub.java.quarkus.debugPort is 0"),
          };

  const statusDef = {
    id: "quarkus.dev",
    defaultShown: false,
    command: "batlehub.java.quarkus.showLog",
  };
  const status = () =>
    dev().state === "stopped"
      ? {
          text: "$(debug-stop) Quarkus",
          tooltip: vscode.l10n.t("Quarkus dev mode: stopped"),
        }
      : {
          text: `$(play) Quarkus :${port()}`,
          tooltip: vscode.l10n.t(
            "Quarkus dev mode: running on port {0}",
            port(),
          ),
        };
  let item = api.registerStatusBarItem({ ...statusDef, ...status() });
  const tabDef = {
    id: "quarkus",
    title: "Quarkus",
    html: () =>
      tabHtml({
        detected: found,
        dev: dev(),
        probe: kind.defaultProbe({ server: KIND, port: port() }),
        bridged,
        missing,
        trusted: vscode.workspace.isTrusted,
        installed: installed(),
        debug: debugAvailable(),
      }),
  };
  let tab = api.registerPanelTab(tabDef);
  // The core reads a tab and an item when they are registered: re-register to repaint.
  const repaint = () => {
    item.dispose();
    item = api.registerStatusBarItem({ ...statusDef, ...status() });
    tab.dispose();
    tab = api.registerPanelTab(tabDef);
  };

  const devUi = () => `http://localhost:${port()}/q/dev-ui/`;
  const stop = async () => {
    if (session) await vscode.debug.stopDebugging(session);
  };
  const openDevUi = () =>
    vscode.commands.executeCommand("simpleBrowser.show", devUi());

  // §4.2: a second start is refused, naming pid and port; nothing is killed.
  const start = async (debugPort?: number) => {
    const p = devProcess();
    if (p) {
      const stopIt = vscode.l10n.t("Stop");
      const open = vscode.l10n.t("Open Dev UI");
      const r = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Quarkus dev mode is already running (pid {0}, port {1}).",
          p.pid,
          port(),
        ),
        stopIt,
        open,
      );
      if (r === stopIt) await stop();
      if (r === open) await openDevUi();
      return;
    }
    log(
      `starting dev mode (port ${port()}${debugPort ? `, debugger on ${debugPort}` : ""})`,
    );
    await vscode.debug.startDebugging(
      folder,
      devLaunch(port(), debugPort) as vscode.DebugConfiguration,
    );
  };

  // §4.2 add / remove: the build tool edits the build file, then the core
  // re-imports, as after a profile switch.
  const editExtensions = async (op: "add" | "remove") => {
    const have = installed();
    let items: { label: string; description?: string; id: string }[];
    if (op === "remove") items = have.map((id) => ({ label: id, id }));
    else {
      const v = found.version;
      const g = found.group ?? "io.quarkus.platform";
      const list =
        v &&
        catalogue(
          localArtifact(
            g,
            "quarkus-bom-quarkus-platform-descriptor",
            v,
            `quarkus-bom-quarkus-platform-descriptor-${v}-${v}.json`,
          ),
          localArtifact(g, "quarkus-bom", v, `quarkus-bom-${v}.pom`),
          have,
        );
      if (!list) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            "Quarkus: the platform is not in the local repository yet — run a build first.",
          ),
        );
        return;
      }
      items = list.map((e) => ({
        label: e.id,
        description: e.name === e.id ? undefined : e.name,
        id: e.id,
      }));
    }
    const pick = await vscode.window.showQuickPick(items, {
      title:
        op === "add"
          ? vscode.l10n.t("Quarkus: add an extension")
          : vscode.l10n.t("Quarkus: remove an extension"),
      matchOnDescription: true,
    });
    if (!pick) return;
    log(`${op} extension ${pick.id}`);
    const code = await api.project.runGoal(
      folder,
      extensionGoal(found.tool, op, pick.id),
    );
    if (code !== 0) {
      log(`${op} extension ${pick.id}: exited ${code}`);
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          "Quarkus: {0} {1} failed — see the task's terminal.",
          op,
          pick.id,
        ),
      );
      return;
    }
    log(`${op} extension ${pick.id}: done, reloading the Java projects`);
    await vscode.commands.executeCommand("batlehub.java.reimport");
    repaint();
  };

  context.subscriptions.push(
    { dispose: () => (item.dispose(), tab.dispose()) },
    api.registerRunStepKind(kind),
    api.registerRunTemplate({
      id: KIND,
      title: TEMPLATE_NAME,
      applies: async (f) => !!(await detect(api, f)),
      build: async () => ({ launch: devLaunch(port()) }),
    }),
    api.process.onDidChange(repaint),
    vscode.debug.onDidStartDebugSession((s) => {
      if (isDevRun(s)) session = s;
      repaint();
    }),
    vscode.debug.onDidTerminateDebugSession((s) => {
      if (s === session) session = undefined;
      repaint();
    }),
    vscode.commands.registerCommand("batlehub.java.quarkus.start", () =>
      start(),
    ),
    vscode.commands.registerCommand("batlehub.java.quarkus.debug", async () => {
      const d = debugAvailable();
      if (!d.ok) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t("Quarkus: Debug {0}.", d.reason ?? ""),
        );
        return;
      }
      await start(settings().debugPort);
    }),
    vscode.commands.registerCommand("batlehub.java.quarkus.addExtension", () =>
      editExtensions("add"),
    ),
    vscode.commands.registerCommand(
      "batlehub.java.quarkus.removeExtension",
      () => editExtensions("remove"),
    ),
    vscode.commands.registerCommand("batlehub.java.quarkus.stop", stop),
    vscode.commands.registerCommand(
      "batlehub.java.quarkus.openDevUi",
      openDevUi,
    ),
    vscode.commands.registerCommand("batlehub.java.quarkus.showLog", () =>
      channel.show(true),
    ),
  );

  // §4.1 the bridge, last: a failed write is logged, never a failed activation.
  // The MicroProfile server needs a JDK ≥ 21 — the newest the core found. A
  // write needs trust, so it is tried again when trust is granted.
  const bridge = async () => {
    const jdk = (await api.jdk.list())
      .filter((r) => r.major >= BRIDGE_MIN_MAJOR)
      .sort((a, b) => b.major - a.major)[0];
    const i = vscode.workspace.getConfiguration().inspect(BRIDGE_KEY);
    const home = process.env.JDK_HOME || process.env.JAVA_HOME;
    if (
      bridged ||
      !jdk ||
      !needsBridge({
        bridge: settings().bridge,
        installed: !!vscode.extensions.getExtension(
          "redhat.vscode-microprofile",
        ),
        keySet: [
          i?.globalValue,
          i?.workspaceValue,
          i?.workspaceFolderValue,
        ].some((v) => v !== undefined && v !== null),
        javaHomeMajor: home
          ? releaseMajor(read(path.join(home, "release")))
          : undefined,
        pathJavaMajor: pathJavaMajor(),
      })
    )
      return;
    if (await api.manifest.writeSetting(BRIDGE_KEY, jdk.path)) {
      bridged = jdk.path;
      log(`wrote ${BRIDGE_KEY} = ${jdk.path} (the MicroProfile server's JDK)`);
      repaint();
    }
  };
  const tryBridge = () =>
    bridge().catch((e: Error) =>
      log(`bridge: ${BRIDGE_KEY} not written: ${e.message}`),
    );
  await tryBridge();
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => void tryBridge()),
  );
}

export function deactivate(): void {}

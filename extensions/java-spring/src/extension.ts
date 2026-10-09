// The Spring Boot satellite (RFC 0010): detect Boot from the core's project
// model, give the Spring Tools language server the core's JDK (one bridged
// key), keep the Spring profiles beside the Maven ones in a `Spring` tab, and
// offer one run template. It never starts a process, never talks to JDT.LS,
// and calls none of the VMware extension's commands.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { JavaCoreApi, Module } from "../../java-core/api";
import {
  makeKind,
  dashboardPorts,
  hasBootArtifact,
  healthStatus,
  type Instance,
  metricValue,
  portFor,
  restartAction,
  Uptimes,
  BRIDGE_KEY,
  BRIDGE_MIN_MAJOR,
  CONTRACT_MAJOR,
  type Detected,
  detectGradle,
  detectPom,
  heapMiB,
  launchFor,
  mainClasses,
  needsBridge,
  type Parent,
  type Profiles,
  readProfiles,
  releaseMajor,
  residentFor,
  SPRING_LS_DEFAULT_HEAP_MIB,
  tabHtml,
  TEMPLATE_ID,
} from "./spring";

const channel = vscode.window.createOutputChannel("BatleHub Java: Spring");
const log = (m: string) =>
  channel.appendLine(`[${new Date().toISOString()}] ${m}`);
const VMWARE = "vmware.vscode-spring-boot";
const ACTIVE_KEY = "batlehub.java.spring.activeProfiles";

const settings = () => {
  const c = vscode.workspace.getConfiguration("batlehub.java.spring");
  return {
    enabled: c.get<boolean>("enabled") ?? true,
    activeProfiles: c.get<string[]>("activeProfiles") ?? [],
    bridge: c.get<string>("bridge") ?? "auto",
    ports: c.get<number[]>("dashboard.ports") ?? [],
    pollMs: Math.max(1000, c.get<number>("dashboard.pollMs") ?? 5000),
    runMemoryMiB: c.get<number>("runMemoryMiB") ?? 768,
  };
};

const read = (p: string) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

/** §4.2: a parent on disk by `relativePath` (default `../pom.xml`), else in `~/.m2`. Nothing is run. */
const readParent = (moduleRoot: string) => (p: Parent) => {
  if (p.relativePath !== "") {
    const rel = path.resolve(moduleRoot, p.relativePath ?? "../pom.xml");
    const text = read(rel.endsWith(".xml") ? rel : path.join(rel, "pom.xml"));
    if (text?.includes(`<artifactId>${p.artifact}</artifactId>`)) return text;
  }
  return read(
    path.join(
      os.homedir(),
      ".m2",
      "repository",
      ...p.group.split("."),
      p.artifact,
      p.version,
      `${p.artifact}-${p.version}.pom`,
    ),
  );
};

type Found = Detected & {
  module: string;
  root: string;
  buildFile: string;
  m: Module;
};

async function detect(
  api: JavaCoreApi,
  folder: vscode.WorkspaceFolder,
): Promise<Found | undefined> {
  const walk = (ms: Module[]): Module[] =>
    ms.flatMap((m) => [m, ...walk(m.children)]);
  for (const m of walk(await api.project.modules(folder))) {
    const text = read(m.buildFile) ?? "";
    const d =
      m.tool === "maven"
        ? detectPom(text, readParent(m.root))
        : detectGradle(text);
    if (d)
      return { ...d, module: m.name, root: m.root, buildFile: m.buildFile, m };
  }
  return undefined;
}

/**
 * §4.2, §7: a GET to localhost only, 2 s, no redirect followed, the body
 * capped at 64 KiB and handed to a defensive parser.
 */
async function getLocal(
  port: number,
  p: string,
): Promise<{ status: number; body: string } | undefined> {
  try {
    const r = await fetch(`http://localhost:${port}${p}`, {
      signal: AbortSignal.timeout(2000),
      redirect: "manual",
    });
    return { status: r.status, body: (await r.text()).slice(0, 64 * 1024) };
  } catch {
    return undefined;
  }
}

/** Every `*.java` under the roots, bounded: a scan, not an index. */
function javaFiles(roots: string[], limit = 5000): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith(".java")) out.push(p);
    }
  };
  for (const r of roots) visit(r);
  return out;
}

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
  // §4.3: the members this satellite needs, from an older core, register nothing.
  if (!api.registerRunTemplate || !api.manifest || !api.process?.declare) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Spring Boot: BatleHub Java {0}.{1} lacks contract 1.1; update batlehub.java-core.",
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
    log("no Spring Boot module: nothing registered");
    return;
  }
  log(
    `detected Spring Boot ${found.version ?? (found.unknownParent ? `(version unknown: parent ${found.unknownParent} is not in ~/.m2)` : "(version not named)")} (${found.tool}, module ${found.module})`,
  );

  const resources = found.m.resourceRoots.length
    ? found.m.resourceRoots
    : [path.join(found.root, "src", "main", "resources")];
  const profiles = (): Profiles =>
    readProfiles(
      resources.flatMap((r) => {
        try {
          return fs
            .readdirSync(r)
            .map((name) => ({ name, text: read(path.join(r, name)) ?? "" }));
        } catch {
          return [];
        }
      }),
    );
  const sources = found.m.sourceRoots.length
    ? found.m.sourceRoots
    : [path.join(found.root, "src", "main", "java")];
  const mains = () =>
    mainClasses(javaFiles(sources).map((f) => ({ text: read(f) ?? "" })));
  const mavenProfiles = () =>
    vscode.workspace
      .getConfiguration("batlehub.java")
      .get<string[]>("maven.activeProfiles") ?? [];

  // §4.3: Boot 3 and 4 need a JDK ≥ 17.
  const runtime = (await api.jdk.resolve(folder)).runtime;
  if (!runtime || runtime.major < 17)
    void vscode.window
      .showErrorMessage(
        vscode.l10n.t(
          "Spring Boot: Boot 3 needs a JDK 17 or newer, and BatleHub Java resolved {0}.",
          runtime ? runtime.name : vscode.l10n.t("none"),
        ),
        vscode.l10n.t("Install a JDK…"),
      )
      .then(
        (r) => r && vscode.commands.executeCommand("batlehub.java.installJdk"),
      );

  // §4.3: without the VMware extension, one warning; tab and template work.
  const vmwareMissing = !vscode.extensions.getExtension(VMWARE);
  if (vmwareMissing) {
    log(
      `not installed: ${VMWARE} — no properties completion, no bean navigation`,
    );
    const install = vscode.l10n.t("Install");
    void vscode.window
      .showWarningMessage(
        vscode.l10n.t(
          "Spring Boot: properties completion and bean navigation need Spring Boot Tools ({0}).",
          VMWARE,
        ),
        install,
      )
      .then(
        (r) =>
          r === install &&
          vscode.commands.executeCommand(
            "workbench.extensions.installExtension",
            VMWARE,
          ),
      );
  } else {
    // §4.2: VMware's server is a second JVM the core does not start — an estimate in the sum.
    const c = vscode.workspace.getConfiguration("spring-boot.ls.java");
    const heap =
      heapMiB(
        c.get<string>("heap") ?? undefined,
        c.get<string[]>("vmargs") ?? undefined,
      ) ?? SPRING_LS_DEFAULT_HEAP_MIB;
    context.subscriptions.push(
      api.process.declare({
        id: "spring-ls",
        memoryMiB: residentFor(heap),
        label: "Spring Tools LS",
      }),
    );
  }

  let bridged: string | undefined;
  // The dashboard (§4.2): every declared port, polled over loopback.
  let instances: Instance[] = [];
  const uptimes = new Uptimes();
  /** The template's sessions, by the port their profiles give: what the editor started. */
  const sessions = new Map<number, vscode.DebugSession>();
  const restartOf = () => {
    const p = profiles();
    return restartAction({
      devtools: hasBootArtifact(
        read(found.buildFile) ?? "",
        "spring-boot-devtools",
      ),
      exposure: p.exposure,
      triggerFile: p.triggerFile,
    });
  };
  const tabDef = {
    id: "spring",
    title: "Spring",
    html: () =>
      tabHtml({
        detected: found,
        profiles: profiles(),
        active: settings().activeProfiles,
        mavenProfiles: mavenProfiles(),
        mainClasses: mains(),
        bridged,
        vmwareMissing,
        trusted: vscode.workspace.isTrusted,
        instances,
        actuator: hasBootArtifact(
          read(found.buildFile) ?? "",
          "spring-boot-starter-actuator",
        ),
        restart: restartOf(),
      }),
  };
  let tab = api.registerPanelTab(tabDef);
  const statusDef = {
    id: "spring.instances",
    defaultShown: false,
    command: "batlehub.java.spring.showLog",
  };
  const status = () => {
    const up = instances.filter((i) => i.status === "UP");
    return {
      text: `$(pulse) Spring ${up.length ? up.map((i) => `:${i.port}`).join(" ") : "–"}`,
      tooltip: instances.length
        ? instances.map((i) => `localhost:${i.port} · ${i.status}`).join("\n")
        : vscode.l10n.t(
            "No Spring Boot instance answers on the declared ports.",
          ),
    };
  };
  let item = api.registerStatusBarItem({ ...statusDef, ...status() });
  // The core reads a tab and an item when they are registered: re-register to repaint.
  const repaint = () => {
    tab.dispose();
    tab = api.registerPanelTab(tabDef);
    item.dispose();
    item = api.registerStatusBarItem({ ...statusDef, ...status() });
  };

  let polling = false;
  const poll = async () => {
    // §4.2 trust: a request to a port is an action the workspace could have arranged.
    if (polling || !vscode.workspace.isTrusted) return;
    polling = true;
    try {
      const next: Instance[] = [];
      for (const port of dashboardPorts(profiles(), settings().ports)) {
        const h = await getLocal(port, "/actuator/health");
        const status =
          h && h.status < 400
            ? healthStatus(h.body)
            : h?.status === 503
              ? healthStatus(h.body)
              : undefined;
        if (!status) {
          uptimes.forget(port);
          continue;
        }
        const metric = async (name: string) => {
          const r = await getLocal(port, `/actuator/metrics/${name}`);
          return r?.status === 200 ? metricValue(r.body) : undefined;
        };
        const env = await getLocal(port, "/actuator/env");
        let active: string[] | undefined;
        try {
          const a =
            env?.status === 200
              ? (JSON.parse(env.body) as { activeProfiles?: unknown })
                  .activeProfiles
              : undefined;
          active = Array.isArray(a)
            ? a.filter((x): x is string => typeof x === "string")
            : undefined;
        } catch {
          active = undefined;
        }
        const u = uptimes.observe(
          port,
          Date.now(),
          await metric("process.uptime"),
          await metric("application.ready.time"),
        );
        next.push({
          port,
          status,
          uptimeS: u.uptimeS,
          restarts: u.restarts,
          profiles: active,
          mine: sessions.has(port),
        });
      }
      const changed = JSON.stringify(next) !== JSON.stringify(instances);
      const appeared = next.filter(
        (n) => !instances.some((i) => i.port === n.port),
      );
      const gone = instances.filter(
        (i) => !next.some((n) => n.port === i.port),
      );
      instances = next;
      for (const i of appeared)
        log(
          `instance localhost:${i.port} · ${i.status}${i.mine ? " (started by the editor)" : ""}`,
        );
      for (const i of gone) log(`instance localhost:${i.port} gone`);
      if (changed) repaint();
    } finally {
      polling = false;
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void poll(), settings().pollMs);
  };
  schedule();
  void poll();

  /** The satellite's own key, through the manifest so the removal command restores it (§7 red lines). */
  const setActive = async (list: string[]) => {
    const sorted = [...new Set(list)].sort();
    if (
      !(await api.manifest.writeSetting(ACTIVE_KEY, sorted)) &&
      vscode.workspace.isTrusted
    )
      // A value the user set by hand: their click changes their own setting.
      await vscode.workspace
        .getConfiguration()
        .update(ACTIVE_KEY, sorted, vscode.ConfigurationTarget.Workspace);
    log(`active Spring profiles: ${sorted.join(", ") || "(none)"}`);
  };

  const isTemplate = (s: vscode.DebugSession) =>
    s.type === "java" &&
    (s.configuration.batlehub as { template?: string } | undefined)
      ?.template === TEMPLATE_ID;
  context.subscriptions.push(
    {
      dispose: () => (
        tab.dispose(),
        item.dispose(),
        timer && clearInterval(timer)
      ),
    },
    vscode.debug.onDidStartDebugSession((s) => {
      if (!isTemplate(s)) return;
      const sp =
        (s.configuration.batlehub as { springProfiles?: string[] })
          .springProfiles ?? [];
      sessions.set(portFor(profiles(), sp), s);
      void poll();
    }),
    vscode.debug.onDidTerminateDebugSession((s) => {
      for (const [port, x] of sessions) if (x === s) sessions.delete(port);
      void poll();
    }),
    vscode.commands.registerCommand(
      "batlehub.java.spring.openInstance",
      (port: string) =>
        vscode.commands.executeCommand(
          "simpleBrowser.show",
          `http://localhost:${Number(port)}/`,
        ),
    ),
    vscode.commands.registerCommand(
      "batlehub.java.spring.stopInstance",
      async (port: string) => {
        // Decision 14: only what the editor started; nothing is hunted by port.
        const s = sessions.get(Number(port));
        if (s) await vscode.debug.stopDebugging(s);
      },
    ),
    vscode.commands.registerCommand(
      "batlehub.java.spring.restart",
      async (port: string) => {
        const r = restartOf();
        if (r.kind === "endpoint") {
          await fetch(`http://localhost:${Number(port)}/actuator/restart`, {
            method: "POST",
            signal: AbortSignal.timeout(2000),
          }).catch(() => undefined);
          log(`restart: POST /actuator/restart on ${port}`);
        } else if (r.kind === "trigger") {
          // devtools watches its classpath directories for the trigger file.
          const out = path.join(
            found.root,
            found.tool === "maven" ? "target/classes" : "build/resources/main",
            r.file,
          );
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, new Date().toISOString());
          log(`restart: touched ${out}`);
        }
      },
    ),
    // Phase 4: the app as an ordered run's step — `{ "server": "spring-boot" }`.
    api.registerRunStepKind(
      makeKind(() => ({
        tool: found.tool,
        memoryMiB: settings().runMemoryMiB,
        profiles: profiles(),
        active: settings().activeProfiles,
      })),
    ),
    api.registerRunTemplate({
      id: TEMPLATE_ID,
      title: "Spring Boot application",
      // §4.2 trust: the template is not offered untrusted.
      applies: async (f) =>
        vscode.workspace.isTrusted && !!(await detect(api, f)),
      build: async () => {
        const candidates = mains();
        // §4.3: several candidates — the template asks; none — the field is typed by hand.
        const mainClass =
          candidates.length > 1
            ? await vscode.window.showQuickPick(candidates, {
                title: vscode.l10n.t(
                  "Spring Boot: which @SpringBootApplication?",
                ),
              })
            : (candidates[0] ?? "");
        const launch = launchFor({
          mainClass: mainClass ?? "",
          module: found.module,
          profiles: settings().activeProfiles,
        });
        log(
          `template: ${launch.name} (${mainClass || "no main class found"}, profiles ${settings().activeProfiles.join(",") || "none"})`,
        );
        return { launch };
      },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("batlehub.java.spring") ||
        e.affectsConfiguration("batlehub.java.maven")
      )
        repaint();
    }),
    vscode.commands.registerCommand(
      "batlehub.java.spring.toggleProfile",
      async (name: string) => {
        const a = settings().activeProfiles;
        await setActive(
          a.includes(name) ? a.filter((x) => x !== name) : [...a, name],
        );
      },
    ),
    vscode.commands.registerCommand(
      "batlehub.java.spring.pickProfiles",
      async () => {
        const a = settings().activeProfiles;
        const pick = await vscode.window.showQuickPick(
          profiles().names.map((label) => ({
            label,
            picked: a.includes(label),
          })),
          {
            canPickMany: true,
            title: vscode.l10n.t("Spring Boot: the active profiles"),
          },
        );
        if (pick) await setActive(pick.map((p) => p.label));
      },
    ),
    vscode.commands.registerCommand(
      "batlehub.java.spring.pairProfiles",
      async () => {
        // §4.2: never automatic; once, on click — the declared Spring profiles named like an active Maven one.
        const maven = mavenProfiles();
        await setActive([
          ...settings().activeProfiles,
          ...profiles().names.filter((n) => maven.includes(n)),
        ]);
      },
    ),
    vscode.commands.registerCommand("batlehub.java.spring.showLog", () =>
      channel.show(true),
    ),
  );

  // §4.1 the bridge, last: a failed write is logged, never a failed activation
  // (RFC 0011's phase 2 finding 2). A write needs trust: tried again on grant.
  const bridge = async () => {
    const jdk = (await api.jdk.list())
      .filter((r) => r.major >= BRIDGE_MIN_MAJOR)
      .sort((a, b) => b.major - a.major)[0];
    const key = vscode.workspace.getConfiguration().inspect(BRIDGE_KEY);
    const javaHomeSetting = vscode.workspace
      .getConfiguration("java")
      .get<string>("home");
    const redhat = vscode.extensions.getExtension("redhat.java");
    if (
      bridged ||
      !jdk ||
      !needsBridge({
        bridge: settings().bridge,
        installed: !vmwareMissing,
        keySet: [
          key?.globalValue,
          key?.workspaceValue,
          key?.workspaceFolderValue,
        ].some((v) => v !== undefined && v !== null),
        redhatJre:
          !!redhat && fs.existsSync(path.join(redhat.extensionPath, "jre")),
        javaHomeSettingMajor: javaHomeSetting
          ? releaseMajor(read(path.join(javaHomeSetting, "release")))
          : undefined,
        javaHomeMajor: process.env.JAVA_HOME
          ? releaseMajor(read(path.join(process.env.JAVA_HOME, "release")))
          : undefined,
        pathJavaMajor: pathJavaMajor(),
      })
    )
      return;
    if (await api.manifest.writeSetting(BRIDGE_KEY, jdk.path)) {
      bridged = jdk.path;
      log(`wrote ${BRIDGE_KEY} = ${jdk.path} (the Spring Tools server's JDK)`);
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

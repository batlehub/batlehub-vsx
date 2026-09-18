// Activation (RFC 0001 §6.1): validate `redhat.java`, read the trust state,
// detect, the status bar, the commands, the satellite host, and export the
// JavaCoreApi.
import * as os from "node:os";
import * as vscode from "vscode";
import { makeApi } from "./api";
import type {
  JavaCoreApi,
  LanguageProvider,
  ProjectService,
  RegistryLink,
} from "./api-types";
import { readSettings } from "./config";
import { detect, type Snapshot } from "./detect";
import { formatSize, resourceWarning } from "./detect/resources";
import { Jdk } from "./jdk/service";
import { channelOf, disposeLog, log, setLogLevel } from "./log";
import { removeBatleHubSettings, resumeForeignWrites } from "./manifest";
import { ServerTracker } from "./server/track";
import { JavaStatusBar } from "./statusbar";
import { runWired } from "./wire";

export interface Core {
  context: vscode.ExtensionContext;
  snapshot: () => Snapshot | undefined;
  redetect: () => Promise<void>;
  trusted: () => boolean;
  jdk: Jdk;
  server: ServerTracker;
  statusBar: JavaStatusBar;
  onDidDetect: vscode.Event<Snapshot>;
  api: JavaCoreApi;
  registries: ReturnType<typeof makeApi>["registries"];
  /** The web-side views and menus, registered by phase 3+ modules through `wire`. */
  activatedAt: number;
  /** Phase 6: whether the JDT bundle answered `batlehub.ping` this session. */
  bundle?: { available: boolean };
}

export let core: Core | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<JavaCoreApi> {
  const activatedAt = Date.now();
  setLogLevel(readSettings().logLevel);
  const statusBar = new JavaStatusBar();
  const server = new ServerTracker();
  const detected = new vscode.EventEmitter<Snapshot>();
  let snapshot: Snapshot | undefined;
  let warnedResources = false;
  const trusted = () => vscode.workspace.isTrusted;

  const redetect = async () => {
    const t0 = Date.now();
    const snap = await detect(trusted());
    snapshot = snap;
    log.info(
      `detection in ${Date.now() - t0} ms: ${snap.runtimes.length} runtime(s) [${snap.runtimes.map((r) => `${r.name}@${r.source}`).join(", ")}], managers [${snap.managers.join(", ")}], folders ${snap.folders.map((f) => `${f.tool ?? "plain"}${f.required ? ` wants ${f.required.min}` : ""} → ${f.resolution.runtime?.name ?? "none"} (${f.resolution.reason})`).join("; ")}, limit ${snap.resources.limit ? formatSize(snap.resources.limit) : "none"}, trusted ${snap.trusted}`,
    );
    await jdk.apply(snap);
    paint(snap);
    detected.fire(snap);
  };
  const jdk = new Jdk(() => snapshot, redetect, trusted);

  const paint = (snap: Snapshot) => {
    const first = snap.folders[0];
    const warnings: string[] = [];
    const errors: string[] = [];
    if (server.error) errors.push(server.error);
    if (!snap.trusted)
      warnings.push(
        vscode.l10n.t("untrusted workspace: nothing runs until you trust it"),
      );
    if (first?.resolution.reason === "newest" && first.required)
      warnings.push(
        vscode.l10n.t(
          "JDK {0} (project wants {1})",
          first.resolution.runtime?.major ?? "?",
          first.required.min,
        ),
      );
    if (first?.resolution.reason === "none")
      warnings.push(
        snap.managers.length
          ? vscode.l10n.t("no JDK installed — Java: Install a JDK…")
          : vscode.l10n.t("no JDK and no JDK manager found — see the guide"),
      );
    const rw = resourceWarning(snap.resources, readSettings().warnBelow);
    if (rw) {
      warnings.push(rw.headline);
      if (!warnedResources) {
        warnedResources = true;
        const guide = vscode.l10n.t("Open the guide");
        void vscode.window
          .showWarningMessage(vscode.l10n.t("Java: {0}", rw.headline), guide)
          .then((r) => {
            if (r === guide)
              void vscode.env.openExternal(
                vscode.Uri.parse(
                  "https://batleforc.github.io/batlehub-vsx/guide/java/resources",
                ),
              );
          });
        log.warn(`resources: ${rw.headline} — ${rw.detail}`);
      }
    }
    if (server.mode && server.mode !== "Standard")
      warnings.push(server.gate().reason ?? "");
    statusBar.update({
      jdk: first?.resolution.runtime
        ? `${first.resolution.runtime.name} (${first.resolution.runtime.version}, ${first.resolution.runtime.source})`
        : undefined,
      buildTool: first?.tool
        ? `${first.tool}${first.wrapper ? " (wrapper)" : ""}`
        : undefined,
      mavenProfiles: readSettings().mavenActiveProfiles,
      mavenConfiguration: readSettings().mavenActiveConfiguration,
      serverMode: server.mode,
      warnings: warnings.filter(Boolean),
      errors,
      importing: server.mode === "Hybrid",
    });
  };

  // The satellite host: a language provider gets the JDK the core resolved.
  const onLanguage = async (
    p: LanguageProvider,
  ): Promise<vscode.Disposable> => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return new vscode.Disposable(() => {});
    const runtime = (await jdk.resolve(folder)).runtime;
    let classpath: string[] = [];
    try {
      if (server.api?.getClasspaths && server.gate().workspaceCommands)
        classpath = (
          await server.api.getClasspaths(folder.uri.toString(), {
            scope: "runtime",
          })
        ).classpaths;
    } catch (e) {
      log.debug(`classpath for ${p.id}: ${(e as Error).message}`);
    }
    log.info(
      `language ${p.id} registered (${p.languages.join(", ")}), JDK ${runtime?.name ?? "none"}, ${classpath.length} classpath entries`,
    );
    return p.start({ runtime, folder, classpath });
  };
  const project: ProjectService = {
    modules: async () => [],
    onDidChange: new vscode.EventEmitter<vscode.WorkspaceFolder>().event,
  };
  const registry: RegistryLink = {
    enabled: () => readSettings().registryEnabled,
    token: async () => null,
    url: async () => null,
  };
  const { api, registries } = makeApi({
    jdk,
    project,
    registry,
    statusBar: (i) => statusBar.register(i),
    onLanguage,
  });

  core = {
    context,
    snapshot: () => snapshot,
    redetect,
    trusted,
    jdk,
    server,
    statusBar,
    onDidDetect: detected.event,
    api,
    registries,
    activatedAt,
  };

  context.subscriptions.push(
    statusBar,
    server,
    jdk,
    detected,
    { dispose: disposeLog },
    vscode.commands.registerCommand("batlehub.java.detect", () => {
      resumeForeignWrites();
      return redetect();
    }),
    vscode.commands.registerCommand("batlehub.java.pickJdk", () => jdk.pick()),
    vscode.commands.registerCommand("batlehub.java.installJdk", () =>
      jdk.install(),
    ),
    vscode.commands.registerCommand("batlehub.java.switchMode", async () => {
      const pick = await vscode.window.showQuickPick(
        ["Standard", "LightWeight"],
        { title: vscode.l10n.t("Java: language server mode") },
      );
      if (pick)
        await vscode.commands.executeCommand(
          "java.server.mode.switch",
          pick,
          true,
        );
    }),
    vscode.commands.registerCommand("batlehub.java.showJdtLog", () =>
      channelOf("JDT").show(true),
    ),
    vscode.commands.registerCommand("batlehub.java.showLog", () =>
      channelOf().show(true),
    ),
    vscode.commands.registerCommand("batlehub.java.removeSettings", () =>
      removeBatleHubSettings(blockRemovers),
    ),
    vscode.commands.registerCommand("batlehub.java.showResources", () => {
      const r = snapshot?.resources;
      const lines = r
        ? [
            `limit: ${r.limit ? `${formatSize(r.limit)} (${r.limitSource})` : "none (no cgroup limit)"}`,
            `planned: ${formatSize(r.planned)}`,
            ...r.consumers.map((c) => `  ${c.name}: ${formatSize(c.bytes)}`),
          ]
        : ["no snapshot yet"];
      log.info(`resources:\n${lines.join("\n")}`);
      channelOf().show(true);
    }),
    // Spike (a) of RFC 0001 §12 phase 0: the classpath JDT.LS resolved, into the log, for the heavy suite to read.
    vscode.commands.registerCommand("batlehub.java.dumpClasspath", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder || !server.api?.getClasspaths)
        return log.warn("classpath: no folder or no redhat.java API");
      try {
        await server.api.serverReady?.();
        const uri =
          vscode.workspace.textDocuments
            .find((d) => d.languageId === "java")
            ?.uri.toString() ?? folder.uri.toString();
        const cp = await server.api.getClasspaths(uri, { scope: "runtime" });
        log.info(
          `classpath of ${cp.projectRoot}: ${cp.classpaths.length} entries\n${cp.classpaths.join("\n")}`,
        );
      } catch (e) {
        log.error(`classpath: ${(e as Error).message}`);
      }
      channelOf().show(true);
    }),
    vscode.commands.registerCommand("batlehub.java.reimport", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) await server.reimport(folder);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("batlehub.java") ||
        e.affectsConfiguration("java.configuration.runtimes") ||
        e.affectsConfiguration("java.jdt.ls.vmargs")
      ) {
        setLogLevel(readSettings().logLevel);
        void redetect();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void redetect()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      log.info("workspace trusted: commands enabled, detection runs again");
      void redetect();
    }),
    server.onDidChange(() => snapshot && paint(snapshot)),
  );
  void vscode.commands.executeCommand(
    "setContext",
    "batlehub.java.active",
    true,
  );

  await server.attach();
  if (server.error) {
    log.error(server.error);
    void vscode.window.showErrorMessage(
      vscode.l10n.t("BatleHub Java: {0}", server.error),
    );
  }
  await redetect();
  log.info(
    `activated in ${Date.now() - activatedAt} ms (host ${os.hostname()}, ${vscode.env.appName} ${vscode.version}, ${vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop"})`,
  );
  runWired(core);
  return api;
}

/** Block removers for the manifest's `block` entries, filled by the modules that own a block (Maven's settings.xml, Gradle's init script). */
export const blockRemovers: Record<string, (file: string) => void> = {};

// Side-effect imports: each calls `wire` at load time.
import "./surface";
import "./build";

export function deactivate(): void {
  core = undefined;
}

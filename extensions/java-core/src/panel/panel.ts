// The Java panel (RFC 0001 §4.2, decisions 15, 18, 27): a webview in the
// `Java` view container with tabs — JDK · Build · Run · Profiles, and the
// satellites' through `registerPanelTab`. Plain HTML/CSS/TS on `--vscode-*`
// tokens, bundled by esbuild.mjs; every setting is written to the same
// `settings.json` keys as the Settings UI. The extension side renders the
// state as JSON; media/panel/main.ts owns the DOM, the keyboard and ARIA.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { PanelTab } from "../api-types";
import { installedStock, restoreStock, STOCK } from "../coexistence";
import {
  CHAIN_KEY,
  chainNotice,
  keepChainDefault,
  undoChainDefault,
} from "../completion/chain";
import { isOverridden, readSettings, writeWorkspace } from "../config";
import { formatSize, resourceWarning } from "@batlehub/java-rules/resources";
import type { Core } from "../extension";
import { log } from "../log";
import { javaConfigs, readLaunch } from "../run/configs";
import { toSettingsRuntimes } from "@batlehub/java-rules/resolve";
import {
  writeExtSetting,
  writeForeignSetting,
  writeProjectEntries,
} from "../manifest";
import {
  originLabel,
  TAB_OF,
  type ProjectKey,
  type ProjectValues,
} from "@batlehub/java-rules/project-config";
import { buildOf, requiredOf } from "../detect";
import {
  effectiveConfiguration,
  PROJECT_FILE,
  projectFile,
} from "../project/config";

type ProjectTab = "jdk" | "build" | "profiles";
/** The keys `Save to project` writes from each tab (RFC 0006 §6.4). */
const SAVED_FROM: Record<ProjectTab, ProjectKey[]> = {
  jdk: ["jdk.requirement"],
  build: ["maven.configuration", "registry.enabled"],
  profiles: ["maven.activeProfiles"],
};

/** The editor's merge and the file's own view, with the build file's requirement as what detection says. */
function effective(): ReturnType<typeof effectiveConfiguration> {
  const f = vscode.workspace.workspaceFolders?.[0];
  const req = f ? requiredOf(buildOf(f.uri.fsPath)) : undefined;
  return effectiveConfiguration(
    req ? { "jdk.requirement": String(req.min) } : {},
  );
}

export interface PanelState {
  trusted: boolean;
  serverMode: string;
  /** Which JDK JDT.LS itself runs on — not the same question as the projects' runtimes (§4.2). */
  serverJdk?: string;
  jdk: {
    runtimes: {
      name: string;
      version: string;
      vendor?: string;
      path: string;
      source: string;
      resolved: boolean;
    }[];
    required?: { min: number; origin: string };
    reason?: string;
    managers: string[];
    installVia: { value: string; origin: string };
    sources: { value: string[]; origin: string };
    matchProject: boolean;
    resources: {
      limit?: string;
      planned: string;
      consumers: { name: string; bytes: string }[];
      warning?: string;
    };
  };
  build: {
    tool?: string;
    buildFile?: string;
    wrapper?: string;
    mavenConfigurations: {
      name: string;
      settingsFile?: string;
      active: boolean;
    }[];
    mavenOrigin: string;
    stock: { id: string; name: string; quiet: boolean }[];
    satelliteItems: { id: string; shown: boolean }[];
    registry: { enabled: string; url: string; origin: string };
  };
  run: {
    configs: {
      name: string;
      request: string;
      mainClass?: string;
      projectName?: string;
    }[];
    debugger: boolean;
    testRunner: boolean;
  };
  profiles: { declared: string[]; active: string[] };
  experimental: Record<string, boolean>;
  /**
   * The default-on rule's announcement (RFC 0001 §7.1): one line, once, with
   * the undo beside it. One flag rather than a list of notices because there
   * is exactly one such write today — when a second arrives, this becomes the
   * array it obviously wants to be.
   */
  chainNotice: boolean;
  /** RFC 0006 §6.4: who set each key, project.json's problems per tab. */
  project: {
    origins: Partial<Record<ProjectKey, string>>;
    problems: Record<ProjectTab, number>;
  };
  tabs: { id: string; title: string; html: string }[];
}

export class JavaPanel
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly viewId = "batlehub.java.panel";
  private view: vscode.WebviewView | undefined;
  private firstPaintAt: number | undefined;
  readonly tabs = new Map<string, PanelTab>();

  constructor(private readonly core: Core) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.core.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.core.context.extensionUri, "media"),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(
      (m: { type: string; [k: string]: unknown }) => void this.onMessage(m),
    );
    view.onDidDispose(() => (this.view = undefined));
    void this.push();
  }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.core.context.extensionUri,
        "dist",
        "webview",
        "panel",
        "main.js",
      ),
    );
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.core.context.extensionUri,
        "media",
        "panel",
        "panel.css",
      ),
    );
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${css}"><title>Java</title></head>
<body><div id="app" role="application" aria-label="BatleHub Java panel"><p class="muted">${vscode.l10n.t("Loading…")}</p></div>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  async state(): Promise<PanelState> {
    const snap = this.core.snapshot();
    const s = readSettings();
    const first = snap?.folders[0];
    const res = this.core.resources();
    const rw = res ? resourceWarning(res, s.warnBelow) : undefined;
    const originOf = (key: string, detected: string) =>
      isOverridden(key) ? "set by you" : `detected: ${detected}`;
    const eff = effective();
    const origins: PanelState["project"]["origins"] = {};
    for (const [k, r] of Object.entries(eff.effective)) {
      const o = originLabel(r, eff.trusted);
      if (o) origins[k as ProjectKey] = o;
    }
    const problems = { jdk: 0, build: 0, profiles: 0 };
    for (const p of projectFile()?.problems ?? [])
      problems[
        TAB_OF[p.path as ProjectKey] ??
          (p.path.startsWith("jdk") ? "jdk" : "build")
      ]++;
    const folder = vscode.workspace.workspaceFolders?.[0];
    let configs: PanelState["run"]["configs"] = [];
    if (folder) {
      try {
        configs = javaConfigs(
          readLaunch(
            fs.readFileSync(
              path.join(folder.uri.fsPath, ".vscode", "launch.json"),
              "utf8",
            ),
          ),
        ).map((c) => ({
          name: c.name,
          request: c.request,
          mainClass: c.mainClass,
          projectName: c.projectName,
        }));
      } catch {
        configs = [];
      }
    }
    const quiet = (s.coexistence as { quiet?: string[] }).quiet ?? [];
    const tabs: PanelState["tabs"] = [];
    for (const t of this.core.registries.tabs.values())
      tabs.push({ id: t.id, title: t.title, html: await t.html() });
    return {
      trusted: this.core.trusted(),
      serverMode: this.core.server.mode ?? "unknown",
      serverJdk: this.core.server.serverJdk(),
      jdk: {
        runtimes: (snap?.runtimes ?? []).map((r) => ({
          name: r.name,
          version: r.version,
          vendor: r.vendor,
          path: r.path,
          source: r.source,
          resolved: r.path === first?.resolution.runtime?.path,
        })),
        required: first?.required
          ? { min: first.required.min, origin: first.required.origin }
          : undefined,
        reason: first?.resolution.reason,
        managers: snap?.managers ?? [],
        installVia: {
          value: s.installVia ?? "auto",
          origin: originOf("jdk.installVia", snap?.managers[0] ?? "none"),
        },
        sources: {
          value: s.jdkSources,
          origin: isOverridden("jdk.sources") ? "set by you" : "default",
        },
        matchProject: s.matchProject,
        resources: {
          limit: res?.limit
            ? `${formatSize(res.limit)} (${res.limitSource})`
            : undefined,
          planned: res ? formatSize(res.planned) : "?",
          consumers: (res?.consumers ?? []).map((c) => ({
            name: c.name,
            bytes: formatSize(c.bytes),
          })),
          warning: rw?.headline,
        },
      },
      build: {
        tool: first?.tool,
        buildFile: first?.buildFile,
        wrapper: first?.wrapper,
        mavenConfigurations: (snap?.maven.configurations ?? []).map((c, i) => ({
          name: c.name,
          settingsFile: c.settingsFile,
          active: s.mavenActiveConfiguration
            ? c.name === s.mavenActiveConfiguration
            : i === 0,
        })),
        mavenOrigin:
          snap?.maven.origin.kind === "override"
            ? "set by you"
            : "detected: ~/.m2",
        stock: installedStock().map((x) => ({
          id: x.id,
          name: x.name,
          quiet: quiet.includes(x.id),
        })),
        satelliteItems: this.core.statusBar.satelliteIds(),
        registry: {
          enabled: s.registryEnabled,
          url: s.registryUrl,
          origin: originOf("registry.url", "batlehub-vsx"),
        },
      },
      run: {
        configs,
        debugger: !!vscode.extensions.getExtension("vscjava.vscode-java-debug"),
        testRunner: !!vscode.extensions.getExtension(
          "vscjava.vscode-java-test",
        ),
      },
      profiles: {
        declared: first?.mavenProfiles ?? [],
        // The effective value even before trust, so the tab can show the
        // team's profiles marked "untrusted, not applied" (use case 1).
        active:
          (eff.effective["maven.activeProfiles"]?.value as
            string[] | undefined) ?? [],
      },
      experimental: s.experimental,
      chainNotice: chainNotice(this.core.context),
      project: { origins, problems },
      tabs,
    };
  }

  async push(): Promise<void> {
    if (!this.view) return;
    await this.view.webview.postMessage({
      type: "state",
      state: await this.state(),
    });
  }

  private async onMessage(m: {
    type: string;
    [k: string]: unknown;
  }): Promise<void> {
    try {
      switch (m.type) {
        case "ready":
          if (!this.firstPaintAt) {
            this.firstPaintAt = Date.now();
            log.info(
              `panel first paint ${this.firstPaintAt - this.core.activatedAt} ms after activation`,
            );
          }
          return this.push();
        case "detect":
          return this.core.redetect();
        case "pickJdk":
          return this.core.jdk.pick();
        case "installJdk":
          return this.core.jdk.install();
        case "set": {
          // `key` is a batlehub.java.* key; `undefined` clears the override.
          await writeWorkspace(
            String(m.key),
            m.value === null ? undefined : m.value,
          );
          return;
        }
        case "useRuntime": {
          const snap = this.core.snapshot();
          const r = snap?.runtimes.find((x) => x.path === m.path);
          if (!r || !snap) return;
          await writeForeignSetting(
            "java",
            "configuration.runtimes",
            toSettingsRuntimes(snap.runtimes, r),
          );
          return;
        }
        case "restoreStock":
          await restoreStock(String(m.id));
          return this.push();
        case "quietStock": {
          const s = STOCK.find((x) => x.id === m.id);
          if (!s) return;
          for (const w of s.writes)
            await writeExtSetting(w.section, w.key, w.value);
          const cur = readSettings().coexistence as { quiet?: string[] };
          await writeWorkspace("coexistence", {
            asked: true,
            quiet: [...new Set([...(cur.quiet ?? []), s.id])],
          });
          return this.push();
        }
        case "toggleItem": {
          const items = {
            ...readSettings().statusBarItems,
            [String(m.id)]: !!m.shown,
          };
          await writeWorkspace("statusBar.items", items);
          return this.push();
        }
        case "switchMode":
          await vscode.commands.executeCommand(
            "java.server.mode.switch",
            "Standard",
            true,
          );
          return;
        case "saveProject": {
          // The tab's current values into the team's file, recorded (RFC 0006 red line 1).
          const root = vscode.workspace.workspaceFolders?.[0];
          if (!root || !this.core.trusted()) return;
          const eff = effective().effective;
          const patch: ProjectValues = {};
          for (const k of SAVED_FROM[m.tab as ProjectTab] ?? []) {
            const v = eff[k]?.value;
            if (v !== undefined) patch[k] = v;
          }
          if (!Object.keys(patch).length) return;
          writeProjectEntries(path.join(root.uri.fsPath, PROJECT_FILE), patch);
          log.info(
            `project.json: saved ${Object.keys(patch).join(", ")} from the ${String(m.tab)} tab`,
          );
          return this.push();
        }
        case "command":
          await vscode.commands.executeCommand(
            String(m.command),
            ...((m.args as unknown[]) ?? []),
          );
          return;
        case "undoChain": {
          await undoChainDefault(this.core.context);
          log.info(`${CHAIN_KEY}: undone from the Java panel`);
          return this.push();
        }
        case "keepChain": {
          await keepChainDefault(this.core.context);
          return this.push();
        }
        case "tab": {
          const t =
            this.tabs.get(String(m.id)) ??
            this.core.registries.tabs.get(String(m.id));
          await t?.onMessage?.(m.message);
          return;
        }
        default:
          log.debug(`panel: unknown message ${m.type}`);
      }
    } catch (e) {
      log.error(`panel: ${(e as Error).message}`);
      void vscode.window.showErrorMessage(
        vscode.l10n.t("Java panel: {0}", (e as Error).message),
      );
    }
  }

  dispose(): void {
    this.view = undefined;
  }
}

export function registerPanel(core: Core): vscode.Disposable[] {
  const panel = new JavaPanel(core);
  return [
    panel,
    vscode.window.registerWebviewViewProvider(JavaPanel.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    core.onDidDetect(() => void panel.push()),
    core.onDidChangeProcesses(() => void panel.push()),
    core.server.onDidChange(() => void panel.push()),
    core.registries.onDidChange.event(() => void panel.push()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("batlehub.java") ||
        e.affectsConfiguration("java")
      )
        void panel.push();
    }),
    vscode.commands.registerCommand("batlehub.java.openPanel", async () => {
      await vscode.commands.executeCommand("batlehub.java.panel.focus");
    }),
  ];
}

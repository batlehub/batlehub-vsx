// Phases 4, 5 and 7 wired: the providers behind the seam, the explorer,
// the Maven commands (configuration, profiles, effective POM, tree), the
// registry link's prompt and apply, the block remover for the manifest.
import * as vscode from "vscode";
import * as path from "node:path";
import { isOverridden, readSettings } from "../config";
import { buildOf, requiredOf } from "../detect";
import {
  appliedProject,
  effectiveConfiguration,
  PROJECT_FILE,
  projectFile,
} from "../project/config";
import { blockRemovers, type Core } from "../extension";
import { channelOf, log } from "../log";
import { Explorer, Project } from "../project/explorer";
import { Link } from "../registry/link";
import { wire } from "../wire";
import { GradleProvider } from "./gradle/provider";
import { MavenProvider, removeMavenBlock } from "./maven/provider";
import { MARKER } from "./maven/settings";

wire((core: Core) => {
  const maven = new MavenProvider(core);
  const gradle = new GradleProvider(core);
  const providers = [maven, gradle];
  const link = new Link(core, () => providers);
  const project = new Project(core, providers);
  const explorer = new Explorer(core, project, link);
  blockRemovers[MARKER] = removeMavenBlock;
  // The contract's project and registry services become the real ones.
  // A facade, not the Link: its `token()` must not be reachable from the
  // exports (RFC 0001 §5.2, 1.1 — the token is handed to no one).
  Object.assign(core.api, {
    project,
    registry: {
      enabled: () => link.enabled(),
      url: () => link.url(),
      writeCredential: (t: string) => link.writeCredential(t),
    },
  });

  const firstFolder = () => vscode.workspace.workspaceFolders?.[0];
  const firstModule = async () => {
    const f = firstFolder();
    return f ? (await project.modules(f))[0] : undefined;
  };

  core.context.subscriptions.push(
    vscode.window.registerTreeDataProvider("batlehub.java.explorer", explorer),
    vscode.commands.registerCommand("batlehub.java.explorer.refresh", () => {
      void core.redetect();
      explorer.refresh();
    }),
    vscode.commands.registerCommand(
      "batlehub.java.maven.switchConfiguration",
      async (name?: string) => {
        const snap = core.snapshot();
        const names = snap?.maven.configurations.map((c) => c.name) ?? [];
        const pick =
          name ??
          (await vscode.window.showQuickPick(names, {
            title: vscode.l10n.t("Java: Maven configuration"),
          }));
        if (pick) await maven.switchConfiguration(pick);
      },
    ),
    vscode.commands.registerCommand(
      "batlehub.java.maven.profiles",
      async () => {
        const f = firstFolder();
        const fs0 = core
          .snapshot()
          ?.folders.find((x) => x.folder === f?.uri.fsPath);
        if (!f || !fs0) return;
        const active = readSettings().mavenActiveProfiles ?? [];
        const picks = await vscode.window.showQuickPick(
          fs0.mavenProfiles.map((id) => ({
            label: id,
            picked: active.includes(id),
          })),
          {
            canPickMany: true,
            title: vscode.l10n.t(
              "Java: active Maven profiles (goals and the language server's import)",
            ),
          },
        );
        if (!picks) return;
        await vscode.workspace.getConfiguration("batlehub.java").update(
          "maven.activeProfiles",
          picks.map((p) => p.label),
          vscode.ConfigurationTarget.Workspace,
        );
      },
    ),
    vscode.commands.registerCommand(
      "batlehub.java.maven.applyProfilesOverlay",
      async () => {
        const f = firstFolder();
        if (f)
          await maven.applyProfiles(
            f,
            readSettings().mavenActiveProfiles ?? [],
            true,
          );
      },
    ),
    vscode.commands.registerCommand(
      "batlehub.java.maven.effectivePom",
      async () => {
        const m = await firstModule();
        if (m?.tool === "maven") await maven.effectivePom(m);
      },
    ),
    vscode.commands.registerCommand(
      "batlehub.java.dependencyTree",
      async () => {
        const m = await firstModule();
        if (!m) return;
        const p = providers.find((x) => x.id === m.tool)!;
        const t = await p.dependencyTree(m);
        const lines: string[] = [];
        const walk = (n: typeof t, depth: number) => {
          lines.push(
            `${"  ".repeat(depth)}${n.id}${n.scope ? ` (${n.scope})` : ""}${n.omitted ? ` [${n.omitted}${n.conflict ? ` → ${n.conflict}` : ""}]` : ""}`,
          );
          for (const c of n.children) walk(c, depth + 1);
        };
        walk(t, 0);
        log.info(`dependency tree of ${m.name}:\n${lines.join("\n")}`);
        await vscode.commands.executeCommand("batlehub.java.explorer.focus");
      },
    ),
    vscode.commands.registerCommand(
      "batlehub.java.registry.toggle",
      async () => {
        const cur = link.enabled();
        const next = cur === "true" ? "false" : "true";
        await vscode.workspace
          .getConfiguration("batlehub.java")
          .update(
            "registry.enabled",
            next,
            vscode.ConfigurationTarget.Workspace,
          );
      },
    ),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("batlehub.java.maven.activeProfiles")) {
        const f = firstFolder();
        if (
          f &&
          core.trusted() &&
          core.snapshot()?.folders[0]?.tool === "maven"
        )
          await maven.applyProfiles(
            f,
            readSettings().mavenActiveProfiles ?? [],
          );
      }
      if (e.affectsConfiguration("batlehub.java.registry")) await link.apply();
    }),
  );
  // RFC 0006: project.json's problems on the file, a line per key it names,
  // and a re-detection on every save — the Detect button's path (§4.2).
  const problems = vscode.languages.createDiagnosticCollection("batlehub");
  const publish = () => {
    problems.clear();
    const p = projectFile();
    if (!p) return;
    problems.set(
      vscode.Uri.file(p.file),
      p.problems.map((x) => {
        const d = new vscode.Diagnostic(
          new vscode.Range(x.line, 0, x.line, Number.MAX_SAFE_INTEGER),
          x.message,
          x.severity === "error"
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning,
        );
        d.source = "batlehub";
        return d;
      }),
    );
    for (const [k, v] of Object.entries(p.values))
      log.info(
        `project.json: ${k}=${JSON.stringify(v)} (committed${core.trusted() ? "" : ", untrusted: not applied"})`,
      );
  };
  publish();
  const root = firstFolder();
  const watcher = root
    ? vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, PROJECT_FILE),
      )
    : undefined;
  if (watcher)
    for (const on of [
      watcher.onDidCreate,
      watcher.onDidChange,
      watcher.onDidDelete,
    ])
      core.context.subscriptions.push(
        on(() => {
          publish();
          void core.redetect();
        }),
      );
  core.context.subscriptions.push(
    problems,
    ...(watcher ? [watcher] : []),
    // The team's profiles reach the import without anyone running a command
    // (use case 1) — once trusted, and only when no setting overrides them.
    core.onDidDetect(async (snap) => {
      const f = firstFolder();
      if (
        f &&
        core.trusted() &&
        snap.folders[0]?.tool === "maven" &&
        appliedProject()["maven.activeProfiles"] !== undefined &&
        !isOverridden("maven.activeProfiles")
      )
        await maven.applyProfiles(f, readSettings().mavenActiveProfiles ?? []);
    }),
    vscode.commands.registerCommand(
      "batlehub.java.showEffectiveConfiguration",
      () => {
        const f = firstFolder();
        const req = f ? requiredOf(buildOf(f.uri.fsPath)) : undefined;
        const out = effectiveConfiguration(
          req ? { "jdk.requirement": String(req.min) } : {},
        );
        log.info(
          `effective configuration of ${f ? path.basename(f.uri.fsPath) : "(no folder)"}:\n${JSON.stringify(out, null, 2)}`,
        );
        channelOf().show(true);
      },
    ),
  );
  const once = core.onDidDetect((snap) => {
    if (snap.folders.some((f) => f.tool)) {
      once.dispose();
      void link.propose();
    }
  });
  core.context.subscriptions.push(once);
});

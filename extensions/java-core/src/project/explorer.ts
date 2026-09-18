// The unified project explorer (RFC 0001 §12 phase 4, A.2): folders →
// modules → source roots / test roots / resources / dependencies (with
// conflicts and, when the registry is linked, verdicts) / the JDK. Fed by
// the BuildToolProviders through the ProjectService; usable before indexing
// because it reads build files itself.
import * as path from "node:path";
import * as vscode from "vscode";
import type { Module, ProjectService } from "../api-types";
import type { BuildToolProvider, DependencyNode } from "../build/types";
import { conflicts, flatten } from "../build/maven/deptree";
import type { Core } from "../extension";
import { log } from "../log";
import type { Link } from "../registry/link";
import { type Verdict, verdictGlyph, verdictOf } from "../registry/verdicts";

type Node =
  | { kind: "folder"; folder: vscode.WorkspaceFolder }
  | { kind: "module"; module: Module; folder: vscode.WorkspaceFolder }
  | { kind: "roots"; label: string; roots: string[]; module: Module }
  | { kind: "root"; path: string }
  | { kind: "deps"; module: Module }
  | { kind: "dep"; node: DependencyNode; module: Module }
  | { kind: "jdk"; folder: vscode.WorkspaceFolder }
  | { kind: "message"; text: string };

export class Project implements ProjectService {
  private readonly changed = new vscode.EventEmitter<vscode.WorkspaceFolder>();
  readonly onDidChange = this.changed.event;
  private readonly cache = new Map<string, Module[]>();

  constructor(
    private readonly core: Core,
    readonly providers: BuildToolProvider[],
  ) {
    core.onDidDetect(() => {
      this.cache.clear();
      for (const f of vscode.workspace.workspaceFolders ?? [])
        this.changed.fire(f);
    });
  }

  providerFor(folder: vscode.WorkspaceFolder): BuildToolProvider | undefined {
    const tool = this.core
      .snapshot()
      ?.folders.find((f) => f.folder === folder.uri.fsPath)?.tool;
    return this.providers.find((p) => p.id === tool);
  }

  async modules(folder: vscode.WorkspaceFolder): Promise<Module[]> {
    const key = folder.uri.fsPath;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const p = this.providerFor(folder);
    if (!p) return [];
    const desc = await p.detect(folder);
    const ms = desc ? await p.modules(desc) : [];
    this.cache.set(key, ms);
    return ms;
  }
}

export class Explorer implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly trees = new Map<string, Promise<DependencyNode>>();
  private readonly verdicts = new Map<string, Verdict | undefined>();

  constructor(
    private readonly core: Core,
    private readonly project: Project,
    private readonly link: Link,
  ) {
    project.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.trees.clear();
    this.changed.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (n.kind) {
      case "folder": {
        const t = new vscode.TreeItem(n.folder.name, C.Expanded);
        t.iconPath = vscode.ThemeIcon.Folder;
        t.contextValue = "folder";
        return t;
      }
      case "module": {
        const t = new vscode.TreeItem(n.module.name, C.Collapsed);
        t.description = n.module.tool;
        t.iconPath = new vscode.ThemeIcon("package");
        t.contextValue = `module.${n.module.tool}`;
        t.tooltip = n.module.buildFile;
        t.command = {
          command: "vscode.open",
          title: "Open build file",
          arguments: [vscode.Uri.file(n.module.buildFile)],
        };
        return t;
      }
      case "roots": {
        const t = new vscode.TreeItem(
          n.label,
          n.roots.length ? C.Collapsed : C.None,
        );
        t.description = n.roots.length
          ? String(n.roots.length)
          : vscode.l10n.t("none");
        t.iconPath = new vscode.ThemeIcon(
          n.label.startsWith("Test")
            ? "beaker"
            : n.label.startsWith("Res")
              ? "files"
              : "symbol-namespace",
        );
        return t;
      }
      case "root": {
        const t = new vscode.TreeItem(path.basename(n.path), C.None);
        t.description = vscode.workspace.asRelativePath(n.path);
        t.resourceUri = vscode.Uri.file(n.path);
        t.command = {
          command: "revealInExplorer",
          title: "Reveal",
          arguments: [vscode.Uri.file(n.path)],
        };
        return t;
      }
      case "deps": {
        const t = new vscode.TreeItem(
          vscode.l10n.t("Dependencies"),
          C.Collapsed,
        );
        t.iconPath = new vscode.ThemeIcon("library");
        t.contextValue = "deps";
        return t;
      }
      case "dep": {
        const d = n.node;
        const v = this.verdicts.get(d.id);
        const t = new vscode.TreeItem(
          `${d.groupId ? `${d.groupId}:` : ""}${d.artifactId}`,
          d.children.length ? C.Collapsed : C.None,
        );
        const glyph = verdictGlyph(v);
        t.description = `${d.version}${d.scope ? ` · ${d.scope}` : ""}${d.omitted === "conflict" ? ` · lost to ${d.conflict}` : d.omitted === "duplicate" ? " · duplicate" : ""}${glyph ? ` ${glyph}` : ""}`;
        t.iconPath = new vscode.ThemeIcon(
          d.omitted === "conflict" ? "warning" : "symbol-package",
        );
        t.tooltip = [
          d.id,
          d.scope,
          d.omitted === "conflict"
            ? vscode.l10n.t("omitted: {0} won the conflict", d.conflict ?? "?")
            : undefined,
          v
            ? vscode.l10n.t(
                "BatleHub verdict: {0} {1}",
                v.state,
                v.reasons.join(", "),
              )
            : undefined,
        ]
          .filter(Boolean)
          .join("\n");
        t.contextValue = "dep";
        return t;
      }
      case "jdk": {
        const r = this.core
          .snapshot()
          ?.folders.find((f) => f.folder === n.folder.uri.fsPath)?.resolution;
        const t = new vscode.TreeItem(
          r?.runtime ? `JDK ${r.runtime.name}` : vscode.l10n.t("JDK: none"),
          C.None,
        );
        t.description = r?.runtime
          ? `${r.runtime.version} · ${r.runtime.source}${r.reason === "newest" && r.required ? ` · ${vscode.l10n.t("project wants {0}", r.required.min)}` : ""}`
          : "";
        t.iconPath = new vscode.ThemeIcon(
          r?.reason === "newest" && r.required ? "warning" : "symbol-misc",
        );
        t.command = { command: "batlehub.java.pickJdk", title: "Pick the JDK" };
        return t;
      }
      case "message":
        return new vscode.TreeItem(n.text, C.None);
    }
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      return folders.length
        ? folders.map((folder) => ({ kind: "folder", folder }))
        : [{ kind: "message", text: vscode.l10n.t("No folder open.") }];
    }
    switch (n.kind) {
      case "folder": {
        const ms = await this.project.modules(n.folder);
        const out: Node[] = [{ kind: "jdk", folder: n.folder }];
        if (!ms.length)
          out.push({
            kind: "message",
            text: vscode.l10n.t("No Maven or Gradle build found."),
          });
        return [
          ...out,
          ...ms.map((module) => ({
            kind: "module" as const,
            module,
            folder: n.folder,
          })),
        ];
      }
      case "module": {
        const m = n.module;
        return [
          {
            kind: "roots",
            label: vscode.l10n.t("Sources"),
            roots: m.sourceRoots,
            module: m,
          },
          {
            kind: "roots",
            label: vscode.l10n.t("Tests"),
            roots: m.testRoots,
            module: m,
          },
          {
            kind: "roots",
            label: vscode.l10n.t("Resources"),
            roots: m.resourceRoots,
            module: m,
          },
          { kind: "deps", module: m },
          ...m.children.map((c) => ({
            kind: "module" as const,
            module: c,
            folder: n.folder,
          })),
        ];
      }
      case "roots":
        return n.roots.map((p) => ({ kind: "root", path: p }));
      case "deps": {
        const tree = await this.tree(n.module);
        if (!tree.children.length)
          return [
            {
              kind: "message",
              text: this.core.trusted()
                ? vscode.l10n.t("No dependencies resolved (see the build log).")
                : vscode.l10n.t("Trust the workspace to resolve dependencies."),
            },
          ];
        return tree.children.map((node) => ({
          kind: "dep",
          node,
          module: n.module,
        }));
      }
      case "dep":
        return n.node.children.map((node) => ({
          kind: "dep",
          node,
          module: n.module,
        }));
      default:
        return [];
    }
  }

  private tree(module: Module): Promise<DependencyNode> {
    let p = this.trees.get(module.root);
    if (!p) {
      const provider = this.project.providers.find(
        (x) => x.id === module.tool,
      )!;
      p = provider.dependencyTree(module).then(async (t) => {
        const c = conflicts(t);
        if (Object.keys(c).length)
          log.info(
            `${module.name}: ${Object.keys(c).length} version conflict(s)`,
          );
        await this.decorate(t);
        return t;
      });
      this.trees.set(module.root, p);
    }
    return p;
  }

  /** Verdicts, only when the link is on and batlehub-vsx knows a registry; failures are per node, never a tree error. */
  private async decorate(t: DependencyNode): Promise<void> {
    if (this.link.enabled() !== "true") return;
    const url = await this.link.mavenUrl();
    if (!url) return;
    const token = await this.link.token();
    const nodes = flatten(t).filter((n) => n.groupId && !n.omitted);
    await Promise.all(
      nodes
        .slice(0, 200)
        .map(async (n) =>
          this.verdicts.set(n.id, await verdictOf(url, token, n)),
        ),
    );
    log.info(
      `verdicts fetched for ${Math.min(nodes.length, 200)} node(s) from ${url}`,
    );
  }
}

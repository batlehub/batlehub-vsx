// A Che workspace runs inside a pod's limits: node_modules or target fill the
// projects' volume, a build eats the memory limit, and the first sign is
// ENOSPC or an OOM kill. Read the disk, the memory, the CPU and the processes
// on a timer; show them in the status bar and in a view of their own, and warn
// when one goes over its threshold.
import * as path from "node:path";
import * as vscode from "vscode";
import {
  bar,
  cpuSampler,
  crossings,
  disks,
  gitProjects,
  KINDS,
  memory,
  over,
  pids,
  type Kind,
  type Reading,
} from "./probe";

const NAMES: Record<Kind, string> = {
  disk: "Disk",
  inodes: "Inodes",
  memory: "Memory",
  cpu: "CPU",
  pids: "Processes",
};
const ICONS: Record<Kind, string> = {
  disk: "database",
  inodes: "files",
  memory: "server",
  cpu: "pulse",
  pids: "server-process",
};
const describe = (r: Reading) =>
  `${NAMES[r.kind]} at ${r.pct.toFixed(1)} % (${r.detail})${r.where ? ` on the disk holding ${r.where}` : ""}`;

class Readings implements vscode.TreeDataProvider<Reading> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  rs: Reading[] = [];
  thresholds = {} as Record<Kind, number>;

  set(rs: Reading[], thresholds: Record<Kind, number>): void {
    this.rs = rs;
    this.thresholds = thresholds;
    this.changed.fire();
  }

  getChildren(): Reading[] {
    return this.rs;
  }

  getTreeItem(r: Reading): vscode.TreeItem {
    const hot = over(r, this.thresholds);
    const t = this.thresholds[r.kind];
    const item = new vscode.TreeItem(
      r.where ? `${NAMES[r.kind]} · ${path.basename(r.where)}` : NAMES[r.kind],
    );
    item.id = `${r.kind}:${r.where}`;
    item.description = `${Math.round(r.pct)} % ${bar(r.pct)} ${r.detail}`;
    item.tooltip = `${describe(r)}\nThreshold: ${t > 0 ? `${t} %` : "off"}`;
    item.iconPath = new vscode.ThemeIcon(
      hot ? "warning" : ICONS[r.kind],
      hot ? new vscode.ThemeColor("list.warningForeground") : undefined,
    );
    return item;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(
    "cheResources",
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.name = "Che Resources";
  item.command = "cheResources.status.focus";
  const tree = new Readings();
  const view = vscode.window.createTreeView("cheResources.status", { treeDataProvider: tree });
  const high = new Set<string>();
  const cpu = cpuSampler();
  let timer: NodeJS.Timeout | undefined;

  const check = () => {
    const cfg = vscode.workspace.getConfiguration("cheResources");
    const thresholds = Object.fromEntries(
      KINDS.map((k) => [k, cfg.get<number>(`${k}.threshold`, 0)]),
    ) as Record<Kind, number>;
    const roots = (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === "file")
      .map((f) => f.uri.fsPath);
    if (process.env.PROJECTS_ROOT) roots.push(process.env.PROJECTS_ROOT);
    const rs = [...disks(gitProjects(roots)), memory(), cpu(), pids()].filter(
      (r): r is Reading => !!r,
    );
    for (const r of crossings(rs, thresholds, high))
      void vscode.window.showWarningMessage(`Che Resources: ${describe(r)}.`);
    tree.set(rs, thresholds);

    // Small: memory, CPU and the fullest disk always; anything else once it is over.
    const hot = rs.filter((r) => over(r, thresholds));
    const fullest = rs.filter((r) => r.kind === "disk").sort((a, b) => b.pct - a.pct)[0];
    const shown = rs.filter(
      (r) => r.kind === "memory" || r.kind === "cpu" || r === fullest || hot.includes(r),
    );
    item.text = `$(${hot.length ? "warning" : "pulse"}) ${shown
      .map(
        (r) =>
          `${r.kind === "memory" ? "mem" : NAMES[r.kind].toLowerCase()} ${Math.round(r.pct)} %`,
      )
      .join(" · ")}`;
    item.tooltip = rs.map(describe).join("\n");
    item.backgroundColor = hot.length
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    view.badge = hot.length
      ? { value: hot.length, tooltip: hot.map(describe).join("\n") }
      : undefined;
    item.show();
  };

  const schedule = () => {
    clearInterval(timer);
    const seconds = vscode.workspace
      .getConfiguration("cheResources")
      .get<number>("intervalSeconds", 10);
    timer = setInterval(check, Math.max(2, seconds) * 1000);
    check();
  };

  context.subscriptions.push(
    item,
    view,
    { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand("cheResources.refresh", check),
    vscode.workspace.onDidChangeConfiguration(
      (e) => e.affectsConfiguration("cheResources") && schedule(),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(check),
  );
  schedule();
}

export function deactivate(): void {}

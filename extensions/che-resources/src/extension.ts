// A Che workspace runs inside a pod's limits: node_modules or target fill the
// projects' volume, a build eats the memory limit, and the first sign is
// ENOSPC or an OOM kill. Read the disk, the memory, the CPU and the processes
// every minute, warn when one goes over its threshold.
import * as vscode from "vscode";
import {
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
  disk: "disk",
  inodes: "inodes",
  memory: "memory",
  cpu: "CPU",
  pids: "processes",
};
const describe = (r: Reading) =>
  `${NAMES[r.kind]} at ${r.pct.toFixed(1)} % (${r.detail})${r.where ? ` on the disk holding ${r.where}` : ""}`;

export function activate(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(
    "cheResources",
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.name = "Che Resources";
  item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
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
    const hot = rs.filter((r) => over(r, thresholds));
    if (!hot.length) return item.hide();
    item.text = `$(warning) ${hot.map((r) => `${NAMES[r.kind]} ${Math.round(r.pct)} %`).join(" · ")}`;
    item.tooltip = hot.map(describe).join("\n");
    item.show();
  };

  const schedule = () => {
    clearInterval(timer);
    const seconds = vscode.workspace
      .getConfiguration("cheResources")
      .get<number>("intervalSeconds", 60);
    timer = setInterval(check, Math.max(5, seconds) * 1000);
    check();
  };

  context.subscriptions.push(
    item,
    { dispose: () => clearInterval(timer) },
    vscode.workspace.onDidChangeConfiguration(
      (e) => e.affectsConfiguration("cheResources") && schedule(),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(check),
  );
  schedule();
}

export function deactivate(): void {}

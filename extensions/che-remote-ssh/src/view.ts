// The workspaces, in the sidebar. A flat list: a DevWorkspace either runs
// and can be connected to, or it does not and says so. Anything more would
// duplicate the Che dashboard, which is where a workspace is started.
import * as vscode from "vscode";
import { listWorkspaces } from "./connect";
import type { DevWorkspace } from "./kubectl";
import { log } from "./log";
import type { Session } from "./session";

export class WorkspaceItem extends vscode.TreeItem {
  constructor(readonly workspace: DevWorkspace) {
    super(workspace.name, vscode.TreeItemCollapsibleState.None);
    const running = workspace.phase === "Running";
    this.description = workspace.phase ?? "unknown";
    this.tooltip = `${workspace.namespace}/${workspace.name}`;
    this.contextValue = running ? "running" : "stopped";
    this.iconPath = new vscode.ThemeIcon(running ? "vm-active" : "vm-outline");
    if (running) {
      this.command = {
        command: "cheRemoteSsh.connect",
        title: "Connect",
        arguments: [this],
      };
    }
  }
}

export class WorkspaceTree implements vscode.TreeDataProvider<WorkspaceItem> {
  private readonly changed = new vscode.EventEmitter<WorkspaceItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly session: Session) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(item: WorkspaceItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<WorkspaceItem[]> {
    try {
      const workspaces = await listWorkspaces(this.session);
      return workspaces
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((w) => new WorkspaceItem(w));
    } catch (err) {
      // A view that throws shows nothing and says nothing; the log says why.
      log(`listing workspaces failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}

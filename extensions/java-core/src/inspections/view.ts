// The Inspections view (RFC 0001 §6.1): rule → file → occurrence over the
// bridge's rows, with "Fix all" on a rule node and on a file node.
import * as path from "node:path";
import * as vscode from "vscode";
import type { Bridge } from "./bridge";
import { group, type Row } from "./rules";

export type Node =
  | { kind: "rule"; code: string; count: number }
  | { kind: "file"; code: string; uri: string; rows: Row[] }
  | { kind: "row"; code: string; uri: string; row: Row };

export class InspectionsView
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly bridge: Bridge) {
    this.sub = bridge.onDidChange(() => this.changed.fire(undefined));
  }

  getChildren(n?: Node): Node[] {
    const grouped = group(Object.fromEntries(this.bridge.rows));
    if (!n)
      return grouped.map((g) => ({
        kind: "rule",
        code: g.code,
        count: g.count,
      }));
    if (n.kind === "rule")
      return (grouped.find((g) => g.code === n.code)?.files ?? []).map((f) => ({
        kind: "file",
        code: n.code,
        uri: f.uri,
        rows: f.rows,
      }));
    if (n.kind === "file")
      return n.rows.map((row) => ({
        kind: "row",
        code: n.code,
        uri: n.uri,
        row,
      }));
    return [];
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === "rule") {
      const item = new vscode.TreeItem(
        n.code,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = `${n.count}`;
      item.contextValue = "rule";
      item.iconPath = new vscode.ThemeIcon("lightbulb");
      return item;
    }
    if (n.kind === "file") {
      const item = new vscode.TreeItem(
        path.basename(vscode.Uri.parse(n.uri).fsPath),
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${n.rows.length}`;
      item.contextValue = "file";
      item.resourceUri = vscode.Uri.parse(n.uri);
      return item;
    }
    const item = new vscode.TreeItem(
      `${n.row.range.start.line + 1}:${n.row.range.start.character + 1}  ${n.row.message}`,
    );
    item.contextValue = n.row.fixTitle ? "row-fixable" : "row";
    item.tooltip = n.row.fixTitle ? `Fix: ${n.row.fixTitle}` : n.row.message;
    item.command = {
      command: "vscode.open",
      title: "Open",
      arguments: [
        vscode.Uri.parse(n.uri),
        {
          selection: new vscode.Range(
            n.row.range.start.line,
            n.row.range.start.character,
            n.row.range.end.line,
            n.row.range.end.character,
          ),
        },
      ],
    };
    return item;
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}

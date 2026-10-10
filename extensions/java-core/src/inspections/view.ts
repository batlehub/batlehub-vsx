// The Inspections view (RFC 0001 §6.1): rule → file → occurrence over the
// bridge's rows, with "Fix all" on a rule node and on a file node.
import * as path from "node:path";
import * as vscode from "vscode";
import type { Bridge } from "./bridge";
import { group, type Row } from "@batlehub/java-rules/rules";
import { sonarOf } from "./sonar";
import { CODE as SPELLING, spellingOf } from "./spelling";

export type Node =
  | { kind: "spelling-state"; state: string }
  | { kind: "sonar-state" }
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
    const refresh = () => this.changed.fire(undefined);
    // The bundle's rows, and the two bridged sources beside them.
    this.sub = vscode.Disposable.from(
      bridge.onDidChange(refresh),
      ...[spellingOf(), sonarOf()].flatMap((src) =>
        src ? [src.onDidChange(refresh)] : [],
      ),
    );
  }

  /** The bundle's rows and, beside them, cspell's (RFC 0013 §6.2) and SonarLint's (RFC 0016 §6.2), by document. */
  private all(): Record<string, Row[]> {
    const out: Record<string, Row[]> = Object.fromEntries(this.bridge.rows);
    for (const source of [spellingOf()?.rows, sonarOf()?.rows])
      for (const [uri, rows] of source ?? [])
        out[uri] = [...(out[uri] ?? []), ...rows];
    return out;
  }

  getChildren(n?: Node): Node[] {
    const grouped = group(this.all());
    if (!n) {
      const rules: Node[] = grouped.map((g) => ({
        kind: "rule",
        code: g.code,
        count: g.count,
      }));
      const extra: Node[] = [];
      // RFC 0013 §4.3: without cspell, or with it off for Java, one row that says so.
      const state = spellingOf()?.state();
      if (state && state !== "bridged")
        extra.push({ kind: "spelling-state", state });
      // RFC 0016 use case 3: without SonarLint, one row that says where breadth comes from; "off" hides it.
      if (sonarOf()?.state() === "not installed")
        extra.push({ kind: "sonar-state" });
      return [...rules, ...extra];
    }
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
    if (n.kind === "spelling-state") {
      const missing = n.state === "not available";
      const item = new vscode.TreeItem(
        `${SPELLING} — ${missing ? vscode.l10n.t("not available (install Code Spell Checker)") : vscode.l10n.t("disabled by you")}`,
      );
      item.iconPath = new vscode.ThemeIcon(missing ? "info" : "circle-slash");
      item.contextValue = "spelling-state";
      if (missing)
        item.command = {
          command: "batlehub.java.spelling.install",
          title: vscode.l10n.t("Install"),
        };
      return item;
    }
    if (n.kind === "sonar-state") {
      const item = new vscode.TreeItem(
        vscode.l10n.t("SonarLint is not installed — breadth comes from it"),
      );
      item.iconPath = new vscode.ThemeIcon("info");
      item.contextValue = "sonar-state";
      item.command = {
        command: "batlehub.java.sonar.install",
        title: vscode.l10n.t("Install"),
      };
      return item;
    }
    if (n.kind === "rule") {
      const item = new vscode.TreeItem(
        n.code,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      const spelling = n.code === SPELLING;
      const sonar = n.code.startsWith("sonar/");
      item.description = spelling
        ? `${n.count} · via cspell ${spellingOf()?.version() ?? ""}`
        : sonar
          ? `${n.count} · via SonarLint ${sonarOf()?.version() ?? ""}`
          : `${n.count}`;
      // No Fix all on a bridged rule — spelling's (RFC 0013 §4.2), Sonar's
      // (RFC 0016 §4.2): the core owns no fix for either.
      item.contextValue = spelling
        ? "spelling-rule"
        : sonar
          ? "sonar-rule"
          : "rule";
      item.iconPath = new vscode.ThemeIcon(
        spelling ? "whole-word" : sonar ? "telescope" : "lightbulb",
      );
      return item;
    }
    if (n.kind === "file") {
      const item = new vscode.TreeItem(
        path.basename(vscode.Uri.parse(n.uri).fsPath),
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${n.rows.length}`;
      item.contextValue =
        n.code === SPELLING
          ? "spelling-file"
          : n.code.startsWith("sonar/")
            ? "sonar-file"
            : "file";
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

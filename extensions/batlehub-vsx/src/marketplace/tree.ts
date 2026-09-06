// The fallback marketplace, RFC 0011 §12 phase 8: a tree of the entries
// the registry answered — already filtered server-side by what the
// credential may see — with the state of each against what the editor
// holds. A TreeView first; the details open in the editor's own readme
// preview (detail.ts).
import * as vscode from "vscode";
import { BatleHubClient, ExtensionSummary, extensionId } from "../api";
import { log } from "../log";
import { installedVersion } from "./installer";
import { Ledger } from "./ledger";

export type EntryState = "available" | "installed" | "update";

export class ExtensionNode extends vscode.TreeItem {
  constructor(
    readonly summary: ExtensionSummary,
    readonly state: EntryState,
    readonly installed: string | null,
  ) {
    super(summary.displayName, vscode.TreeItemCollapsibleState.None);
    const id = extensionId(summary.namespace, summary.name);
    this.id = id;
    this.description =
      state === "update"
        ? `${installed} → ${summary.version}`
        : state === "installed"
          ? `${summary.version} · installed`
          : summary.version;
    this.tooltip = new vscode.MarkdownString(
      `**${summary.displayName}** \`${id}\`\n\n${summary.description || "_no description_"}\n\n${summary.namespace} · ${summary.version}`,
    );
    this.contextValue = state;
    this.iconPath = new vscode.ThemeIcon(
      state === "installed" ? "check" : state === "update" ? "arrow-up" : "extensions",
    );
    this.command = { command: "batlehub.showExtension", title: "Show details", arguments: [this] };
  }
}

export class MessageNode extends vscode.TreeItem {
  constructor(label: string, icon: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "message";
    if (command) this.command = command;
  }
}

export type Node = ExtensionNode | MessageNode;

export class MarketplaceTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private query = "";
  private results: ExtensionSummary[] = [];
  private total = 0;
  private loading = false;
  private error: string | null = null;
  private loaded = false;

  constructor(
    private readonly clientOf: () => BatleHubClient | null,
    private readonly ledger: Ledger,
    private readonly pageSize: () => number,
  ) {}

  dispose(): void {
    this.emitter.dispose();
  }

  get currentQuery(): string {
    return this.query;
  }

  get entries(): ExtensionSummary[] {
    return this.results;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    return n;
  }

  async getChildren(n?: Node): Promise<Node[]> {
    if (n) return [];
    const client = this.clientOf();
    if (!client) return [];
    if (!this.loaded && !this.loading) await this.search(this.query);
    if (this.loading) return [new MessageNode("Searching…", "loading~spin")];
    if (this.error)
      return [
        new MessageNode(this.error, "warning", { command: "batlehub.refreshView", title: "Retry" }),
      ];
    if (this.results.length === 0)
      return [
        new MessageNode(
          this.query ? `Nothing matches "${this.query}"` : "The registry lists no extensions",
          "info",
          { command: "batlehub.search", title: "Search" },
        ),
      ];
    const nodes: Node[] = this.results.map((s) => {
      const id = extensionId(s.namespace, s.name);
      const have = installedVersion(id);
      const state: EntryState =
        have === null
          ? "available"
          : have === s.version
            ? "installed"
            : this.ledger.get(id)
              ? "update"
              : "installed";
      return new ExtensionNode(s, state, have);
    });
    if (this.total > this.results.length)
      nodes.push(
        new MessageNode(
          `${this.total - this.results.length} more — refine the search`,
          "ellipsis",
          { command: "batlehub.search", title: "Search" },
        ),
      );
    return nodes;
  }

  async search(query: string): Promise<void> {
    const client = this.clientOf();
    this.query = query;
    if (!client) return;
    this.loading = true;
    this.error = null;
    this.emitter.fire(undefined);
    try {
      const r = await client.search(query, { size: this.pageSize() });
      this.results = r.extensions;
      this.total = r.total;
      this.loaded = true;
    } catch (e) {
      this.results = [];
      this.total = 0;
      this.error = (e as Error).message;
      log(`search "${query}": ${this.error}`);
    } finally {
      this.loading = false;
      this.emitter.fire(undefined);
    }
  }

  refresh(): Promise<void> {
    return this.search(this.query);
  }

  /** Re-read the editor's state without asking the registry again. */
  redraw(): void {
    this.emitter.fire(undefined);
  }

  reset(): void {
    this.loaded = false;
    this.results = [];
    this.total = 0;
    this.error = null;
    this.emitter.fire(undefined);
  }
}

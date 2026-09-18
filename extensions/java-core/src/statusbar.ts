// The single "Java" item (RFC 0001 §4.2, decision 15): its text is the worst
// current state, its tooltip one line per fact, its click opens the panel
// (the JDK quick pick until the panel exists). Satellite items go through
// `registerStatusBarItem` and are toggles in `batlehub.java.statusBar.items`.
import * as vscode from "vscode";
import type { SatelliteStatusBarItem } from "./api-types";
import { readSettings } from "./config";

export type State = "ready" | "importing" | "warning" | "error";
const GLYPH: Record<State, string> = {
  ready: "$(check)",
  importing: "$(sync~spin)",
  warning: "$(warning)",
  error: "$(error)",
};

export interface Facts {
  jdk?: string;
  buildTool?: string;
  mavenConfiguration?: string;
  mavenProfiles?: string[];
  serverMode?: string;
  warnings: string[];
  errors: string[];
  importing?: boolean;
}

export class JavaStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly satellites = new Map<
    string,
    { def: SatelliteStatusBarItem; item?: vscode.StatusBarItem }
  >();
  facts: Facts = { warnings: [], errors: [] };

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "batlehub.java",
      vscode.StatusBarAlignment.Left,
      50,
    );
    this.item.name = "BatleHub Java";
    this.item.command = "batlehub.java.openPanel";
    this.render();
    this.item.show();
  }

  state(): State {
    if (this.facts.errors.length) return "error";
    if (this.facts.warnings.length) return "warning";
    if (this.facts.importing) return "importing";
    return "ready";
  }

  update(patch: Partial<Facts>): void {
    this.facts = { ...this.facts, ...patch };
    this.render();
  }

  private render(): void {
    const s = this.state();
    const f = this.facts;
    this.item.text = `${GLYPH[s]} Java${s === "warning" && f.jdk ? ` ${f.jdk}` : ""}`;
    const lines = [
      f.jdk ? `JDK: ${f.jdk}` : "JDK: none resolved",
      f.buildTool ? `Build: ${f.buildTool}` : undefined,
      f.mavenConfiguration
        ? `Maven configuration: ${f.mavenConfiguration}`
        : undefined,
      f.mavenProfiles?.length
        ? `Maven profiles: ${f.mavenProfiles.join(", ")}`
        : undefined,
      f.serverMode ? `Server mode: ${f.serverMode}` : undefined,
      ...f.warnings.map((w) => `⚠ ${w}`),
      ...f.errors.map((e) => `✗ ${e}`),
    ].filter(Boolean);
    this.item.tooltip = new vscode.MarkdownString(lines.join("  \n"));
    this.item.backgroundColor =
      s === "error"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : s === "warning"
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    this.item.accessibilityInformation = {
      label: `BatleHub Java: ${s}. ${lines.join(". ")}`,
    };
    for (const s of this.satellites.values()) this.renderSatellite(s);
  }

  /** The core hides an item the developer turned off before it is ever created. */
  register(def: SatelliteStatusBarItem): vscode.Disposable {
    const entry = { def, item: undefined as vscode.StatusBarItem | undefined };
    this.satellites.set(def.id, entry);
    this.renderSatellite(entry);
    return new vscode.Disposable(() => {
      entry.item?.dispose();
      this.satellites.delete(def.id);
    });
  }

  private renderSatellite(entry: {
    def: SatelliteStatusBarItem;
    item?: vscode.StatusBarItem;
  }): void {
    const toggles = readSettings().statusBarItems;
    const shown = toggles[entry.def.id] ?? entry.def.defaultShown;
    if (!shown) {
      entry.item?.dispose();
      entry.item = undefined;
      return;
    }
    if (!entry.item) {
      entry.item = vscode.window.createStatusBarItem(
        `batlehub.java.${entry.def.id}`,
        vscode.StatusBarAlignment.Left,
        49,
      );
      entry.item.name = `BatleHub Java: ${entry.def.id}`;
    }
    entry.item.text = entry.def.text;
    entry.item.tooltip = entry.def.tooltip;
    entry.item.command = entry.def.command;
    entry.item.show();
  }

  satelliteIds(): { id: string; shown: boolean }[] {
    const toggles = readSettings().statusBarItems;
    return [...this.satellites.values()].map((s) => ({
      id: s.def.id,
      shown: toggles[s.def.id] ?? s.def.defaultShown,
    }));
  }

  dispose(): void {
    this.item.dispose();
    for (const s of this.satellites.values()) s.item?.dispose();
  }
}

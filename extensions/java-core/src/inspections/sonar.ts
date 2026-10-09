// SonarLint bridged for breadth (RFC 0016 phase 1): its findings in Java
// files become rows of the Inspections view by reading the diagnostics it
// publishes — never re-emitted, so every finding keeps exactly one
// diagnostic, its owner's (§5.1). Its language server is a JVM the core does
// not start, so it is counted in the resource sum as an estimate (§7 Memory).
import * as vscode from "vscode";
import { parseXmx } from "../detect/resources";
import type { Core } from "../extension";
import { log } from "../log";
import { wire } from "../wire";
import type { Row } from "./rules";

export const SONARLINT = "SonarSource.sonarlint-vscode";
/** Phase 0 (decision 12): what SonarLint 5.9.0 puts in `Diagnostic.source`. */
export const SOURCES = ["sonarqube", "sonarlint"];

/** SonarLint's diagnostics → rows keyed `sonar/<ruleKey>` (decision 5); other sources are left alone. */
export function toRows(
  diags: {
    source?: string;
    code?: string | number | { value: string | number };
    severity: number;
    message: string;
    range: Row["range"];
  }[],
): Row[] {
  const sev = ["error", "warning", "info", "hint"] as const;
  const out: Row[] = [];
  for (const d of diags) {
    if (!d.source || !SOURCES.includes(d.source)) continue;
    const raw =
      typeof d.code === "object" && d.code !== null ? d.code.value : d.code;
    const key = raw === undefined ? undefined : String(raw);
    if (!key) continue;
    out.push({
      ruleId: key,
      area: "sonar",
      code: `sonar/${key}`,
      message: d.message,
      severity: sev[d.severity] ?? "info",
      range: d.range,
    });
  }
  return out;
}

/** The figure the resource sum declares: the user's `-Xmx` in `sonarlint.ls.vmargs`, else the estimate (decision 14). */
export function sonarCapMiB(
  vmargs: string | undefined,
  estimateMiB: number,
): number {
  return vmargs && /-Xmx/.test(vmargs)
    ? Math.round(parseXmx(vmargs) / 2 ** 20)
    : estimateMiB;
}

export type SonarState = "bridged" | "not installed" | "off";

export class Sonar implements vscode.Disposable {
  readonly rows = new Map<string, Row[]>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  private estimate?: vscode.Disposable;
  private logged = "";

  constructor(private readonly core: Core) {
    this.subs.push(
      vscode.languages.onDidChangeDiagnostics((e) => this.collect(e.uris)),
      vscode.extensions.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("batlehub.java.inspections.sonar") ||
          e.affectsConfiguration("sonarlint.ls")
        )
          this.refresh();
      }),
    );
    this.refresh();
  }

  private settings() {
    const c = vscode.workspace.getConfiguration("batlehub.java.inspections");
    return {
      mode: c.get<string>("sonar") ?? "auto",
      estimateMiB: c.get<number>("sonar.estimatedCapMiB") ?? 768,
    };
  }

  version(): string | undefined {
    return vscode.extensions.getExtension<unknown>(SONARLINT)?.packageJSON
      ?.version as string | undefined;
  }

  state(): SonarState {
    if (this.settings().mode === "off") return "off";
    return vscode.extensions.getExtension(SONARLINT)
      ? "bridged"
      : "not installed";
  }

  private refresh(): void {
    const s = this.state();
    const line =
      s === "bridged"
        ? `inspections: SonarLint ${this.version()} detected, bridged`
        : `inspections: SonarLint ${s}`;
    if (line !== this.logged) log.info((this.logged = line));
    // §7 Memory: in the sum while it is installed and bridged, as an estimate the core names.
    this.estimate?.dispose();
    this.estimate = undefined;
    if (s === "bridged")
      this.estimate = this.core.processes.declare({
        id: "sonarlint-ls",
        memoryMiB: sonarCapMiB(
          vscode.workspace
            .getConfiguration("sonarlint.ls")
            .get<string>("vmargs") ?? undefined,
          this.settings().estimateMiB,
        ),
        label: "SonarLint language server",
      });
    if (s !== "bridged" && this.rows.size) {
      this.rows.clear();
      this.changed.fire();
    }
    if (s === "bridged")
      this.collect(vscode.languages.getDiagnostics().map(([u]) => u));
    else this.changed.fire();
  }

  private collect(uris: readonly vscode.Uri[]): void {
    if (this.state() !== "bridged" || !this.core.trusted()) return;
    let any = false;
    for (const uri of uris) {
      if (!/\.java$/.test(uri.path)) continue;
      const rows = toRows(
        vscode.languages.getDiagnostics(uri).map((d) => ({
          source: d.source,
          code: d.code as
            string | number | { value: string | number } | undefined,
          severity: d.severity,
          message: d.message,
          range: {
            start: {
              line: d.range.start.line,
              character: d.range.start.character,
            },
            end: { line: d.range.end.line, character: d.range.end.character },
          },
        })),
      );
      const key = uri.toString();
      if (rows.length) this.rows.set(key, rows);
      else if (!this.rows.delete(key)) continue;
      any = true;
    }
    if (any) this.changed.fire();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.estimate?.dispose();
    this.changed.dispose();
  }
}

let sonar: Sonar | undefined;
export const sonarOf = () => sonar;

wire((core: Core) => {
  sonar = new Sonar(core);
  core.context.subscriptions.push(
    sonar,
    vscode.commands.registerCommand("batlehub.java.sonar.install", () =>
      vscode.commands.executeCommand("extension.open", SONARLINT),
    ),
  );
});

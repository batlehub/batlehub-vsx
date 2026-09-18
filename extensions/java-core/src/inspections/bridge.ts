// The JDT.LS diagnostic bridge (RFC 0001 §4.2 "Inspections", "The bundle is
// loaded at server start only"): `batlehub.ping` after the server is ready,
// a DiagnosticCollection fed by `batlehub.inspections.list` for the open
// Java documents, overrides applied client-side, fix-all as one edit.
import * as vscode from "vscode";
import { readSettings } from "../config";
import type { Core } from "../extension";
import { wire } from "../wire";
import { applyLspEdit } from "../generate/menu";
import { log } from "../log";
import { InspectionsView } from "./view";
import { applyOverrides, pingDecision, type Row } from "./rules";

const SOURCE = "batlehub";

export class Bridge implements vscode.Disposable {
  readonly diagnostics = vscode.languages.createDiagnosticCollection(SOURCE);
  readonly rows = new Map<string, Row[]>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private timers = new Map<string, NodeJS.Timeout>();
  private offeredRestart = false;

  constructor(private readonly c: Core) {}

  private async exec<T>(command: string, ...args: unknown[]): Promise<T> {
    return (await vscode.commands.executeCommand(
      "java.execute.workspaceCommand",
      command,
      ...args,
    )) as T;
  }

  /** Once the server is ready and Standard: is the bundle there? */
  async ping(): Promise<void> {
    let ok: boolean | undefined;
    if (this.c.server.mode === "Standard") {
      try {
        log.debug("ping: waiting for serverReady()", "JDT");
        await this.c.server.api?.serverReady?.();
        log.debug("ping: server ready, sending batlehub.ping", "JDT");
        const r = await this.exec<{ version?: string; inspections?: string[] }>(
          "batlehub.ping",
        );
        ok = !!r?.version;
        if (ok)
          log.info(
            `bundle loaded: version ${r!.version}, ${r!.inspections?.length ?? 0} inspection(s)`,
            "JDT",
          );
      } catch (e) {
        ok = false;
        log.warn(`batlehub.ping failed: ${(e as Error).message}`, "JDT");
      }
    }
    const decision = pingDecision(this.c.server.mode, ok, this.offeredRestart);
    this.c.bundle = { available: decision === "loaded" };
    void vscode.commands.executeCommand(
      "setContext",
      "batlehub.java.bundle",
      decision === "loaded",
    );
    if (decision === "restart-offered") {
      this.offeredRestart = true;
      const restart = vscode.l10n.t("Restart the Java language server");
      void vscode.window
        .showWarningMessage(
          vscode.l10n.t(
            "Java: the BatleHub JDT bundle is not loaded (it loads at server start). Restart the language server to load it; the Generate menu uses Red Hat's generators meanwhile.",
          ),
          restart,
        )
        .then((r) => {
          if (r === restart) void this.c.server.restart();
        });
    }
    if (decision === "loaded")
      for (const d of vscode.workspace.textDocuments) this.schedule(d, 0);
  }

  schedule(doc: vscode.TextDocument, delay = 600): void {
    if (doc.languageId !== "java" || doc.uri.scheme !== "file") return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => void this.refresh(doc.uri), delay),
    );
  }

  async refresh(uri: vscode.Uri): Promise<void> {
    const s = readSettings().inspections;
    if (!s.enabled || !this.c.bundle?.available) {
      this.diagnostics.delete(uri);
      this.rows.delete(uri.toString());
      this.changed.fire();
      return;
    }
    try {
      const raw = await this.exec<Row[]>(
        "batlehub.inspections.list",
        uri.toString(),
      );
      const rows = applyOverrides(raw ?? [], s.severityOverrides);
      this.rows.set(uri.toString(), rows);
      this.diagnostics.set(
        uri,
        rows.map((r) => {
          const d = new vscode.Diagnostic(
            new vscode.Range(
              r.range.start.line,
              r.range.start.character,
              r.range.end.line,
              r.range.end.character,
            ),
            r.message,
            SEVERITY[r.severity],
          );
          d.source = SOURCE;
          d.code = r.code;
          return d;
        }),
      );
      this.changed.fire();
    } catch (e) {
      log.debug(`inspections ${uri.fsPath}: ${(e as Error).message}`, "JDT");
    }
  }

  /** One workspace edit: every fix in the file, or every fix of one rule. */
  async fixAll(uri: vscode.Uri, ruleId?: string): Promise<number> {
    const edit = await this.exec<{ changes?: Record<string, unknown[]> }>(
      "batlehub.inspections.fixAll",
      uri.toString(),
      ruleId ?? null,
    );
    const n = Object.values(edit?.changes ?? {}).reduce(
      (a, l) => a + l.length,
      0,
    );
    if (n) await applyLspEdit(edit!);
    log.info(
      `fix all${ruleId ? ` (${ruleId})` : ""} in ${uri.fsPath}: ${n} edit(s)`,
      "JDT",
    );
    return n;
  }

  dispose(): void {
    this.diagnostics.dispose();
    this.changed.dispose();
    for (const t of this.timers.values()) clearTimeout(t);
  }
}

const SEVERITY: Record<Row["severity"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

wire((c: Core) => {
  const bridge = new Bridge(c);
  const view = new InspectionsView(bridge);
  c.context.subscriptions.push(
    bridge,
    view,
    vscode.window.registerTreeDataProvider("batlehub.java.inspections", view),
    c.server.onDidChange(() => void bridge.ping()),
    vscode.workspace.onDidOpenTextDocument((d) => bridge.schedule(d, 0)),
    vscode.workspace.onDidChangeTextDocument((e) =>
      bridge.schedule(e.document),
    ),
    vscode.workspace.onDidSaveTextDocument((d) => bridge.schedule(d, 0)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      bridge.diagnostics.delete(d.uri);
      bridge.rows.delete(d.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("batlehub.java.inspections"))
        for (const d of vscode.workspace.textDocuments) bridge.schedule(d, 0);
    }),
    vscode.commands.registerCommand("batlehub.java.inspections.refresh", () => {
      for (const d of vscode.workspace.textDocuments) bridge.schedule(d, 0);
    }),
    vscode.commands.registerCommand(
      "batlehub.java.inspections.fixAll",
      async (arg?: { uri?: string; code?: string } | vscode.Uri) => {
        const uri =
          arg instanceof vscode.Uri
            ? arg
            : arg?.uri
              ? vscode.Uri.parse(arg.uri)
              : vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;
        if (
          !(await c.server.requireStandard(vscode.l10n.t("fixing inspections")))
        )
          return;
        const ruleId =
          arg && !(arg instanceof vscode.Uri) && arg.code
            ? arg.code.split("/").pop()
            : undefined;
        const n = await bridge.fixAll(uri, ruleId);
        void vscode.window.setStatusBarMessage(
          vscode.l10n.t("Java: {0} fix(es) applied", n),
          4000,
        );
      },
    ),
    vscode.commands.registerCommand("batlehub.java.restartServer", () =>
      c.server.restart(),
    ),
  );
  void bridge.ping();
});

// The JDT.LS diagnostic bridge (RFC 0001 §4.2 "Inspections", "The bundle is
// loaded at server start only"): `batlehub.ping` after the server is ready,
// a DiagnosticCollection fed by `batlehub.inspections.list` for the open
// Java documents, overrides applied client-side, fix-all as one edit. The
// team's profile (RFC 0005), `.batlehub/java/inspections.json` in the first
// workspace folder, is merged under the developer's overrides.
import * as fs from "node:fs";
import * as vscode from "vscode";
import { readSettings } from "../config";
import type { Core } from "../extension";
import { wire } from "../wire";
import { applyLspEdit } from "../generate/menu";
import { log } from "../log";
import { writeProfileEntries } from "../manifest";
import { InspectionsView } from "./view";
import {
  applyOverrides,
  pingDecision,
  type Row,
} from "@batlehub/java-rules/rules";
import {
  bulkFixSkip,
  differing,
  mergeSeverities,
  parseProfile,
  profileFromOverrides,
  profileSummary,
  validate,
  type Profile,
  type ProfileProblem,
  type Severity,
  type Validated,
} from "@batlehub/java-rules/profile";

export const PROFILE = ".batlehub/java/inspections.json";

/** The running bridge, for the Java panel's inspections line (RFC 0005 §6.2), and when its profile state changes. */
export let current: Bridge | undefined;
export const profileChanged = new vscode.EventEmitter<void>();

const SOURCE = "batlehub";

export class Bridge implements vscode.Disposable {
  readonly diagnostics = vscode.languages.createDiagnosticCollection(SOURCE);
  readonly rows = new Map<string, Row[]>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private timers = new Map<string, NodeJS.Timeout>();
  private offeredRestart = false;
  /** The loaded bundle's ids and declared severities: undefined until it answers. */
  private known: string[] | undefined;
  private defaults: Record<string, Severity> = {};
  /** The profile file as last read: absent, unreadable, or parsed. */
  profile:
    | {
        uri: vscode.Uri;
        parsed?: Profile;
        lines: Record<string, number>;
        problems: ProfileProblem[];
        project?: Validated;
      }
    | undefined;

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
    let commands: string[] | undefined;
    if (this.c.server.mode === "Standard") {
      try {
        log.debug("ping: waiting for serverReady()", "JDT");
        await this.c.server.api?.serverReady?.();
        log.debug("ping: server ready, sending batlehub.ping", "JDT");
        const r = await this.exec<{
          version?: string;
          inspections?: string[];
          defaults?: Record<string, Severity>;
          commands?: string[];
        }>("batlehub.ping");
        ok = !!r?.version;
        commands = r?.commands;
        if (ok) {
          this.known = r!.inspections ?? [];
          this.defaults = r!.defaults ?? {};
          if (!r!.defaults)
            log.info(
              "bundle gives no rule defaults: every profile downgrade needs a why (RFC 0005 decision 9)",
              "JDT",
            );
        }
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
    this.c.bundle = { available: decision === "loaded", commands };
    void vscode.commands.executeCommand(
      "setContext",
      "batlehub.java.bundle",
      decision === "loaded",
    );
    // RFC 0015: the builder and withers entries, shown when the bundle has them.
    void vscode.commands.executeCommand(
      "setContext",
      "batlehub.java.shortcuts",
      decision === "loaded" &&
        !!commands?.includes("batlehub.generate.builder"),
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
    if (decision === "loaded") this.loadProfile();
  }

  /** Reads the profile, checks it against the bundle once it has answered, puts its rows on the file, and refreshes every open document (§5.2). */
  loadProfile(): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (this.profile) this.diagnostics.delete(this.profile.uri);
    this.profile = undefined;
    if (root) {
      const uri = vscode.Uri.joinPath(root, PROFILE);
      let text: string | undefined;
      try {
        text = fs.readFileSync(uri.fsPath, "utf8");
      } catch {
        text = undefined;
      }
      if (text !== undefined) {
        const { profile, lines, problems } = parseProfile(text);
        const project = profile
          ? validate(profile, lines, this.known, this.defaults)
          : undefined;
        this.profile = {
          uri,
          parsed: profile,
          lines,
          problems: [...problems, ...(project?.problems ?? [])],
          project,
        };
        this.diagnostics.set(
          uri,
          this.profile.problems.map((p) => {
            const d = new vscode.Diagnostic(
              new vscode.Range(p.line, 0, p.line, Number.MAX_SAFE_INTEGER),
              p.message,
              SEVERITY[p.severity],
            );
            d.source = SOURCE;
            if (p.key) d.code = p.key;
            return d;
          }),
        );
        if (profile && project && this.known)
          log.info(profileSummary(profile, project, this.known), "JDT");
      }
    }
    this.changed.fire();
    profileChanged.fire();
    for (const d of vscode.workspace.textDocuments) this.schedule(d, 0);
  }

  /** The codes whose override changes a profile entry: the "differs from project" marker. */
  differs(): string[] {
    const v = this.profile?.project;
    return v
      ? differing(v.merged, readSettings().inspections.severityOverrides)
      : [];
  }

  /** `Save as project profile` (§4.2): the overrides into the team's file, recorded in the manifest; undefined when there is nothing to save. */
  saveProfile(): vscode.Uri | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const rules = profileFromOverrides(
      readSettings().inspections.severityOverrides,
      this.known ?? [],
      this.defaults,
    );
    if (!root || !Object.keys(rules).length) return undefined;
    const uri = vscode.Uri.joinPath(root, PROFILE);
    writeProfileEntries(uri.fsPath, rules);
    log.info(
      `profile: saved ${Object.keys(rules).length} rule(s) to ${PROFILE}`,
      "JDT",
    );
    this.loadProfile();
    return uri;
  }

  /** Whether the profile has been checked against the loaded bundle (the banner's `not yet checked`). */
  checked(): boolean {
    return this.known !== undefined;
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
      const v = this.profile?.project;
      const rows = applyOverrides(
        raw ?? [],
        mergeSeverities(v?.merged ?? {}, s.severityOverrides),
      );
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
          // A rule the team downgraded that still shows carries the team's reason (§4.2).
          const why = v?.reasons[r.code];
          if (why && v!.merged[r.code] === r.severity)
            d.relatedInformation = [
              new vscode.DiagnosticRelatedInformation(
                new vscode.Location(
                  this.profile!.uri,
                  new vscode.Position(this.profile!.lines[r.code] ?? 0, 0),
                ),
                `profile: ${why}`,
              ),
            ];
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
    // A bulk fix leaves out what the team turned off (RFC 0005 decision 11).
    const skip = ruleId
      ? []
      : bulkFixSkip(
          this.profile?.project?.merged ?? {},
          readSettings().inspections.severityOverrides,
        );
    const edit = await this.exec<{ changes?: Record<string, unknown[]> }>(
      "batlehub.inspections.fixAll",
      uri.toString(),
      ruleId ?? null,
      skip,
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

const SEVERITY: Record<
  Row["severity"] | ProfileProblem["severity"],
  vscode.DiagnosticSeverity
> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint,
};

wire((c: Core) => {
  const bridge = new Bridge(c);
  current = bridge;
  const view = new InspectionsView(bridge);
  const tree = vscode.window.createTreeView("batlehub.java.inspections", {
    treeDataProvider: view,
  });
  view.attach(tree);
  const root = vscode.workspace.workspaceFolders?.[0];
  const watcher = root
    ? vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, PROFILE),
      )
    : undefined;
  if (watcher)
    for (const on of [
      watcher.onDidCreate,
      watcher.onDidChange,
      watcher.onDidDelete,
    ])
      c.context.subscriptions.push(on(() => bridge.loadProfile()));
  c.context.subscriptions.push(
    bridge,
    view,
    tree,
    ...(watcher ? [watcher] : []),
    c.server.onDidChange(() => void bridge.ping()),
    vscode.workspace.onDidOpenTextDocument((d) => bridge.schedule(d, 0)),
    vscode.workspace.onDidChangeTextDocument((e) =>
      bridge.schedule(e.document),
    ),
    vscode.workspace.onDidSaveTextDocument((d) => bridge.schedule(d, 0)),
    vscode.workspace.onDidCloseTextDocument((d) => {
      // The profile's own rows outlive its editor tab.
      if (d.uri.toString() === bridge.profile?.uri.toString()) return;
      bridge.diagnostics.delete(d.uri);
      bridge.rows.delete(d.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("batlehub.java.inspections")) {
        for (const d of vscode.workspace.textDocuments) bridge.schedule(d, 0);
        view.refresh();
      }
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
    vscode.commands.registerCommand(
      "batlehub.java.inspections.saveProfile",
      async () => {
        const uri = bridge.saveProfile();
        if (!uri) {
          void vscode.window.showInformationMessage(
            vscode.l10n.t(
              "Java: no inspection override to save — set batlehub.java.inspections.severityOverrides first.",
            ),
          );
          return;
        }
        await vscode.window.showTextDocument(uri);
      },
    ),
    vscode.commands.registerCommand("batlehub.java.restartServer", () =>
      c.server.restart(),
    ),
  );
  bridge.loadProfile();
  void bridge.ping();
});

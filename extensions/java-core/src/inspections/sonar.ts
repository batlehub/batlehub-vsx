// SonarLint bridged for breadth (RFC 0016 phase 1): its findings in Java
// files become rows of the Inspections view by reading the diagnostics it
// publishes — never re-emitted, so every finding keeps exactly one
// diagnostic, its owner's (§5.1). Its language server is a JVM the core does
// not start, so it is counted in the resource sum as an estimate (§7 Memory).
// Phase 2: `sonarlint.ls.javaHome` for a build without its own JRE, written
// under the default-on rule; and the profile's `sonar/*` offs, which reach
// `sonarlint.rules` only on the developer's action — SonarLint accepts that
// key in user settings alone (decision 15).
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { parseXmx } from "@batlehub/java-rules/resources";
import { mergeSeverities } from "@batlehub/java-rules/profile";
import { readSettings } from "../config";
import type { Core } from "../extension";
import { log } from "../log";
import {
  readManifest,
  undoForeignSetting,
  writeSatelliteSetting,
  writeUserSetting,
} from "../manifest";
import { wire } from "../wire";
import { targetOf } from "../written";
import type { Row } from "@batlehub/java-rules/rules";

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

/** SonarLint 5.x's server needs a Java 17 (§4.3). */
export const SONAR_MIN_JAVA = 17;
const JAVA_HOME = "sonarlint.ls.javaHome";
const RULES = "sonarlint.rules";
/** §7: a profile key reaches a settings object as a JSON key only in this shape. */
const RULE_KEY = /^[a-z]+:[A-Za-z0-9_-]+$/;

/**
 * Use case 1 under decision 13: the JDK SonarLint's server is pointed at —
 * the newest the core found at or above its minimum — and only for a build
 * that carries no JRE of its own.
 */
export function sonarJavaHome(f: {
  hasJre: boolean;
  enabled: boolean;
  runtimes: { major: number; path: string }[];
}): string | undefined {
  if (f.hasJre || !f.enabled) return undefined;
  return f.runtimes.find((r) => r.major >= SONAR_MIN_JAVA)?.path;
}

/**
 * The `sonar/*` rule keys at `off` (the developer's override over the team's
 * profile) that `sonarlint.rules` does not mention yet: what the view offers
 * to apply. A key the user's settings already name — `on` or `off` — is
 * theirs, never pending.
 */
export function pendingOffs(
  levels: Record<string, string>,
  rules: Record<string, unknown> | undefined,
): string[] {
  return Object.entries(levels)
    .filter(([k, v]) => k.startsWith("sonar/") && v === "off")
    .map(([k]) => k.slice("sonar/".length))
    .filter((k) => RULE_KEY.test(k) && !(k in (rules ?? {})));
}

/** §6.1 `toSonarRules`: the pending offs merged into the user's own value, every key of theirs kept. */
export function toSonarRules(
  user: Record<string, unknown> | undefined,
  off: string[],
): Record<string, unknown> {
  return {
    ...user,
    ...Object.fromEntries(off.map((k) => [k, { level: "off" }])),
  };
}

const ours = (target: string) =>
  readManifest().entries.find((e) => targetOf(e) === target);

export type SonarState = "bridged" | "not installed" | "off";

export class Sonar implements vscode.Disposable {
  readonly rows = new Map<string, Row[]>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  private estimate?: vscode.Disposable;
  private logged = "";
  private loggedHome = "";
  private applying: Promise<void> = Promise.resolve();
  private project: Record<string, string> | undefined;
  /** The profile's offs SonarLint does not apply yet: the view's `not applied` and its action. */
  pending: string[] = [];

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
        else if (e.affectsConfiguration("sonarlint.rules")) void this.apply();
        else if (
          e.affectsConfiguration("batlehub.java.inspections.severityOverrides")
        )
          void this.apply();
      }),
      core.jdk.onDidChange(() => void this.apply()),
    );
    this.refresh();
  }

  private settings() {
    const c = vscode.workspace.getConfiguration("batlehub.java.inspections");
    return {
      mode: c.get<string>("sonar") ?? "auto",
      writeJavaHome: c.get<boolean>("sonar.writeJavaHome") ?? true,
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
    void this.apply();
  }

  /** The team's levels, from the bridge each time it reads the profile. */
  setProject(merged: Record<string, string>): Promise<void> {
    this.project = merged;
    return this.apply();
  }

  /** The two writes, one change at a time. */
  private apply(): Promise<void> {
    return (this.applying = this.applying
      .then(() => this.sync())
      .catch((e) =>
        log.warn(`inspections: SonarLint: ${(e as Error).message}`),
      ));
  }

  private async sync(): Promise<void> {
    if (!this.core.trusted()) return;
    const state = this.state();
    // `off` writes nothing and takes back what the core wrote (§4.1).
    if (state === "off") {
      if (ours(`setting:${JAVA_HOME}`) && (await undoForeignSetting(JAVA_HOME)))
        log.info(`inspections: SonarLint off — ${JAVA_HOME} restored`);
      if (
        ours(`user-setting:${RULES}`) &&
        (await undoForeignSetting(RULES, "user"))
      )
        log.info(`inspections: SonarLint off — ${RULES} restored`);
      return;
    }
    const ext = vscode.extensions.getExtension(SONARLINT);
    if (!ext) return;
    await this.syncJavaHome(ext);
    this.syncPending();
  }

  private async syncJavaHome(ext: vscode.Extension<unknown>): Promise<void> {
    const hasJre = fs.existsSync(path.join(ext.extensionPath, "jre"));
    const home = sonarJavaHome({
      hasJre,
      enabled: this.settings().writeJavaHome,
      runtimes: await this.core.jdk.list(),
    });
    let line = "";
    if (home)
      line = (await writeSatelliteSetting(JAVA_HOME, home))
        ? `inspections: wrote ${JAVA_HOME} = ${home}`
        : `inspections: ${JAVA_HOME} is yours (${vscode.workspace.getConfiguration("sonarlint.ls").get<string>("javaHome")}), left alone`;
    else if (!hasJre && this.settings().writeJavaHome)
      line = `inspections: SonarLint needs Java ${SONAR_MIN_JAVA}+ and the core found none — ${JAVA_HOME} not written`;
    if (line && line !== this.loggedHome) log.info((this.loggedHome = line));
  }

  private syncPending(): void {
    const next = this.project
      ? pendingOffs(
          mergeSeverities(
            this.project as never,
            readSettings().inspections.severityOverrides,
          ),
          vscode.workspace
            .getConfiguration("sonarlint")
            .get<Record<string, unknown>>("rules"),
        )
      : [];
    if (next.join() === this.pending.join()) return;
    this.pending = next;
    if (next.length)
      log.info(
        `inspections: the profile turns off ${next.join(", ")} — SonarLint reads ${RULES} from user settings only, so it waits for "Turn off in my user settings"`,
      );
    this.changed.fire();
  }

  /** The view's action: the pending offs into the developer's user settings, recorded for Remove. */
  async applyPending(): Promise<void> {
    if (!this.pending.length || !this.core.trusted()) return;
    const user = vscode.workspace
      .getConfiguration("sonarlint")
      .inspect<Record<string, unknown>>("rules")?.globalValue;
    await writeUserSetting(RULES, toSonarRules(user, this.pending));
    await this.apply();
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
    vscode.commands.registerCommand("batlehub.java.sonar.applyRules", () =>
      sonar!.applyPending(),
    ),
  );
});

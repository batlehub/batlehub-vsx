// Follow `redhat.java`'s server mode (RFC 0001 §4.2, decision 36): the
// context key the menus gate on, the tooltip line, the offer to switch the
// mode instead of failing a command.
import * as fs from "node:fs";
import * as vscode from "vscode";
import { log } from "../log";
import {
  gate,
  MIN_REDHAT_JAVA,
  type RedHatApi,
  type ServerMode,
  versionAtLeast,
} from "./mode";

export class ServerTracker implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ServerMode | undefined>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  mode: ServerMode | undefined;
  api: RedHatApi | undefined;
  /** The hard error of §4.3, or undefined. */
  error: string | undefined;

  async attach(): Promise<void> {
    const ext = vscode.extensions.getExtension<RedHatApi>("redhat.java");
    if (!ext) {
      this.error = vscode.l10n.t(
        "redhat.java is not installed: every language feature is delegated to it.",
      );
      return;
    }
    const version = String(
      (ext.packageJSON as { version?: string }).version ?? "0",
    );
    if (!versionAtLeast(version, MIN_REDHAT_JAVA)) {
      this.error = vscode.l10n.t(
        "redhat.java {0} is older than the {1} BatleHub Java needs.",
        version,
        MIN_REDHAT_JAVA,
      );
      return;
    }
    try {
      this.api = ext.isActive ? ext.exports : await ext.activate();
    } catch (e) {
      this.error = vscode.l10n.t(
        "redhat.java failed to activate: {0}",
        (e as Error).message,
      );
      return;
    }
    this.set(this.api?.serverMode);
    if (this.api?.onDidServerModeChange)
      this.subs.push(this.api.onDidServerModeChange((m) => this.set(m)));
    log.info(
      `redhat.java ${version} (api ${this.api?.apiVersion ?? "?"}), server mode ${this.mode ?? "unknown"}`,
    );
  }

  private set(mode: ServerMode | undefined): void {
    this.mode = mode;
    const g = gate(mode);
    void vscode.commands.executeCommand(
      "setContext",
      "batlehub.java.serverMode",
      mode ?? "unknown",
    );
    void vscode.commands.executeCommand(
      "setContext",
      "batlehub.java.standard",
      g.rename,
    );
    this.changed.fire(mode);
  }

  gate() {
    return gate(this.mode);
  }

  /** Before a command that needs Standard mode: explain, offer the switch, return whether to go on. */
  async requireStandard(what: string): Promise<boolean> {
    const g = this.gate();
    if (g.workspaceCommands) return true;
    const sw = vscode.l10n.t("Switch to Standard mode");
    const r = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Java: {0} needs the full language server — {1}.",
        what,
        g.reason ?? "",
      ),
      sw,
    );
    if (r === sw)
      await vscode.commands.executeCommand(
        "java.server.mode.switch",
        "Standard",
        true,
      );
    return false;
  }

  async restart(): Promise<void> {
    await vscode.commands.executeCommand("java.server.restart");
  }

  /** Ask JDT.LS to re-import the build files of a folder (what `Reload Projects` does for one uri). */
  async reimport(folder: vscode.WorkspaceFolder): Promise<void> {
    const build = [
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
    ]
      .map((f) => vscode.Uri.joinPath(folder.uri, f))
      .find((u) => fs.existsSync(u.fsPath));
    log.info(`re-import requested for ${build?.fsPath ?? folder.uri.fsPath}`);
    await vscode.commands.executeCommand(
      "java.projectConfiguration.update",
      build ?? folder.uri,
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}

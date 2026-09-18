// The JdkService of the contract and the newcomer story (RFC 0001 §12 phase
// 2): list, resolve per folder, write `java.configuration.runtimes` through
// the manifest, the quick pick, the install delegated to a manager.
import * as vscode from "vscode";
import type { JdkService, Resolution, Runtime } from "../api-types";
import { readSettings } from "../config";
import type { Snapshot } from "../detect";
import { realIo } from "../io";
import { log } from "../log";
import { writeForeignSetting } from "../manifest";
import { chooseManager, installCommand, offers } from "./install";
import { toSettingsRuntimes } from "./resolve";

export class Jdk implements JdkService, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  snapshot: Snapshot | undefined;

  constructor(
    private readonly current: () => Snapshot | undefined,
    private readonly redetect: () => Promise<void>,
    private readonly trusted: () => boolean,
    /** `redhat.java` found no JDK of its own — the only state that earns the second write (§4.2). */
    private readonly serverNeedsJdk: () => Promise<boolean>,
  ) {}

  async list(): Promise<Runtime[]> {
    return this.current()?.runtimes ?? [];
  }

  async resolve(folder: vscode.WorkspaceFolder): Promise<Resolution> {
    const f = this.current()?.folders.find(
      (x) => x.folder === folder.uri.fsPath,
    );
    return f?.resolution ?? { reason: "none" };
  }

  /** v0.1 already writes `java.configuration.runtimes` (workspace) so `redhat.java` sees exactly what the status bar says. */
  async apply(snap: Snapshot): Promise<void> {
    if (!this.trusted()) return;
    const resolved = snap.folders[0]?.resolution.runtime;
    const runtimes = toSettingsRuntimes(snap.runtimes, resolved);
    if (!runtimes.length) return;
    await writeForeignSetting("java", "configuration.runtimes", runtimes);
    // The language server itself needs a JDK ≥ 17; with none on PATH or in
    // JAVA_HOME (`mise` without a global version is exactly that) redhat.java
    // never starts. Point it at the newest we found — the one write that
    // makes a Che newcomer's editor work. Only when redhat.java itself found
    // none, though (revision 7): a desktop's /usr/lib/jvm is a JDK the core
    // does not scan, and writing under a server that was already starting put
    // a second JDT.LS on the same workspace (§4.2, §15.5).
    const ls = vscode.workspace
      .getConfiguration("java")
      .get<string | null>("jdt.ls.java.home");
    const newest = snap.runtimes.find((r) => r.major >= 17);
    if (!ls && newest && (await this.serverNeedsJdk()))
      await writeForeignSetting("java", "jdt.ls.java.home", newest.path);
    this.changed.fire();
  }

  async pick(): Promise<void> {
    const snap = this.current();
    const items: (vscode.QuickPickItem & {
      runtime?: Runtime;
      action?: "install" | "detect";
    })[] = (snap?.runtimes ?? []).map((r) => ({
      label: `$(symbol-misc) ${r.name}`,
      description: `${r.version}${r.vendor ? ` · ${r.vendor}` : ""} · ${r.source}`,
      detail: r.path,
      runtime: r,
      picked: r.path === snap?.folders[0]?.resolution.runtime?.path,
    }));
    items.push({
      label: "$(cloud-download) " + vscode.l10n.t("Install a JDK…"),
      action: "install",
      description: vscode.l10n.t("through mise or sdkman"),
    });
    items.push({
      label: "$(refresh) " + vscode.l10n.t("Detect again"),
      action: "detect",
    });
    const req = snap?.folders[0]?.required;
    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t("Java: which JDK?"),
      placeHolder: req
        ? vscode.l10n.t(
            "The project asks for Java {0} ({1})",
            req.min,
            req.origin,
          )
        : vscode.l10n.t("No requirement found in the build file"),
    });
    if (!pick) return;
    if (pick.action === "install") return this.install();
    if (pick.action === "detect") return this.redetect();
    if (pick.runtime && snap) {
      // A hand-picked runtime becomes the default entry; the folders' own
      // resolution is recomputed on the next detection from the setting.
      await writeForeignSetting(
        "java",
        "configuration.runtimes",
        toSettingsRuntimes(snap.runtimes, pick.runtime),
      );
      this.changed.fire();
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "Java: {0} is the default runtime for this workspace.",
          pick.runtime.name,
        ),
      );
    }
  }

  async install(): Promise<void> {
    if (!this.trusted()) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Java: nothing runs in an untrusted workspace. Trust it to install a JDK.",
        ),
      );
      return;
    }
    const io = realIo({ trusted: true });
    const via = readSettings().installVia ?? "auto";
    const m = await chooseManager(io, via);
    if (!m) {
      const guide = vscode.l10n.t("Open the guide");
      const r = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Java: no JDK manager found (mise, sdkman). BatleHub Java does not download JDKs itself.",
        ),
        guide,
      );
      if (r === guide)
        void vscode.env.openExternal(
          vscode.Uri.parse(
            "https://batleforc.github.io/batlehub-vsx/guide/java/jdk",
          ),
        );
      return;
    }
    const list = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("Java: asking {0} which JDKs it offers…", m),
      },
      () => offers(io, m),
    );
    const want = this.current()?.folders[0]?.required?.min;
    const pick = await vscode.window.showQuickPick(
      list.map((o) => ({
        label: `Java ${o.major}`,
        description: o.id,
        picked: o.major === want,
        id: o.id,
      })),
      { title: vscode.l10n.t("Java: install which JDK with {0}?", m) },
    );
    if (!pick) return;
    const argv = installCommand(m, pick.id);
    const terminal = vscode.window.createTerminal({
      name: `Java: install ${pick.id}`,
    });
    terminal.show();
    terminal.sendText(
      argv
        .map((a) =>
          /^[\w@.+=/-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`,
        )
        .join(" "),
      true,
    );
    log.info(`install delegated to ${m}: ${argv.join(" ")}`);
    const sub = vscode.window.onDidCloseTerminal(async (t) => {
      if (t !== terminal) return;
      sub.dispose();
      await this.redetect();
    });
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Java: {0} is installing {1} in the terminal. Close it when done; detection runs again.",
        m,
        pick.id,
      ),
    );
  }

  dispose(): void {
    this.changed.dispose();
  }
}

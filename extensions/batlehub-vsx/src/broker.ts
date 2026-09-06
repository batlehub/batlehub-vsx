// Broker mode, RFC 0011 §12 phase 7: keep the contract file fresh for the
// consumers that only read it (the patched editor, the local gallery
// proxy), show the credential state in the status bar, and after a login
// make the Extensions view ask the gallery again — the one thing the
// bootstrap sign-in entry cannot do for itself.
//
// The same object serves marketplace mode: the view needs the credential
// too, and a user signs in the same way in both.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { BatleHubAuthProvider } from "./auth-provider";
import { cliToken } from "./cli";
import { Settings } from "./config";
import { CONTRACT_OWNER, entryState, expiresAt, removeContractEntry } from "./contract";
import { Credential, CredentialChain } from "./credentials";
import { log } from "./log";

/** A token with less than this left is refreshed by a broker tick. */
export const MIN_TTL_MS = 120_000;
const TICK_MS = 60_000;

export type BrokerState =
  | { kind: "unconfigured" }
  | { kind: "signed-out" }
  | { kind: "ok"; credential: Credential }
  | { kind: "expired"; owner?: string };

export class Broker implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private watcher: fs.FSWatcher | undefined;
  private watchDebounce: NodeJS.Timeout | undefined;
  private chain: CredentialChain | undefined;
  private settings: Settings;
  private state: BrokerState = { kind: "unconfigured" };
  private readonly changed = new vscode.EventEmitter<BrokerState>();
  readonly onDidChange = this.changed.event;
  private ticking: Promise<void> | null = null;

  constructor(
    settings: Settings,
    private readonly auth: BatleHubAuthProvider,
    private readonly readSettings: () => Settings,
  ) {
    this.settings = settings;
    this.item = vscode.window.createStatusBarItem(
      "batlehub.credential",
      vscode.StatusBarAlignment.Right,
      90,
    );
    this.item.name = "BatleHub credential";
    this.item.command = "batlehub.status";
    this.render();
    this.item.show();
    this.configure(settings);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.item.dispose();
    this.changed.dispose();
  }

  get current(): BrokerState {
    return this.state;
  }

  /** The chain for the configured registry; null when none is configured. */
  chainOf(): CredentialChain | null {
    return this.chain ?? null;
  }

  configure(settings: Settings): void {
    this.settings = settings;
    this.watcher?.close();
    this.watcher = undefined;
    if (!settings.origin) {
      this.chain = undefined;
      this.setState({ kind: "unconfigured" });
      return;
    }
    const origin = settings.origin;
    this.chain = new CredentialChain({
      origin,
      contractPath: settings.contractPath,
      env: process.env,
      cli: (o) =>
        cliToken(this.readSettings().cliPath, o, { minTtlSeconds: MIN_TTL_MS / 1000, log }),
      interactive: async () => {
        const s = await this.auth.createSession();
        const cur = await this.auth.current();
        return {
          token: s.accessToken,
          kind: cur?.kind ?? "oidc",
          expiresAt: cur?.expiresAt ?? null,
        };
      },
      refreshOwn: () => this.auth.refresh(),
      minTtlMs: MIN_TTL_MS,
      log,
    });
    this.watch(settings.contractPath);
    if (!this.timer) this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  private watch(file: string): void {
    const dir = path.dirname(file);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
        if (name && name !== path.basename(file)) return;
        if (this.watchDebounce) clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => void this.tick(), 400);
      });
      this.watcher.on("error", (e) => log(`watching ${dir}: ${e.message}`));
    } catch (e) {
      log(`cannot watch ${dir}: ${(e as Error).message}`);
    }
  }

  /**
   * One pass: what does the chain yield without asking the user, and does
   * the entry this extension owns need a refresh before it expires?
   */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.doTick().finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async doTick(): Promise<void> {
    const chain = this.chain;
    if (!chain) return;
    try {
      const cred = await chain.resolve({ interactive: false });
      if (cred) {
        this.setState({ kind: "ok", credential: cred });
        return;
      }
      const { entry } = chain.entry();
      const st = entryState(entry);
      if (entry && st === "expired")
        this.setState({ kind: "expired", owner: entry.refresh?.owner });
      else this.setState({ kind: "signed-out" });
    } catch (e) {
      log(`credential tick: ${(e as Error).message}`);
    }
  }

  /** Steps 4–5, then the re-query the bootstrap entry cannot do. */
  async signIn(): Promise<Credential | null> {
    const chain = this.chain;
    if (!chain) {
      const open = "Open settings";
      const r = await vscode.window.showWarningMessage(
        "BatleHub: set batlehub.registry first.",
        open,
      );
      if (r === open) await vscode.commands.executeCommand("batlehub.openSettings");
      return null;
    }
    const cred = await chain.resolve({ interactive: true });
    if (cred) {
      this.setState({ kind: "ok", credential: cred });
      await this.requery();
      void vscode.window.setStatusBarMessage(`BatleHub: signed in (${cred.source})`, 4000);
    }
    return cred;
  }

  async signOut(): Promise<void> {
    await this.auth.removeSession();
    if (this.settings.origin) {
      try {
        removeContractEntry(this.settings.contractPath, this.settings.origin);
      } catch (e) {
        log(`removing the contract entry: ${(e as Error).message}`);
      }
    }
    this.setState({ kind: "signed-out" });
    await this.requery();
  }

  /** Make the editor's Extensions view ask its gallery again. Best effort. */
  async requery(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.extensions.action.refreshExtension");
      log("re-queried the editor's Extensions view");
    } catch (e) {
      log(`refreshing the Extensions view: ${(e as Error).message}`);
    }
  }

  private setState(s: BrokerState): void {
    const before = JSON.stringify(summarize(this.state));
    this.state = s;
    void vscode.commands.executeCommand("setContext", "batlehub.signedIn", s.kind === "ok");
    this.render();
    if (JSON.stringify(summarize(s)) !== before) this.changed.fire(s);
  }

  private render(): void {
    const s = this.state;
    switch (s.kind) {
      case "unconfigured":
        this.item.text = "$(shield) BatleHub";
        this.item.tooltip = "No registry configured (batlehub.registry)";
        this.item.backgroundColor = undefined;
        break;
      case "signed-out":
        this.item.text = "$(shield) BatleHub: sign in";
        this.item.tooltip = `No credential for ${this.settings.origin}`;
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        break;
      case "expired":
        this.item.text = "$(shield) BatleHub: expired";
        this.item.tooltip = `The credential for ${this.settings.origin} expired${s.owner ? ` (refreshed by ${s.owner})` : ""}`;
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        break;
      case "ok": {
        const c = s.credential;
        const ttl = c.expiresAt ? ` · ${remaining(c.expiresAt)}` : "";
        this.item.text = `$(shield) BatleHub: ${c.kind}${ttl}`;
        this.item.tooltip = `${this.settings.origin}\n${describeSource(c)}${c.expiresAt ? `\nexpires ${c.expiresAt.toLocaleString()}` : ""}`;
        this.item.backgroundColor = undefined;
        break;
      }
    }
  }

  /** The status the user asked for: one screen, no secret on it. */
  async showStatus(mode: string, reason: string): Promise<void> {
    const s = this.state;
    const lines = [
      `Registry: ${this.settings.registry || "(not configured)"}`,
      `Mode: ${mode} — ${reason}`,
      `Contract file: ${this.settings.contractPath}`,
    ];
    switch (s.kind) {
      case "unconfigured":
        lines.push("State: no registry configured");
        break;
      case "signed-out":
        lines.push("State: no credential");
        break;
      case "expired":
        lines.push(`State: expired${s.owner ? `, owner ${s.owner}` : ""}`);
        break;
      case "ok":
        lines.push(`State: ok (${describeSource(s.credential)})`);
        if (s.credential.expiresAt)
          lines.push(
            `Expires: ${s.credential.expiresAt.toISOString()} (${remaining(s.credential.expiresAt)})`,
          );
        break;
    }
    const entry = this.chain?.entry().entry;
    if (entry)
      lines.push(
        `File entry: kind ${entry.kind}, refresh ${entry.refresh?.source ?? "none"}${entry.refresh?.owner ? ` by ${entry.refresh.owner}` : ""}, expires ${expiresAt(entry)?.toISOString() ?? "never"}`,
      );
    const actions =
      s.kind === "ok" ? ["Sign out", "Refresh now", "Show log"] : ["Sign in", "Show log"];
    const pick = await vscode.window.showInformationMessage(
      lines.join("\n"),
      { modal: false, detail: undefined },
      ...actions,
    );
    if (pick === "Sign in") await vscode.commands.executeCommand("batlehub.signIn");
    else if (pick === "Sign out") await vscode.commands.executeCommand("batlehub.signOut");
    else if (pick === "Refresh now")
      await vscode.commands.executeCommand("batlehub.refreshCredential");
    else if (pick === "Show log") await vscode.commands.executeCommand("batlehub.showLog");
  }
}

function summarize(s: BrokerState): unknown {
  return s.kind === "ok"
    ? { kind: s.kind, source: s.credential.source, exp: s.credential.expiresAt?.getTime() ?? null }
    : s;
}

function describeSource(c: Credential): string {
  switch (c.source) {
    case "contract":
      return `from the contract file${c.refreshOwner ? `, refreshed by ${c.refreshOwner === CONTRACT_OWNER ? "this extension" : c.refreshOwner}` : ""}`;
    case "env":
      return "from BATLEHUB_TOKEN";
    case "cli":
      return "from the BatleHub CLI";
    case "interactive":
      return "from this sign-in";
  }
}

export function remaining(exp: Date, now = Date.now()): string {
  const ms = exp.getTime() - now;
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

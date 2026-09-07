// The credential, from settings and SecretStorage to a kubeconfig kubectl
// can use. Every command goes through here rather than holding a token of
// its own, so there is one place that decides when to refresh and one file
// that ever holds a token.
import { homedir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { discoverChe, normalizeUrl, probeApiServer, type CheEndpoints } from "./discovery";
import { defaultRunner, must, type Runner } from "./exec";
import { chooseKubeconfig, writeKubeconfig, type KubeconfigChoice } from "./kubeconfig";
import { forInstance, hostOf, type ClusterSettings, type InstanceOverride } from "./instances";
import { versionArgs, type KubectlContext } from "./kubectl";
import { log, maskLiteral } from "./log";
import { readRecords, stillOurs, type ForwardRecord } from "./registry";
import { isListening } from "./ports";
import { removeIdentity, writeIdentity } from "./sshfiles";
import { isFresh, pollForToken, refresh, requestDeviceCode, type TokenSet } from "./oidc";

const SECRET_CLIENT = "cheRemoteSsh.clientSecret";
const SECRET_REFRESH = "cheRemoteSsh.refreshToken";
const SCOPES = ["openid", "profile", "email", "offline_access"];
const ACTIVE_INSTANCE = "cheRemoteSsh.activeInstance";

export interface Settings extends ClusterSettings {
  url: string;
  /** Per-instance overrides, keyed by host. */
  instances: Record<string, InstanceOverride>;
}

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration("cheRemoteSsh");
  return {
    url: normalizeUrl(c.get<string>("url") ?? ""),
    apiServer: normalizeUrl(c.get<string>("apiServer") ?? ""),
    insecureSkipTlsVerify: c.get<boolean>("insecureSkipTlsVerify") ?? false,
    certificateAuthority: c.get<string>("certificateAuthority") ?? "",
    kubectlPath: c.get<string>("kubectlPath") ?? "kubectl",
    kubeconfig: c.get<string>("kubeconfig") ?? "",
    context: c.get<string>("context") ?? "",
    namespace: (c.get<string>("namespace") ?? "").trim(),
    instances: c.get<Record<string, InstanceOverride>>("instances") ?? {},
  };
}

async function update(key: string, value: unknown): Promise<void> {
  await vscode.workspace
    .getConfiguration("cheRemoteSsh")
    .update(key, value, vscode.ConfigurationTarget.Global);
}

export class SignInCancelled extends Error {
  constructor() {
    super("sign-in cancelled");
  }
}

export class Session {
  private tokens: TokenSet | undefined;
  private discovered: CheEndpoints | undefined;
  /** The instance in play, remembered across restarts. */
  private instance: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly run: Runner = defaultRunner,
  ) {}

  /**
   * Work against this Che from now on. A link names its instance, and each
   * instance may be reached with its own kubeconfig. The choice outlives the
   * window, so the sidebar opens on the Che last worked with.
   */
  useInstance(urlOrHost: string): void {
    const host = hostOf(urlOrHost);
    if (host === this.instance) return;
    this.instance = host;
    // The discovery and the token belong to the instance they came from.
    this.discovered = undefined;
    this.tokens = undefined;
    void this.context.globalState.update(ACTIVE_INSTANCE, host || undefined);
  }

  /** Pick up the instance this editor was last working with. */
  restoreInstance(): void {
    const stored = this.context.globalState.get<string>(ACTIVE_INSTANCE);
    if (stored) this.instance = stored;
  }

  /** The host in play, or the default instance when none was chosen. */
  get activeInstance(): string {
    return this.instance ?? hostOf(settings().url);
  }

  /** Every Che this editor knows of: the default one and the table's keys. */
  knownInstances(): string[] {
    const flat = settings();
    const hosts = new Set<string>();
    const fromUrl = hostOf(flat.url);
    if (fromUrl) hosts.add(fromUrl);
    for (const key of Object.keys(flat.instances)) {
      const host = hostOf(key);
      if (host) hosts.add(host);
    }
    if (this.instance) hosts.add(this.instance);
    return [...hosts].sort();
  }

  /** Point one Che at a kubeconfig, leaving every other instance alone. */
  async setInstanceKubeconfig(host: string, kubeconfig: string, context: string): Promise<void> {
    const key = hostOf(host);
    const config = vscode.workspace.getConfiguration("cheRemoteSsh");
    const table = { ...config.get<Record<string, InstanceOverride>>("instances") };
    // Reuse the key already there, however it was written, so a host given
    // once as a URL does not end up in the table twice.
    const slot = Object.keys(table).find((k) => hostOf(k) === key) ?? key;
    table[slot] = { ...table[slot], kubeconfig, context };
    await config.update("instances", table, vscode.ConfigurationTarget.Global);
  }

  /** The settings for the instance in play: its entry over the defaults. */
  get effective(): Settings {
    const flat = settings();
    return forInstance(flat, flat.instances, this.instance ?? flat.url);
  }

  get storage(): string {
    return this.context.globalStorageUri.fsPath;
  }

  /** The file this extension writes when it is the one authenticating. */
  get ownKubeconfigPath(): string {
    return path.join(this.storage, "kubeconfig.json");
  }

  /** Which kubeconfig is in play, and whether we may write or delete it. */
  get choice(): KubeconfigChoice {
    const s = this.effective;
    return chooseKubeconfig({
      configured: s.kubeconfig,
      context: s.context,
      ownFile: this.ownKubeconfigPath,
      home: homedir(),
    });
  }

  /**
   * True when this extension authenticates. False when it was pointed at a
   * kubeconfig of the user's, in which case no sign-in happens at all: the
   * credential in that file is whatever it is, certificates included.
   */
  get authenticates(): boolean {
    return this.choice.owned;
  }

  get identityDir(): string {
    return path.join(this.storage, "keys");
  }

  /** Where connected windows leave the lease that keeps a forward alive. */
  get leaseDir(): string {
    return path.join(this.storage, "leases");
  }

  /** Where detached forwards are written down, so any window can find them. */
  get forwardDir(): string {
    return path.join(this.storage, "forwards");
  }

  /**
   * A tunnel for this workspace that is still up, started by this window or
   * by one that has since closed. Reconnecting reuses it rather than opening
   * a second forward onto the same pod.
   */
  async liveForward(authority: string): Promise<ForwardRecord | undefined> {
    for (const record of await readRecords(this.forwardDir)) {
      if (record.authority !== authority) continue;
      if (!stillOurs(record)) continue;
      if (await isListening(record.port)) return record;
    }
    return undefined;
  }

  get managedSshConfig(): string {
    return path.join(this.storage, "ssh", "che-remote-ssh.conf");
  }

  /** The user's own ~/.ssh, touched only to add our Include. */
  get sshDir(): string {
    return path.join(homedir(), ".ssh");
  }

  /** Store a workspace's key where only this user can read it. */
  writeIdentity(pod: string, key: string): Promise<string> {
    return writeIdentity(this.identityDir, pod, key);
  }

  forgetIdentity(pod: string): Promise<void> {
    return removeIdentity(this.identityDir, pod);
  }

  kubectl(): KubectlContext {
    const choice = this.choice;
    return {
      bin: this.effective.kubectlPath,
      kubeconfig: choice.file,
      ...(choice.context ? { context: choice.context } : {}),
    };
  }

  /** The Che URL, asked for once and kept in settings. */
  async url(): Promise<string> {
    const current = this.instance ? `https://${this.instance}` : settings().url;
    if (current) return current;
    const entered = await vscode.window.showInputBox({
      title: "Che Remote SSH",
      prompt: "Your Eclipse Che instance",
      placeHolder: "https://che.example.dev",
      ignoreFocusOut: true,
      validateInput: (v) => {
        try {
          const u = new URL(v.trim());
          return u.protocol.startsWith("http") ? null : "expected an http(s) URL";
        } catch {
          return "expected a URL";
        }
      },
    });
    if (!entered) throw new SignInCancelled();
    const url = normalizeUrl(entered);
    await update("url", url);
    return url;
  }

  async che(): Promise<CheEndpoints> {
    if (this.discovered) return this.discovered;
    const url = await this.url();
    this.discovered = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Discovering this Che…" },
      () => discoverChe(url, { log }),
    );
    return this.discovered;
  }

  /**
   * The OIDC client secret. Che's client is confidential and this is the one
   * thing discovery cannot find. It lives in SecretStorage and is masked in
   * the log from the moment it is known.
   */
  async clientSecret(): Promise<string> {
    const stored = await this.context.secrets.get(SECRET_CLIENT);
    if (stored) {
      maskLiteral(stored);
      return stored;
    }
    const che = await this.che();
    const entered = await vscode.window.showInputBox({
      title: "Che Remote SSH",
      prompt: `The secret of the OIDC client "${che.clientId}", from your identity provider`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!entered) throw new SignInCancelled();
    const secret = entered.trim();
    maskLiteral(secret);
    await this.context.secrets.store(SECRET_CLIENT, secret);
    return secret;
  }

  /** The API server, from settings when set, otherwise probed and confirmed. */
  async apiServer(): Promise<string> {
    const configured = this.effective.apiServer;
    if (configured) return configured;
    const url = await this.url();
    const found = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Looking for the Kubernetes API…" },
      () => probeApiServer(url, { log }),
    );
    if (found) {
      await update("apiServer", found);
      return found;
    }
    const entered = await vscode.window.showInputBox({
      title: "Che Remote SSH",
      prompt: "The Kubernetes API server; nothing answered as one near the Che host",
      placeHolder: "https://api.example.dev:6443",
      ignoreFocusOut: true,
    });
    if (!entered) throw new SignInCancelled();
    const server = normalizeUrl(entered);
    await update("apiServer", server);
    return server;
  }

  /** A usable id_token: the one in hand, a refreshed one, or a new sign-in. */
  async token(): Promise<string> {
    if (this.tokens && isFresh(this.tokens)) return this.tokens.idToken;
    const refreshed = await this.tryRefresh();
    if (refreshed) return refreshed.idToken;
    const signedIn = await this.deviceSignIn();
    return signedIn.idToken;
  }

  private async remember(tokens: TokenSet): Promise<void> {
    this.tokens = tokens;
    if (tokens.refreshToken) await this.context.secrets.store(SECRET_REFRESH, tokens.refreshToken);
  }

  private async tryRefresh(): Promise<TokenSet | undefined> {
    const stored = await this.context.secrets.get(SECRET_REFRESH);
    if (!stored) return undefined;
    try {
      const che = await this.che();
      const secret = await this.clientSecret();
      const tokens = await refresh(che.oidc.token_endpoint, stored, che.clientId, secret, { log });
      if (!isFresh(tokens)) return undefined;
      await this.remember(tokens);
      log("credential refreshed without troubling the user");
      return tokens;
    } catch (err) {
      log(
        `refresh failed, a sign-in is needed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /** Sign in with the device grant: no redirect URI has to be registered. */
  async deviceSignIn(): Promise<TokenSet> {
    const che = await this.che();
    const secret = await this.clientSecret();
    const endpoint = che.oidc.device_authorization_endpoint;
    if (!endpoint) {
      throw new Error(
        "This identity provider advertises no device authorization endpoint, which is the " +
          "grant this extension uses to avoid registering a redirect URI.",
      );
    }
    const device = await requestDeviceCode(endpoint, che.clientId, secret, SCOPES, { log });
    maskLiteral(device.deviceCode);
    await vscode.env.clipboard.writeText(device.userCode);
    const open = "Open the sign-in page";
    const choice = await vscode.window.showInformationMessage(
      `Your code is ${device.userCode}, copied to the clipboard. Enter it at ${device.verificationUri}.`,
      open,
    );
    if (choice === open) {
      await vscode.env.openExternal(
        vscode.Uri.parse(device.verificationUriComplete ?? device.verificationUri),
      );
    }
    const tokens = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Waiting for sign-in…",
        cancellable: true,
      },
      (_progress, cancel) => {
        const ac = new AbortController();
        cancel.onCancellationRequested(() => ac.abort());
        return pollForToken(che.oidc.token_endpoint, device, che.clientId, secret, {
          log,
          signal: ac.signal,
        });
      },
    );
    await this.remember(tokens);
    return tokens;
  }

  /**
   * The kubeconfig every kubectl call will be given.
   *
   * Pointed at a file of the user's, it is returned untouched and nothing is
   * signed in to: that file already carries a credential. Otherwise this
   * extension writes its own with a fresh token. The default kubeconfig is
   * never picked up on its own.
   */
  async kubeconfig(): Promise<string> {
    const choice = this.choice;
    if (!choice.owned) return choice.file;
    const token = await this.token();
    const s = this.effective;
    const server = await this.apiServer();
    await writeKubeconfig(this.ownKubeconfigPath, {
      server,
      token,
      ...(s.certificateAuthority ? { certificateAuthority: s.certificateAuthority } : {}),
      insecureSkipTlsVerify: s.insecureSkipTlsVerify,
    });
    return this.ownKubeconfigPath;
  }

  /** Prove the cluster accepts the token, with the cheapest call there is. */
  async verify(): Promise<void> {
    await this.kubeconfig();
    const ctx = this.kubectl();
    await must(this.run, ctx.bin, versionArgs(ctx));
  }

  async signOut(): Promise<void> {
    this.tokens = undefined;
    await this.context.secrets.delete(SECRET_REFRESH);
    await this.context.secrets.delete(SECRET_CLIENT);
  }
}

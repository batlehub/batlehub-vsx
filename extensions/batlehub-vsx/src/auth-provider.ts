// Steps 4 and 5 of the chain, behind the editor's own Accounts menu: an
// AuthenticationProvider named `batlehub`.
//
// The sign-in is the one the CLI ships (RFC 0011 §13, §14.3): the server
// brokers OIDC. The extension opens `/api/v1/auth/oidc/login?state=…` in
// the browser, the server lands the user on its console with the tokens in
// the URL fragment, and the user pastes that URL back. The `state` the
// extension generated is checked against the `oidc_state` echoed in it,
// so a paste from another sign-in is refused. Without an OIDC provider on
// the server, a personal access token is typed in instead.
//
// Refresh tokens rest in SecretStorage, never in the contract file
// (§4.1.1 rule 1). Access tokens are what the file gets.
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { TokenKind } from "./contract";
import { log } from "./log";

export const AUTH_PROVIDER_ID = "batlehub";

interface StoredSession {
  id: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  provider?: string;
  kind: TokenKind;
  account: { id: string; label: string };
}

export interface OidcPaste {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  state?: string;
  provider?: string;
}

/** The CLI's `parse_oidc_paste`, for the same URL the server sends users to. */
export function parseOidcPaste(input: string): OidcPaste | null {
  const t = input.trim();
  if (!t) return null;
  if (!t.includes("oidc_access_token=")) return { accessToken: t };
  const q = t.slice(t.search(/[?#]/) + 1).replace(/^[?#]/, "");
  const p = new URLSearchParams(q.replace(/^.*?(?=oidc_)/, ""));
  const access = p.get("oidc_access_token");
  if (!access) return null;
  const out: OidcPaste = { accessToken: access };
  const r = p.get("oidc_refresh_token");
  if (r) out.refreshToken = r;
  const e = p.get("oidc_expires_in");
  if (e && /^\d+$/.test(e)) out.expiresIn = Number(e);
  const s = p.get("oidc_state");
  if (s) out.state = s;
  const pr = p.get("oidc_provider");
  if (pr) out.provider = pr;
  return out;
}

export class BatleHubAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly emitter =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.emitter.event;
  private readonly registration: vscode.Disposable;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly originOf: () => string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.registration = vscode.authentication.registerAuthenticationProvider(
      AUTH_PROVIDER_ID,
      "BatleHub",
      this,
      {
        supportsMultipleAccounts: false,
      },
    );
  }

  dispose(): void {
    this.registration.dispose();
    this.emitter.dispose();
  }

  private key(): string | null {
    const o = this.originOf();
    return o ? `batlehub.session.${o}` : null;
  }

  private async load(): Promise<StoredSession | null> {
    const k = this.key();
    if (!k) return null;
    const raw = await this.secrets.get(k);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  }

  private async store(s: StoredSession | null): Promise<void> {
    const k = this.key();
    if (!k) return;
    if (s) await this.secrets.store(k, JSON.stringify(s));
    else await this.secrets.delete(k);
  }

  private toSession(s: StoredSession): vscode.AuthenticationSession {
    return { id: s.id, accessToken: s.accessToken, account: s.account, scopes: [] };
  }

  async getSessions(): Promise<vscode.AuthenticationSession[]> {
    const s = await this.load();
    return s ? [this.toSession(s)] : [];
  }

  /** The stored session with its expiry, for the broker. */
  async current(): Promise<{
    token: string;
    kind: TokenKind;
    expiresAt: Date | null;
    canRefresh: boolean;
  } | null> {
    const s = await this.load();
    if (!s) return null;
    return {
      token: s.accessToken,
      kind: s.kind,
      expiresAt: s.expiresAt ? new Date(s.expiresAt) : null,
      canRefresh: !!s.refreshToken,
    };
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    const origin = this.originOf();
    if (!origin) throw new Error("Set batlehub.registry before signing in.");
    const providers = await this.oidcProviders(origin);
    const stored =
      providers.length > 0
        ? await this.signInOidc(origin, providers)
        : await this.signInPat(origin);
    if (!stored) throw new Error("Sign-in cancelled.");
    await this.store(stored);
    const session = this.toSession(stored);
    this.emitter.fire({ added: [session], removed: [], changed: [] });
    return session;
  }

  async removeSession(): Promise<void> {
    const s = await this.load();
    await this.store(null);
    if (s) this.emitter.fire({ added: [], removed: [this.toSession(s)], changed: [] });
  }

  /**
   * Redeem the stored refresh token at the server. Null when there is none
   * or the server refuses; the session is then dropped, which is what
   * "expired, unrefreshable" means for a consumer (§4.2).
   */
  async refresh(): Promise<{ token: string; kind: TokenKind; expiresAt: Date | null } | null> {
    const origin = this.originOf();
    const s = await this.load();
    if (!origin || !s?.refreshToken) return null;
    try {
      const res = await this.fetchImpl(`${origin}/api/v1/auth/oidc/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ refresh_token: s.refreshToken, provider: s.provider ?? null }),
      });
      if (!res.ok) {
        log(`refresh refused by the server: ${res.status}`);
        if (res.status === 400 || res.status === 401) await this.removeSession();
        return null;
      }
      const d = (await res.json()) as {
        access_token?: string;
        expires_in?: number | null;
        refresh_token?: string | null;
      };
      if (!d.access_token) return null;
      const next: StoredSession = {
        ...s,
        accessToken: d.access_token,
        refreshToken: d.refresh_token ?? s.refreshToken,
        expiresAt: typeof d.expires_in === "number" ? Date.now() + d.expires_in * 1000 : undefined,
      };
      await this.store(next);
      this.emitter.fire({ added: [], removed: [], changed: [this.toSession(next)] });
      return {
        token: next.accessToken,
        kind: next.kind,
        expiresAt: next.expiresAt ? new Date(next.expiresAt) : null,
      };
    } catch (e) {
      log(`refresh failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async oidcProviders(origin: string): Promise<string[]> {
    try {
      const res = await this.fetchImpl(`${origin}/api/v1/auth/oidc/providers`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return [];
      const arr = (await res.json()) as { name?: string }[];
      return Array.isArray(arr)
        ? arr.map((p) => p.name).filter((n): n is string => typeof n === "string")
        : [];
    } catch (e) {
      log(`listing OIDC providers at ${origin}: ${(e as Error).message}`);
      return [];
    }
  }

  private async signInOidc(origin: string, providers: string[]): Promise<StoredSession | null> {
    let provider = providers[0]!;
    if (providers.length > 1) {
      const pick = await vscode.window.showQuickPick(providers, {
        title: "BatleHub: sign in with",
        ignoreFocusOut: true,
      });
      if (!pick) return null;
      provider = pick;
    }
    const state = crypto.randomUUID();
    const url = new URL(`${origin}/api/v1/auth/oidc/login`);
    url.searchParams.set("state", state);
    url.searchParams.set("provider", provider);
    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
    const pasted = await vscode.window.showInputBox({
      title: "BatleHub: paste the URL you landed on",
      prompt:
        "After signing in, the browser lands on a page whose address contains oidc_access_token=… — paste that whole address here.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (parseOidcPaste(v) ? null : "That is not a sign-in URL or a token."),
    });
    if (!pasted) return null;
    const p = parseOidcPaste(pasted);
    if (!p) return null;
    if (p.state && p.state !== state) {
      void vscode.window.showErrorMessage(
        "BatleHub: that URL is from a different sign-in than the one just started. Run Sign in again.",
      );
      return null;
    }
    if (!p.state)
      log("a bare token was pasted; the sign-in could not be matched to the one started");
    const account = await this.whoami(origin, p.accessToken);
    return {
      id: crypto.randomUUID(),
      accessToken: p.accessToken,
      refreshToken: p.refreshToken,
      expiresAt: p.expiresIn ? Date.now() + p.expiresIn * 1000 : undefined,
      provider: p.provider ?? provider,
      kind: "oidc",
      account,
    };
  }

  private async signInPat(origin: string): Promise<StoredSession | null> {
    const token = await vscode.window.showInputBox({
      title: "BatleHub: personal access token",
      prompt: `${origin} has no OIDC provider. Paste a personal access token (batlehub-cli auth token create, or the console's Tokens page).`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length > 0 ? null : "A token is needed."),
    });
    if (!token) return null;
    const account = await this.whoami(origin, token.trim());
    return { id: crypto.randomUUID(), accessToken: token.trim(), kind: "pat", account };
  }

  private async whoami(origin: string, token: string): Promise<{ id: string; label: string }> {
    try {
      const res = await this.fetchImpl(`${origin}/api/v1/me`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (res.ok) {
        const d = (await res.json()) as { user_id?: string; role?: string };
        if (d.user_id)
          return { id: d.user_id, label: `${d.user_id}${d.role ? ` (${d.role})` : ""}` };
      } else {
        log(`/api/v1/me answered ${res.status} for the new credential`);
      }
    } catch (e) {
      log(`/api/v1/me: ${(e as Error).message}`);
    }
    return { id: origin, label: origin };
  }
}

// The extension credential chain of RFC 0011 §4.2, first hit wins:
//
//   1. the contract file, if it holds a still-valid entry — or an expired
//      one this extension owns and can refresh itself;
//   2. `BATLEHUB_TOKEN` in the environment (CI, injected secrets);
//   3. the BatleHub CLI on PATH: `batlehub-cli auth token --output json`;
//   4. interactive sign-in through the registered AuthenticationProvider
//      (server-brokered OIDC), the access token written back to the file;
//   5. a personal access token typed in, written to the file.
//
// Steps 4 and 5 are one injected callback: they need the editor, this
// module does not, so the order and the write-backs can be tested alone.
import {
  CONTRACT_OWNER,
  ContractEntry,
  TokenKind,
  entryState,
  expiresAt,
  readContract,
  resolveToken,
  writeContractEntry,
} from "./contract";
import { CliToken } from "./cli";

export type CredentialSource = "contract" | "env" | "cli" | "interactive";

export interface Credential {
  token: string;
  kind: TokenKind;
  expiresAt: Date | null;
  source: CredentialSource;
  /** For a contract entry: who refreshes it. */
  refreshOwner?: string;
}

export interface InteractiveResult {
  token: string;
  kind: TokenKind;
  expiresAt?: Date | null;
}

export interface ChainDeps {
  origin: string;
  contractPath: string;
  env: NodeJS.ProcessEnv;
  /** Step 3; null when there is no CLI or it has no credential. */
  cli: (origin: string) => Promise<CliToken | null>;
  /** Steps 4–5; null when the user cancelled. */
  interactive?: () => Promise<InteractiveResult | null>;
  /**
   * Step 1's second half: refresh an expired entry this extension owns.
   * Returns the fresh credential, or null when the refresh material is gone.
   */
  refreshOwn?: () => Promise<InteractiveResult | null>;
  /** How much life a token must have left to count as valid. */
  minTtlMs: number;
  log: (message: string) => void;
  now?: () => number;
}

export interface ResolveOptions {
  /** Allow steps 4–5. Off for anything automatic (a broker tick, a request). */
  interactive: boolean;
}

export class CredentialChain {
  private warned = new Set<string>();

  constructor(private readonly deps: ChainDeps) {}

  private warnOnce(reason: string): void {
    if (this.warned.has(reason)) return;
    this.warned.add(reason);
    this.deps.log(`contract file: ${reason}`);
  }

  /** The entry for this registry's origin, whatever its state. */
  entry(): { entry: ContractEntry | undefined; error?: string } {
    const r = readContract(this.deps.contractPath);
    if (r.error) this.warnOnce(r.error);
    return { entry: r.file?.registries[this.deps.origin], error: r.error };
  }

  async resolve(opts: ResolveOptions): Promise<Credential | null> {
    const now = this.deps.now?.() ?? Date.now();

    // 1. The contract file.
    const { entry } = this.entry();
    const state = entryState(entry, now, this.deps.minTtlMs);
    if (entry && state === "ok") {
      const token = resolveToken(entry.token, (r) => this.warnOnce(r));
      if (token)
        return {
          token,
          kind: entry.kind,
          expiresAt: expiresAt(entry),
          source: "contract",
          refreshOwner: entry.refresh?.owner,
        };
    }
    if (
      entry &&
      state === "expired" &&
      entry.refresh?.owner === CONTRACT_OWNER &&
      this.deps.refreshOwn
    ) {
      const fresh = await this.deps.refreshOwn();
      if (fresh) {
        this.write(fresh, "oidc-own");
        return {
          token: fresh.token,
          kind: fresh.kind,
          expiresAt: fresh.expiresAt ?? null,
          source: "contract",
          refreshOwner: CONTRACT_OWNER,
        };
      }
    }

    // 2. The environment.
    const env = this.deps.env.BATLEHUB_TOKEN?.trim();
    if (env && env.length > 0)
      return { token: env, kind: kindOf(undefined, env), expiresAt: null, source: "env" };

    // 3. The CLI. Its credential is written to the file under its own
    //    ownership: the CLI's profile store holds the refresh material.
    const cli = await this.deps.cli(this.deps.origin);
    if (cli) {
      const exp = cli.expires_at ? new Date(cli.expires_at) : null;
      const kind = kindOf(cli.kind, cli.token);
      const fromCli: InteractiveResult = { token: cli.token, kind, expiresAt: exp };
      this.write(fromCli, "cli");
      return {
        token: cli.token,
        kind,
        expiresAt: exp,
        source: "cli",
        refreshOwner: "batlehub-cli",
      };
    }

    // 4–5. The user.
    if (opts.interactive && this.deps.interactive) {
      const got = await this.deps.interactive();
      if (got) {
        this.write(got, got.kind === "pat" ? "pat" : "oidc-own");
        return {
          token: got.token,
          kind: got.kind,
          expiresAt: got.expiresAt ?? null,
          source: "interactive",
          refreshOwner: got.kind === "pat" ? undefined : CONTRACT_OWNER,
        };
      }
    }
    return null;
  }

  /** Write a credential into the file, for the consumers that only read it. */
  write(cred: InteractiveResult, how: "cli" | "oidc-own" | "pat"): void {
    const entry: ContractEntry = { token: cred.token, kind: cred.kind };
    if (cred.expiresAt) entry.expires_at = cred.expiresAt.toISOString();
    switch (how) {
      case "cli":
        entry.refresh = { source: "cli", owner: "batlehub-cli" };
        break;
      case "oidc-own":
        // The refresh token lives in the editor's SecretStorage (§4.1.1 rule
        // 1: a writer with a secret store never writes an inline block), so
        // the file says what a consumer can do about expiry: nothing but
        // wait for the owner, which is us, to rewrite it — `source: "cli"`
        // is the schema's word for "the material is in the owner's store".
        entry.refresh = { source: "cli", owner: CONTRACT_OWNER };
        break;
      case "pat":
        entry.refresh = { source: "none" };
        break;
    }
    try {
      writeContractEntry(this.deps.contractPath, this.deps.origin, entry);
    } catch (e) {
      this.deps.log(`could not write ${this.deps.contractPath}: ${(e as Error).message}`);
    }
  }
}

export function kindOf(kind: string | undefined, token: string): TokenKind {
  if (kind === "pat" || kind === "kubernetes" || kind === "oidc") return kind;
  return token.startsWith("bh_pat_") ? "pat" : "oidc";
}

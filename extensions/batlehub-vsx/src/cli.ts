// Step 3 of the credential chain (RFC 0011 §4.2): the BatleHub CLI, when
// it is on PATH. `batlehub-cli auth token --output json` is the one command
// whose job is to emit a credential, refreshing it first when it is close to
// expiry; a non-zero exit means "no credential" and never an error here.
import { execFile } from "node:child_process";

export interface CliToken {
  token: string;
  kind: string;
  expires_at?: string;
  registry?: string;
}

export interface CliRunner {
  (
    file: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export const defaultRunner: CliRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err
          ? ((err as NodeJS.ErrnoException & { code?: number | string }).code as number | string)
          : 0;
        resolve({
          code: typeof code === "number" ? code : code === "ENOENT" ? -2 : 1,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });

/**
 * Ask the CLI for a credential for `server` (an origin). `null` when the CLI
 * is absent, refuses, or prints something that is not the documented JSON.
 */
export async function cliToken(
  cliPath: string,
  server: string,
  opts: {
    minTtlSeconds?: number;
    timeoutMs?: number;
    run?: CliRunner;
    log?: (m: string) => void;
  } = {},
): Promise<CliToken | null> {
  const run = opts.run ?? defaultRunner;
  const args = ["--server", server, "auth", "token", "--output", "json"];
  if (opts.minTtlSeconds !== undefined) args.push("--min-ttl", String(opts.minTtlSeconds));
  const r = await run(cliPath, args, opts.timeoutMs ?? 20_000);
  if (r.code === -2) {
    opts.log?.(`${cliPath}: not found on PATH`);
    return null;
  }
  if (r.code !== 0) {
    opts.log?.(`${cliPath} auth token exited ${r.code}: ${r.stderr.trim().split("\n")[0] ?? ""}`);
    return null;
  }
  return parseCliToken(r.stdout, opts.log);
}

export function parseCliToken(stdout: string, log?: (m: string) => void): CliToken | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout.trim());
  } catch {
    log?.("auth token --output json printed something that is not JSON");
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const d = doc as Record<string, unknown>;
  if (typeof d.token !== "string" || d.token.length === 0) return null;
  const out: CliToken = { token: d.token, kind: typeof d.kind === "string" ? d.kind : "oidc" };
  if (typeof d.expires_at === "string") out.expires_at = d.expires_at;
  if (typeof d.registry === "string") out.registry = d.registry;
  return out;
}

/** `batlehub-cli auth write-token-file`: the CLI keeps its own entry fresh. */
export async function cliWriteTokenFile(
  cliPath: string,
  server: string,
  opts: {
    contractPath?: string;
    timeoutMs?: number;
    run?: CliRunner;
    log?: (m: string) => void;
  } = {},
): Promise<boolean> {
  const run = opts.run ?? defaultRunner;
  const args = ["--server", server, "auth", "write-token-file"];
  if (opts.contractPath) args.push("--path", opts.contractPath);
  const r = await run(cliPath, args, opts.timeoutMs ?? 20_000);
  if (r.code !== 0)
    opts.log?.(
      `${cliPath} auth write-token-file exited ${r.code}: ${r.stderr.trim().split("\n")[0] ?? ""}`,
    );
  return r.code === 0;
}

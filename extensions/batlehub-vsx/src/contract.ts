// The credential contract file — RFC 0011 §4.1, normative schema
// `cli/schema/vsx-token.schema.json` in the BatleHub repository.
//
// One file, `$BATLEHUB_HOME/state/vsx-token.json`, keyed by registry origin.
// A consumer matches the configured gallery origin against a key, resolves
// that entry's `token`, and puts the result in an Authorization header. This
// module is that consumer and — for the entries this extension owns — the
// writer. It imports nothing from `vscode` so the rules can be tested alone.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CONTRACT_VERSION = 1;
export const CONTRACT_OWNER = "batlehub-vsx";
export const CONTRACT_FILE = "vsx-token.json";
/** A `file` token source is read at most this far — the schema's cap. */
export const FILE_SOURCE_CAP = 64 * 1024;

export type TokenKind = "oidc" | "pat" | "kubernetes";
export type RefreshSource = "cli" | "reresolve" | "inline" | "none";

export interface InlineSource {
  from: "inline";
  value: string;
}
export interface FileSource {
  from: "file";
  path: string;
  format?: "raw" | "json";
  pointer?: string;
}
/** `env`, `exchange`, `keychain` — named by the schema, read as "no credential" here. */
export interface ReservedSource {
  from: string;
  [key: string]: unknown;
}
export type TokenSource = string | InlineSource | FileSource | ReservedSource;

export interface RefreshBlock {
  source: RefreshSource;
  owner?: string;
  [key: string]: unknown;
}

export interface ContractEntry {
  token: TokenSource;
  kind: TokenKind;
  expires_at?: string;
  refresh?: RefreshBlock;
  [key: string]: unknown;
}

export interface ContractFile {
  version: number;
  registries: Record<string, ContractEntry>;
  [key: string]: unknown;
}

export type EntryState = "ok" | "expired" | "unset" | "invalid";

/** `$BATLEHUB_HOME/state/vsx-token.json`, `BATLEHUB_HOME` defaulting to `~/.batlehub`. */
export function defaultContractPath(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  const base =
    env.BATLEHUB_HOME && env.BATLEHUB_HOME.trim() !== ""
      ? env.BATLEHUB_HOME
      : path.join(home, ".batlehub");
  return path.join(base, "state", CONTRACT_FILE);
}

/** The origin of a URL without a trailing slash — the key of `registries`. */
export function originOf(url: string): string {
  return new URL(url).origin;
}

export interface ReadResult {
  file: ContractFile | null;
  /** Why `file` is null when it is: absent is not an error, unparseable is. */
  error?: string;
  exists: boolean;
}

/**
 * Read the file. An unparseable or structurally wrong file is "no credential"
 * (§4.3: it must never break extension installs for anonymous galleries), and
 * the reason is returned so it can be logged once.
 */
export function readContract(file: string): ReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { file: null, exists: false };
    return { file: null, exists: true, error: `reading ${file}: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { file: null, exists: true, error: `${file} is not JSON: ${(e as Error).message}` };
  }
  const problem = validateContract(parsed);
  if (problem) return { file: null, exists: true, error: `${file}: ${problem}` };
  return { file: parsed as ContractFile, exists: true };
}

/** The structural checks of the schema; `null` when the document passes. */
export function validateContract(doc: unknown): string | null {
  if (!isRecord(doc)) return "not an object";
  if (doc.version !== CONTRACT_VERSION)
    return `version must be ${CONTRACT_VERSION}, got ${JSON.stringify(doc.version)}`;
  if (!isRecord(doc.registries)) return "registries must be an object";
  for (const [origin, entry] of Object.entries(doc.registries)) {
    const p = validateEntry(entry);
    if (p) return `registries[${JSON.stringify(origin)}]: ${p}`;
    try {
      const u = new URL(origin);
      if (u.origin !== origin)
        return `registries key ${JSON.stringify(origin)} is not a bare origin`;
    } catch {
      return `registries key ${JSON.stringify(origin)} is not a URL`;
    }
  }
  return null;
}

export function validateEntry(entry: unknown): string | null {
  if (!isRecord(entry)) return "not an object";
  if (!["oidc", "pat", "kubernetes"].includes(entry.kind as string))
    return `kind must be oidc, pat or kubernetes`;
  const t = entry.token;
  if (typeof t === "string") {
    if (t.length === 0) return "token must not be empty";
  } else if (isRecord(t)) {
    if (typeof t.from !== "string") return "token.from must be a string";
    if (t.from === "inline" && (typeof t.value !== "string" || t.value.length === 0))
      return "inline token needs a value";
    if (t.from === "file") {
      if (typeof t.path !== "string" || !t.path.startsWith("/"))
        return "file token needs an absolute path";
      if (t.format !== undefined && t.format !== "raw" && t.format !== "json")
        return "file token format must be raw or json";
    }
  } else {
    return "token must be a string or a source object";
  }
  if (entry.expires_at !== undefined) {
    if (typeof entry.expires_at !== "string" || Number.isNaN(Date.parse(entry.expires_at)))
      return "expires_at must be RFC 3339";
  }
  if (entry.refresh !== undefined) {
    if (!isRecord(entry.refresh)) return "refresh must be an object";
    if (!["cli", "reresolve", "inline", "none"].includes(entry.refresh.source as string))
      return "refresh.source must be cli, reresolve, inline or none";
    if (
      entry.refresh.source === "reresolve" &&
      (typeof t === "string" || (isRecord(t) && t.from === "inline"))
    )
      return "refresh.source reresolve on an inline token would never refresh";
  }
  return null;
}

/**
 * Resolve a token source to the credential, or `null` for "no credential".
 * A failure to resolve is never an error (§4.1.2 rule 3); `warn` is told why,
 * once per distinct reason by the caller's choosing.
 */
export function resolveToken(
  source: TokenSource,
  warn: (reason: string) => void = () => {},
): string | null {
  if (typeof source === "string") return source.length > 0 ? source : null;
  if (!isRecord(source)) return null;
  switch (source.from) {
    case "inline": {
      const v = (source as unknown as InlineSource).value;
      return typeof v === "string" && v.length > 0 ? v : null;
    }
    case "file":
      return resolveFileSource(source as unknown as FileSource, warn);
    case "env":
    case "exchange":
    case "keychain":
      warn(
        `token source "${source.from}" is reserved and not implemented here — reading it as no credential`,
      );
      return null;
    default:
      warn(`unknown token source "${String(source.from)}" — reading it as no credential`);
      return null;
  }
}

function resolveFileSource(source: FileSource, warn: (reason: string) => void): string | null {
  if (typeof source.path !== "string" || !path.isAbsolute(source.path)) {
    warn(`file token source path ${JSON.stringify(source.path)} is not absolute`);
    return null;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(source.path);
  } catch (e) {
    warn(`reading ${source.path}: ${(e as Error).message}`);
    return null;
  }
  if (!stat.isFile()) {
    warn(`${source.path} is not a regular file`);
    return null;
  }
  if (stat.mode & 0o044)
    warn(
      `${source.path} is group- or world-readable (mode ${(stat.mode & 0o777).toString(8)}) — it is a credential now`,
    );
  let text: string;
  try {
    const fd = fs.openSync(source.path, "r");
    try {
      const buf = Buffer.alloc(FILE_SOURCE_CAP);
      const n = fs.readSync(fd, buf, 0, FILE_SOURCE_CAP, 0);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    warn(`reading ${source.path}: ${(e as Error).message}`);
    return null;
  }
  if ((source.format ?? "raw") === "raw") {
    const v = text.trim();
    return v.length > 0 ? v : null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    warn(`${source.path} is not JSON: ${(e as Error).message}`);
    return null;
  }
  const v = jsonPointer(doc, source.pointer ?? "/token");
  if (typeof v !== "string" || v.length === 0) {
    warn(`${source.path}: nothing at ${source.pointer ?? "/token"}`);
    return null;
  }
  return v;
}

/** RFC 6901, enough of it for a credential file. */
export function jsonPointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) return undefined;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (isRecord(cur)) cur = cur[key];
    else return undefined;
  }
  return cur;
}

export function expiresAt(entry: ContractEntry): Date | null {
  if (!entry.expires_at) return null;
  const t = Date.parse(entry.expires_at);
  return Number.isNaN(t) ? null : new Date(t);
}

/**
 * What the entry is worth right now. `minTtlMs` is the freshness a caller
 * needs: a token about to expire is `expired` to a broker that could refresh
 * it, and `ok` to a consumer that just wants a header.
 */
export function entryState(
  entry: ContractEntry | undefined,
  now = Date.now(),
  minTtlMs = 0,
): EntryState {
  if (!entry) return "unset";
  if (validateEntry(entry)) return "invalid";
  const exp = expiresAt(entry);
  if (exp && exp.getTime() - now <= minTtlMs) return "expired";
  return "ok";
}

/**
 * Read-modify-write of one registry's entry: every other entry and every
 * unknown field survive (§4.1 "consumers preserve fields they do not know"),
 * the write is a temp file plus rename, `0600`, parent directories `0700`.
 */
export function writeContractEntry(file: string, origin: string, entry: ContractEntry): void {
  const problem = validateEntry(entry);
  if (problem) throw new Error(`refusing to write an invalid contract entry: ${problem}`);
  updateContract(file, (doc) => {
    doc.registries[origin] = entry;
  });
}

export function removeContractEntry(file: string, origin: string): boolean {
  let removed = false;
  updateContract(file, (doc) => {
    removed = origin in doc.registries;
    delete doc.registries[origin];
  });
  return removed;
}

function updateContract(file: string, mutate: (doc: ContractFile) => void): void {
  const current = readContract(file);
  // An unparseable file is replaced, not merged: there is nothing to preserve
  // in it and leaving it means every consumer keeps reading "no credential".
  const doc: ContractFile = current.file ?? { version: CONTRACT_VERSION, registries: {} };
  mutate(doc);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the rename failed; the temp file is the lesser problem */
    }
    throw e;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

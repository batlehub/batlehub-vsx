// The registry as the extension reads it: the Open VSX shape BatleHub
// renders for a `vscode-marketplace` / `openvsx` registry (search, the
// extension document with its `files`), the VSIX and its signature assets
// (RFC 0020), and the verdict of RFC 0018.
//
// Two rules of RFC 0011 §4.2 live here and nowhere else: the Bearer goes
// only to the registry's own origin (a redirect elsewhere is followed bare),
// and a `401` re-resolves the credential once and retries once.
import { originOf } from "./contract";

export interface TokenProvider {
  /** The credential to send now, or null to send none. */
  get(): Promise<string | null>;
  /** After a 401: re-read the sources once. */
  reresolve(): Promise<string | null>;
}

export interface ExtensionSummary {
  namespace: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  url: string;
  timestamp?: string;
  downloadCount?: number;
  files: { download: string; icon?: string };
}

export interface ExtensionDoc extends ExtensionSummary {
  files: {
    download: string;
    icon?: string;
    signature?: string;
    publicKey?: string;
    readme?: string;
  };
  engines?: Record<string, string>;
  allVersions?: Record<string, string>;
  dependencies?: { namespace: string; extension: string }[];
  bundledExtensions?: { namespace: string; extension: string }[];
}

export interface SearchResult {
  total: number;
  extensions: ExtensionSummary[];
}

export type VerdictState = "allowed" | "warned" | "quarantined" | "denied" | string;

export interface VerdictResponse {
  verdict: VerdictState | { state?: string; [k: string]: unknown };
  findings_withheld?: boolean;
  [k: string]: unknown;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  fetch?: typeof fetch;
  userAgent?: string;
}

/** The id of an extension: `publisher.name`, the marketplace convention. */
export function extensionId(namespace: string, name: string): string {
  return `${namespace}.${name}`;
}

export function splitId(id: string): { namespace: string; name: string } | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(id.trim());
  return m ? { namespace: m[1]!, name: m[2]! } : null;
}

export class BatleHubClient {
  readonly registry: string;
  readonly origin: string;
  readonly registryName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(
    registry: string,
    private readonly tokens: TokenProvider,
    opts: ClientOptions = {},
  ) {
    this.registry = registry.replace(/\/+$/, "");
    this.origin = originOf(this.registry);
    const m = /\/proxy\/([^/]+)$/.exec(this.registry);
    this.registryName = m ? decodeURIComponent(m[1]!) : "";
    this.fetchImpl = opts.fetch ?? fetch;
    this.userAgent = opts.userAgent ?? "batlehub-vsx";
  }

  async search(
    query: string,
    opts: { size?: number; offset?: number } = {},
  ): Promise<SearchResult> {
    const u = new URL(`${this.registry}/api/-/search`);
    if (query) u.searchParams.set("query", query);
    u.searchParams.set("size", String(opts.size ?? 50));
    u.searchParams.set("offset", String(opts.offset ?? 0));
    const doc = (await this.json(u.toString())) as { totalSize?: number; extensions?: unknown[] };
    const extensions = (doc.extensions ?? [])
      .map(summaryOf)
      .filter((e): e is ExtensionSummary => e !== null);
    return {
      total: typeof doc.totalSize === "number" ? doc.totalSize : extensions.length,
      extensions,
    };
  }

  async extension(namespace: string, name: string, version?: string): Promise<ExtensionDoc | null> {
    const url = `${this.registry}/api/${enc(namespace)}/${enc(name)}${version ? `/${enc(version)}` : ""}`;
    const res = await this.request(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return null;
    await ensureOk(res, url);
    return docOf((await res.json()) as Record<string, unknown>);
  }

  /** The readme the gallery renders: the `Content.Details` asset, or null. */
  async readme(namespace: string, name: string, version: string): Promise<string | null> {
    const url = `${this.registry}/vscode/asset/${enc(namespace)}/${enc(name)}/${enc(version)}/Microsoft.VisualStudio.Services.Content.Details`;
    const res = await this.request(url, {});
    if (res.status === 404) return null;
    await ensureOk(res, url);
    return res.text();
  }

  async bytes(url: string): Promise<Uint8Array> {
    const res = await this.request(url, {});
    await ensureOk(res, url);
    return new Uint8Array(await res.arrayBuffer());
  }

  async text(url: string): Promise<string> {
    const res = await this.request(url, {});
    await ensureOk(res, url);
    return res.text();
  }

  /** RFC 0018's verdict for a version; null when the server has none or no scanner. */
  async verdict(namespace: string, name: string, version: string): Promise<VerdictResponse | null> {
    if (!this.registryName) return null;
    const url = `${this.origin}/api/v1/verdicts/${enc(this.registryName)}/${enc(extensionId(namespace, name))}/${enc(version)}`;
    const res = await this.request(url, { headers: { accept: "application/json" } });
    if (res.status === 404 || res.status === 501 || res.status === 503) return null;
    await ensureOk(res, url);
    return (await res.json()) as VerdictResponse;
  }

  private async json(url: string): Promise<unknown> {
    const res = await this.request(url, { headers: { accept: "application/json" } });
    await ensureOk(res, url);
    return res.json();
  }

  /**
   * One request with the two rules: header scoping to the registry origin,
   * and one re-resolve plus one retry on 401.
   */
  async request(url: string, init: RequestInit, retried = false): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    headers.set("user-agent", this.userAgent);
    const sameOrigin = originOf(url) === this.origin;
    if (sameOrigin) {
      const token = retried ? await this.tokens.reresolve() : await this.tokens.get();
      if (token) headers.set("authorization", `Bearer ${token}`);
    }
    // Redirects are followed by hand so a hop to a foreign origin drops the header.
    const res = await this.fetchImpl(url, { ...init, headers, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (loc) {
        const next = new URL(loc, url).toString();
        return this.request(next, init, retried);
      }
    }
    if (res.status === 401 && sameOrigin && !retried) return this.request(url, init, true);
    return res;
  }
}

async function ensureOk(res: Response, url: string): Promise<void> {
  if (res.ok) return;
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 200);
  } catch {
    /* the status is the message */
  }
  throw new RegistryError(
    `${res.status} ${res.statusText || ""} from ${url}${detail ? `: ${detail}` : ""}`.trim(),
    res.status,
    url,
  );
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function summaryOf(v: unknown): ExtensionSummary | null {
  if (typeof v !== "object" || v === null) return null;
  const d = v as Record<string, unknown>;
  const files = (d.files ?? {}) as Record<string, unknown>;
  if (
    typeof d.namespace !== "string" ||
    typeof d.name !== "string" ||
    typeof d.version !== "string"
  )
    return null;
  if (typeof files.download !== "string") return null;
  return {
    namespace: d.namespace,
    name: d.name,
    version: d.version,
    displayName: typeof d.displayName === "string" && d.displayName ? d.displayName : d.name,
    description: typeof d.description === "string" ? d.description : "",
    url: typeof d.url === "string" ? d.url : "",
    timestamp: typeof d.timestamp === "string" ? d.timestamp : undefined,
    downloadCount: typeof d.downloadCount === "number" ? d.downloadCount : undefined,
    files: {
      download: files.download,
      icon: typeof files.icon === "string" ? files.icon : undefined,
    },
  };
}

function docOf(d: Record<string, unknown>): ExtensionDoc | null {
  const s = summaryOf(d);
  if (!s) return null;
  const files = (d.files ?? {}) as Record<string, unknown>;
  const refs = (k: string) =>
    Array.isArray(d[k])
      ? (d[k] as unknown[])
          .filter((x): x is Record<string, string> => typeof x === "object" && x !== null)
          .map((x) => ({
            namespace: String(x.namespace ?? ""),
            extension: String(x.extension ?? ""),
          }))
          .filter((x) => x.namespace && x.extension)
      : undefined;
  return {
    ...s,
    files: {
      ...s.files,
      signature: typeof files.signature === "string" ? files.signature : undefined,
      publicKey: typeof files.publicKey === "string" ? files.publicKey : undefined,
      readme: typeof files.readme === "string" ? files.readme : undefined,
    },
    engines:
      typeof d.engines === "object" && d.engines !== null
        ? (d.engines as Record<string, string>)
        : undefined,
    allVersions:
      typeof d.allVersions === "object" && d.allVersions !== null
        ? (d.allVersions as Record<string, string>)
        : undefined,
    dependencies: refs("dependencies"),
    bundledExtensions: refs("bundledExtensions"),
  };
}

/** The state word of a verdict document, whatever nesting the server used. */
export function verdictState(v: VerdictResponse | null): VerdictState | null {
  if (!v) return null;
  const raw = v.verdict;
  if (typeof raw === "string") return raw.toLowerCase();
  if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>;
    const s = r.state ?? r.verdict ?? r.status;
    if (typeof s === "string") return s.toLowerCase();
    const keys = Object.keys(r);
    if (keys.length === 1) return keys[0]!.toLowerCase();
  }
  return null;
}

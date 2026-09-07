// Everything this extension needs about a Che instance, discovered from its
// URL alone. Two probes, both unauthenticated:
//
//   1. `GET <che>/oauth/start` is answered by the oauth proxy in front of
//      Che with a 302 to its identity provider. That redirect carries the
//      `client_id` the cluster's apiserver is configured to trust, and its
//      host is the provider. Red Hat's own extension reads this same
//      redirect, but only accepts an `oauth-openshift.apps.` host and then
//      derives `api.<domain>:6443` from it, which is why it cannot see a
//      Che that runs on plain Kubernetes behind any other provider.
//   2. The apiserver is recognised by what it answers to an anonymous
//      request: a Kubernetes `Status` object, never HTML. That fingerprint
//      is what makes probing a guessed host safe.
//
// No module here imports `vscode`: the rules are testable as plain Node.

/** The discovery endpoints, as far as this extension reads them. */
export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  grant_types_supported?: string[];
  scopes_supported?: string[];
}

export interface CheEndpoints {
  /** The Che instance, without a trailing slash. */
  cheUrl: string;
  /** The OIDC client id the apiserver trusts, read from the redirect. */
  clientId: string;
  /** The provider's discovery document. */
  oidc: OidcMetadata;
}

export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

export interface ProbeOptions {
  fetch?: typeof fetch;
  log?: (m: string) => void;
}

/** Trim a trailing slash so joins never produce a double one. */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The identity provider behind a Che instance: the client id it authenticates
 * with, and where its authorize endpoint lives. `null` when `/oauth/start`
 * does not redirect, which is the case when Che is not fronted by an oauth
 * proxy at all.
 */
export async function probeOauthStart(
  cheUrl: string,
  opts: ProbeOptions = {},
): Promise<{ clientId: string; authorizeEndpoint: string } | null> {
  const f = opts.fetch ?? fetch;
  const url = `${normalizeUrl(cheUrl)}/oauth/start`;
  const res = await f(url, { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) {
    opts.log?.(`${url}: no redirect, status ${res.status}`);
    return null;
  }
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    throw new DiscoveryError(`redirect to a URL that cannot be parsed: ${location}`, url);
  }
  const clientId = target.searchParams.get("client_id");
  if (!clientId) {
    throw new DiscoveryError("the redirect carries no client_id", url);
  }
  const authorizeEndpoint = `${target.origin}${target.pathname}`;
  opts.log?.(`${url}: client_id ${clientId}, authorize at ${authorizeEndpoint}`);
  return { clientId, authorizeEndpoint };
}

/**
 * Where a provider's discovery document might sit, given the authorize
 * endpoint it just redirected to. Ordered from most specific to least, and
 * every candidate is checked against the authorize endpoint we observed, so
 * a document belonging to another client or realm is refused rather than
 * silently used.
 */
export function discoveryCandidates(authorizeEndpoint: string, clientId: string): string[] {
  const u = new URL(authorizeEndpoint);
  const out: string[] = [];
  // Authentik: /application/o/authorize/ for every client, the document is
  // per-application at /application/o/<slug>/.well-known/…
  if (u.pathname.startsWith("/application/o/")) {
    out.push(`${u.origin}/application/o/${clientId}/.well-known/openid-configuration`);
  }
  // Keycloak: /realms/<realm>/protocol/openid-connect/auth
  const kc = /^(\/realms\/[^/]+)\/protocol\/openid-connect\/auth$/.exec(u.pathname);
  if (kc) out.push(`${u.origin}${kc[1]!}/.well-known/openid-configuration`);
  // Dex, and anything that serves the document at the root.
  out.push(`${u.origin}/.well-known/openid-configuration`);
  // A provider that namespaces by path: walk up from the authorize endpoint.
  const parts = u.pathname.split("/").filter(Boolean);
  for (let i = parts.length - 1; i > 0; i--) {
    out.push(`${u.origin}/${parts.slice(0, i).join("/")}/.well-known/openid-configuration`);
  }
  return [...new Set(out)];
}

function isMetadata(v: unknown): v is OidcMetadata {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.issuer === "string" &&
    typeof d.authorization_endpoint === "string" &&
    typeof d.token_endpoint === "string"
  );
}

/**
 * Fetch the discovery document for the provider Che redirected to. A
 * candidate is accepted only when its `authorization_endpoint` is the one we
 * were redirected to: that is what ties the document to this Che.
 */
export async function fetchOidcMetadata(
  authorizeEndpoint: string,
  clientId: string,
  opts: ProbeOptions = {},
): Promise<OidcMetadata> {
  const f = opts.fetch ?? fetch;
  const tried: string[] = [];
  for (const candidate of discoveryCandidates(authorizeEndpoint, clientId)) {
    tried.push(candidate);
    let doc: unknown;
    try {
      const res = await f(candidate);
      if (!res.ok) continue;
      doc = await res.json();
    } catch {
      continue;
    }
    if (!isMetadata(doc)) continue;
    if (normalizeUrl(doc.authorization_endpoint) !== normalizeUrl(authorizeEndpoint)) {
      opts.log?.(`${candidate}: authorization_endpoint does not match, skipped`);
      continue;
    }
    opts.log?.(`${candidate}: issuer ${doc.issuer}`);
    return doc;
  }
  throw new DiscoveryError(
    `no OpenID configuration matched the authorize endpoint (tried ${tried.length})`,
    authorizeEndpoint,
  );
}

/** Both probes at once: what a first-run wizard needs before asking anything. */
export async function discoverChe(cheUrl: string, opts: ProbeOptions = {}): Promise<CheEndpoints> {
  const url = normalizeUrl(cheUrl);
  const start = await probeOauthStart(url, opts);
  if (!start) {
    throw new DiscoveryError("this Che does not redirect to an identity provider", url);
  }
  const oidc = await fetchOidcMetadata(start.authorizeEndpoint, start.clientId, opts);
  return { cheUrl: url, clientId: start.clientId, oidc };
}

/**
 * Is `url` a Kubernetes apiserver? Anonymous requests are answered with a
 * `Status` object whether they are refused (401, the usual case) or allowed,
 * and no web server in front of Che answers that way.
 */
export async function isApiServer(url: string, opts: ProbeOptions = {}): Promise<boolean> {
  const f = opts.fetch ?? fetch;
  const probe = `${normalizeUrl(url)}/version`;
  try {
    const res = await f(probe);
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return false;
    const d = body as Record<string, unknown>;
    // Refused: a Status object. Allowed: the version payload.
    const refused = d.kind === "Status" && d.apiVersion === "v1";
    const allowed = typeof d.gitVersion === "string" && typeof d.major === "string";
    opts.log?.(
      `${probe}: ${refused ? "apiserver (anonymous refused)" : allowed ? "apiserver" : "not an apiserver"}`,
    );
    return refused || allowed;
  } catch {
    opts.log?.(`${probe}: unreachable`);
    return false;
  }
}

/**
 * Guess the apiserver from the Che URL. Che is commonly published on the same
 * host as the cluster it runs on, so `https://<che-host>:6443` is worth one
 * probe before asking the user. `null` when nothing answers as an apiserver.
 */
export async function probeApiServer(
  cheUrl: string,
  opts: ProbeOptions = {},
): Promise<string | null> {
  const host = new URL(normalizeUrl(cheUrl)).hostname;
  for (const candidate of [`https://${host}:6443`, `https://api.${host}:6443`]) {
    if (await isApiServer(candidate, opts)) return candidate;
  }
  return null;
}

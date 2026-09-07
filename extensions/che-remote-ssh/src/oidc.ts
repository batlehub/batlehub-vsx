// The device authorization grant (RFC 8628), run by this extension rather
// than delegated to `kubectl oidc-login`.
//
// Two reasons for doing it here. The client Che registers is confidential,
// so a delegated exec plugin would need its secret in the kubeconfig, in
// clear, on disk; running the flow ourselves keeps the secret in the
// editor's SecretStorage and puts only a short-lived id_token in the file.
// And the device grant needs no redirect URI, so nothing has to be declared
// in the provider for this extension to work.
//
// The apiserver wants the id_token, not the access token: it is the one
// carrying the claims the OIDC authenticator is configured to read. Nothing
// here verifies a signature, on purpose. The apiserver is the verifier; the
// expiry is read only to know when to ask for another one.

export interface TokenSet {
  idToken: string;
  refreshToken?: string;
  /** Seconds since the epoch, from the id_token's own `exp` claim. */
  expiresAt: number;
}

export interface DeviceCode {
  deviceCode: string;
  /** Shown to the user, who types it at `verificationUri`. */
  userCode: string;
  verificationUri: string;
  /** The same page with the code already filled in, when the provider offers it. */
  verificationUriComplete?: string;
  /** Seconds between polls, as the provider asks. */
  interval: number;
  expiresAt: number;
}

export class OidcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface OidcOptions {
  fetch?: typeof fetch;
  log?: (m: string) => void;
  /** Injected so a test does not wait. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The `exp` of a JWT, in seconds since the epoch. Throws when the token is
 * not a JWT or carries no numeric `exp`: a token whose life we cannot see is
 * one we cannot refresh in time, so it is refused early rather than at the
 * next apiserver call.
 */
export function expiryOf(jwt: string): number {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new OidcError("the id_token is not a JWT");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new OidcError("the id_token payload is not JSON");
  }
  const exp = (payload as Record<string, unknown> | null)?.exp;
  if (typeof exp !== "number") throw new OidcError("the id_token carries no exp claim");
  return exp;
}

/** Is this token set worth sending, with `skewSeconds` to spare? */
export function isFresh(t: TokenSet, skewSeconds = 60, now = () => Date.now()): boolean {
  return t.expiresAt - skewSeconds > Math.floor(now() / 1000);
}

function form(fields: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) p.set(k, v);
  return p.toString();
}

async function postForm(
  url: string,
  fields: Record<string, string | undefined>,
  opts: OidcOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const f = opts.fetch ?? fetch;
  const res = await f(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form(fields),
  });
  let body: unknown = {};
  try {
    body = await res.json();
  } catch {
    // A provider that answers a non-JSON error still has a status worth reporting.
  }
  return { status: res.status, body: (body ?? {}) as Record<string, unknown> };
}

/** Ask the provider for a device code and the page the user goes to. */
export async function requestDeviceCode(
  deviceEndpoint: string,
  clientId: string,
  clientSecret: string,
  scopes: string[],
  opts: OidcOptions = {},
): Promise<DeviceCode> {
  const now = opts.now ?? Date.now;
  const { status, body } = await postForm(
    deviceEndpoint,
    { client_id: clientId, client_secret: clientSecret, scope: scopes.join(" ") },
    opts,
  );
  if (status >= 400) {
    throw new OidcError(
      `the provider refused the device request: ${String(body.error_description ?? body.error ?? status)}`,
      typeof body.error === "string" ? body.error : undefined,
    );
  }
  const deviceCode = body.device_code;
  const userCode = body.user_code;
  const verificationUri = body.verification_uri ?? body.verification_url;
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string"
  ) {
    throw new OidcError(
      "the device response is missing device_code, user_code or verification_uri",
    );
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 600;
  const interval = typeof body.interval === "number" ? body.interval : 5;
  const complete = body.verification_uri_complete;
  opts.log?.(`device code issued, user code ${userCode}, poll every ${interval}s`);
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof complete === "string" ? { verificationUriComplete: complete } : {}),
    interval,
    expiresAt: Math.floor(now() / 1000) + expiresIn,
  };
}

function tokenSetOf(body: Record<string, unknown>): TokenSet {
  const idToken = body.id_token;
  if (typeof idToken !== "string") {
    throw new OidcError(
      "the provider returned no id_token; the apiserver authenticates on that token, " +
        "so the client needs the openid scope",
    );
  }
  const refresh = body.refresh_token;
  return {
    idToken,
    ...(typeof refresh === "string" ? { refreshToken: refresh } : {}),
    expiresAt: expiryOf(idToken),
  };
}

/**
 * Poll until the user has approved, the code expires, or `signal` aborts.
 * `authorization_pending` and `slow_down` are the normal course of the grant,
 * not failures; `slow_down` widens the interval as RFC 8628 requires.
 */
export async function pollForToken(
  tokenEndpoint: string,
  device: DeviceCode,
  clientId: string,
  clientSecret: string,
  opts: OidcOptions & { signal?: AbortSignal } = {},
): Promise<TokenSet> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  let interval = device.interval;
  for (;;) {
    if (opts.signal?.aborted) throw new OidcError("sign-in cancelled", "cancelled");
    if (Math.floor(now() / 1000) >= device.expiresAt) {
      throw new OidcError("the device code expired before it was approved", "expired_token");
    }
    await sleep(interval * 1000);
    const { status, body } = await postForm(
      tokenEndpoint,
      {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.deviceCode,
        client_id: clientId,
        client_secret: clientSecret,
      },
      opts,
    );
    if (status < 400) return tokenSetOf(body);
    const error = typeof body.error === "string" ? body.error : String(status);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      opts.log?.(`provider asked to slow down, polling every ${interval}s`);
      continue;
    }
    throw new OidcError(`sign-in failed: ${String(body.error_description ?? error)}`, error);
  }
}

/** Trade a refresh token for a fresh id_token, without troubling the user. */
export async function refresh(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  opts: OidcOptions = {},
): Promise<TokenSet> {
  const { status, body } = await postForm(
    tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    },
    opts,
  );
  if (status >= 400) {
    throw new OidcError(
      `the refresh token was refused: ${String(body.error_description ?? body.error ?? status)}`,
      typeof body.error === "string" ? body.error : undefined,
    );
  }
  const set = tokenSetOf(body);
  // A provider that rotates refresh tokens returns a new one; one that does
  // not expects the old one to keep working.
  return set.refreshToken ? set : { ...set, refreshToken };
}

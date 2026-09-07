// The two things this extension asks Che itself, rather than the cluster.
//
// Which namespaces belong to the signed-in user is one of them. Asking the
// cluster means listing namespaces cluster-wide, which an ordinary user is
// rightly refused; Che already knows the answer for the user whose token we
// hold, and answers it on a documented endpoint.
import type { CheEndpoints } from "./discovery";
import { normalizeUrl } from "./discovery";

export interface CheNamespace {
  name: string;
  attributes?: Record<string, unknown>;
}

export class CheApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
  }
}

export interface CheApiOptions {
  fetch?: typeof fetch;
  log?: (m: string) => void;
}

async function getJson(url: string, token: string, opts: CheApiOptions): Promise<unknown> {
  const f = opts.fetch ?? fetch;
  const res = await f(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    redirect: "manual",
  });
  // Unauthenticated calls are bounced to the identity provider rather than
  // refused outright, so a redirect here means the token was not accepted.
  if (res.status >= 300 && res.status < 400) {
    throw new CheApiError("Che redirected to sign-in: the token was not accepted", res.status, url);
  }
  if (!res.ok) throw new CheApiError(`Che answered ${res.status}`, res.status, url);
  return res.json();
}

/** The namespaces Che provisioned for the user this token belongs to. */
export async function userNamespaces(
  che: Pick<CheEndpoints, "cheUrl">,
  token: string,
  opts: CheApiOptions = {},
): Promise<CheNamespace[]> {
  const url = `${normalizeUrl(che.cheUrl)}/api/kubernetes/namespace`;
  const body = await getJson(url, token, opts);
  if (!Array.isArray(body)) throw new CheApiError("expected a list of namespaces", 200, url);
  const out: CheNamespace[] = [];
  for (const item of body) {
    if (typeof item === "object" && item !== null) {
      const n = (item as Record<string, unknown>).name;
      if (typeof n === "string") {
        const attrs = (item as Record<string, unknown>).attributes;
        out.push({
          name: n,
          ...(typeof attrs === "object" && attrs !== null
            ? { attributes: attrs as Record<string, unknown> }
            : {}),
        });
      }
    }
  }
  opts.log?.(`${url}: ${out.length} namespace(s)`);
  return out;
}

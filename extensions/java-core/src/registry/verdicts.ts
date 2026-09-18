// Supply-chain verdicts on dependency nodes (RFC 0001 goals "Supply chain in
// the tree", BatleHub RFC 0018): `GET /api/v1/verdicts/{registry}/{name}/{version}`
// on the BatleHub the link points at, with the token `batlehub-vsx` hands
// out. Maven names in BatleHub are `groupId:artifactId`. Pure URL and
// state mapping; the fetch is injected so it is testable.

export type VerdictState =
  "allowed" | "warned" | "quarantined" | "denied" | "unknown";

export interface Verdict {
  state: VerdictState;
  reasons: string[];
}

/** `<hub>/proxy/<registry>` → `{ hub, registry }`; anything else → undefined. */
export function splitRegistryUrl(
  url: string,
): { hub: string; registry: string } | undefined {
  const m = /^(https?:\/\/[^/]+)\/proxy\/([^/]+)\/?$/.exec(url);
  return m ? { hub: m[1]!, registry: m[2]! } : undefined;
}

export function verdictUrl(
  registryUrl: string,
  groupId: string,
  artifactId: string,
  version: string,
): string | undefined {
  const s = splitRegistryUrl(registryUrl);
  if (!s) return undefined;
  return `${s.hub}/api/v1/verdicts/${s.registry}/${encodeURIComponent(`${groupId}:${artifactId}`)}/${encodeURIComponent(version)}`;
}

export function parseVerdict(body: unknown): Verdict {
  const v = body as { state?: string; reason_codes?: string[] } | undefined;
  const state = String(v?.state ?? "").toLowerCase();
  return {
    state: ["allowed", "warned", "quarantined", "denied"].includes(state)
      ? (state as VerdictState)
      : "unknown",
    reasons: Array.isArray(v?.reason_codes) ? v!.reason_codes!.map(String) : [],
  };
}

export type Fetch = (
  url: string,
  headers: Record<string, string>,
) => Promise<{ status: number; json(): Promise<unknown> }>;

const cache = new Map<string, Verdict>();

export async function verdictOf(
  registryUrl: string,
  token: string | null,
  node: { groupId: string; artifactId: string; version: string },
  fetchImpl: Fetch = defaultFetch,
): Promise<Verdict | undefined> {
  const url = verdictUrl(
    registryUrl,
    node.groupId,
    node.artifactId,
    node.version,
  );
  if (!url || !node.groupId) return undefined;
  const hit = cache.get(url);
  if (hit) return hit;
  try {
    const r = await fetchImpl(
      url,
      token ? { Authorization: `Bearer ${token}` } : {},
    );
    // 404: no verdict (not scanned, or not this registry's package); the tree shows nothing.
    if (r.status === 404) return undefined;
    if (r.status !== 200)
      return { state: "unknown", reasons: [`HTTP ${r.status}`] };
    const v = parseVerdict(await r.json());
    cache.set(url, v);
    return v;
  } catch (e) {
    return { state: "unknown", reasons: [(e as Error).message] };
  }
}

async function defaultFetch(url: string, headers: Record<string, string>) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  return { status: r.status, json: () => r.json() };
}

/** The glyph the explorer puts on a node. */
export function verdictGlyph(v: Verdict | undefined): string {
  switch (v?.state) {
    case "allowed":
      return "$(verified)";
    case "warned":
      return "$(warning)";
    case "quarantined":
    case "denied":
      return "$(error)";
    case "unknown":
      return "$(question)";
    default:
      return "";
  }
}

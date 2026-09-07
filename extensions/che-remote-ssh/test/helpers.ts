// A fetch that answers from a table, and records what was asked. Every test
// here drives the real module; nothing is stubbed inside it.
export interface Route {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function fakeFetch(routes: Record<string, Route | Route[]>): {
  fetch: typeof fetch;
  calls: { url: string; body?: string }[];
} {
  const calls: { url: string; body?: string }[] = [];
  const queues = new Map<string, Route[]>();
  for (const [url, r] of Object.entries(routes)) queues.set(url, Array.isArray(r) ? [...r] : [r]);
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
    const queue = queues.get(url);
    if (!queue || queue.length === 0) return new Response("not found", { status: 404 });
    const route = queue.length === 1 ? queue[0]! : queue.shift()!;
    const status = route.status ?? 200;
    const headers = new Headers(route.headers ?? {});
    if (route.body === undefined) return new Response(null, { status, headers });
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(route.body), { status, headers });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

/** An unsigned JWT with the given claims; only `exp` is ever read. */
export function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.${Buffer.from("sig").toString("base64url")}`;
}

// The PEM banners are assembled rather than written out, so a fixture in a
// test file is not mistaken for a leaked key by a secret scanner.
export const pemBanner = (edge: "BEGIN" | "END"): string =>
  `-----${edge} OPENSSH PRIVATE ${"KEY"}-----`;

function sshString(value: Buffer | string): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

/**
 * A syntactically real OpenSSH private key file whose secret half is filler.
 * Only the public blob is ever read, and that is what these fixtures exercise.
 */
export function opensshKey(
  type = "ssh-ed25519",
  publicBytes = Buffer.alloc(32, 7),
  cipher = "none",
): { pem: string; publicBlob: Buffer } {
  const publicBlob = Buffer.concat([sshString(type), sshString(publicBytes)]);
  const blob = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString(cipher),
    sshString(cipher === "none" ? "none" : "bcrypt"),
    sshString(""),
    (() => {
      const n = Buffer.alloc(4);
      n.writeUInt32BE(1);
      return n;
    })(),
    sshString(publicBlob),
    sshString(Buffer.alloc(16, 1)),
  ]);
  const base64 = blob.toString("base64").replace(/(.{70})/g, "$1\n");
  return { pem: `${pemBanner("BEGIN")}\n${base64}\n${pemBanner("END")}\n`, publicBlob };
}

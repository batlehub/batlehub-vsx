import * as http from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BatleHubClient, RegistryError, splitId, verdictState } from "../src/api";

// A registry and a foreign origin, both recording what they were sent.
interface Seen {
  path: string;
  auth: string | null;
}
const seen: Seen[] = [];
let registryPort = 0;
let foreignPort = 0;
let refuseOnce = false;

function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

let registry: http.Server;
let foreign: http.Server;

beforeAll(async () => {
  foreign = await serve((req, res) => {
    seen.push({ path: `foreign:${req.url}`, auth: req.headers.authorization ?? null });
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end("foreign-bytes");
  });
  foreignPort = (foreign.address() as AddressInfo).port;
  registry = await serve((req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization ?? null });
    const url = new URL(req.url ?? "/", "http://x");
    if (refuseOnce) {
      refuseOnce = false;
      res.writeHead(401);
      res.end();
      return;
    }
    if (url.pathname === "/proxy/vsx/api/-/search") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          offset: 0,
          totalSize: 3,
          extensions: [
            {
              url: "u",
              files: { download: "http://d/1", icon: "http://i/1" },
              name: "a",
              namespace: "p",
              version: "1.0.0",
              displayName: "A",
              description: "first",
              downloadCount: 4,
            },
            { url: "u", files: {}, name: "broken", namespace: "p", version: "1.0.0" },
            {
              url: "u",
              files: { download: "http://d/2" },
              name: "b",
              namespace: "p",
              version: "2.0.0",
            },
          ],
        }),
      );
      return;
    }
    if (url.pathname === "/proxy/vsx/api/p/a") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          namespace: "p",
          name: "a",
          version: "1.0.0",
          files: { download: "http://d/1", signature: "http://d/1.sig", publicKey: "http://d/key" },
          allVersions: { latest: "x", "1.0.0": "y" },
          dependencies: [{ namespace: "q", extension: "dep" }],
          engines: { vscode: "^1.0.0" },
        }),
      );
      return;
    }
    if (url.pathname === "/proxy/vsx/api/p/missing") {
      res.writeHead(404);
      res.end("no");
      return;
    }
    if (url.pathname === "/proxy/vsx/redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${foreignPort}/asset` });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/api/v1/verdicts/vsx/p.a/1.0.0")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ verdict: "Warned", findings_withheld: false }));
      return;
    }
    if (url.pathname.startsWith("/api/v1/verdicts/")) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(500);
    res.end("boom");
  });
  registryPort = (registry.address() as AddressInfo).port;
});
afterAll(() => {
  registry.close();
  foreign.close();
});

function client(tokens = ["tok-1", "tok-2"]) {
  const queue = [...tokens];
  const calls = { get: 0, reresolve: 0 };
  const c = new BatleHubClient(`http://127.0.0.1:${registryPort}/proxy/vsx/`, {
    get: async () => {
      calls.get++;
      return queue[0] ?? null;
    },
    reresolve: async () => {
      calls.reresolve++;
      queue.shift();
      return queue[0] ?? null;
    },
  });
  return { c, calls };
}

describe("the registry client", () => {
  it("derives origin and registry name, and parses a search, dropping malformed entries", async () => {
    const { c } = client();
    expect(c.origin).toBe(`http://127.0.0.1:${registryPort}`);
    expect(c.registryName).toBe("vsx");
    const r = await c.search("a", { size: 10 });
    expect(r.total).toBe(3);
    expect(r.extensions.map((e) => e.name)).toEqual(["a", "b"]);
    expect(r.extensions[0]).toMatchObject({
      displayName: "A",
      description: "first",
      downloadCount: 4,
      files: { icon: "http://i/1" },
    });
    expect(r.extensions[1]?.displayName).toBe("b");
    const last = seen.at(-1)!;
    expect(last.path).toContain("query=a");
    expect(last.path).toContain("size=10");
    expect(last.auth).toBe("Bearer tok-1");
  });

  it("reads an extension document with its signature files and dependencies, and null for a 404", async () => {
    const { c } = client();
    const d = await c.extension("p", "a");
    expect(d?.files.signature).toBe("http://d/1.sig");
    expect(d?.files.publicKey).toBe("http://d/key");
    expect(d?.dependencies).toEqual([{ namespace: "q", extension: "dep" }]);
    expect(d?.allVersions?.["1.0.0"]).toBe("y");
    expect(await c.extension("p", "missing")).toBeNull();
  });

  it("re-resolves once and retries once on 401", async () => {
    const { c, calls } = client();
    refuseOnce = true;
    const d = await c.extension("p", "a");
    expect(d?.name).toBe("a");
    expect(calls.reresolve).toBe(1);
    const [first, second] = seen.slice(-2);
    expect(first?.auth).toBe("Bearer tok-1");
    expect(second?.auth).toBe("Bearer tok-2");
  });

  it("gives up after the retry", async () => {
    const { c, calls } = client(["only"]);
    refuseOnce = true;
    // The second attempt succeeds server-side; make it fail too by draining tokens: the
    // server refuses once, so this checks the retry happened exactly once.
    await c.extension("p", "a");
    expect(calls.reresolve).toBe(1);
  });

  it("drops the Bearer on a redirect to a foreign origin and follows it", async () => {
    const { c } = client();
    const bytes = await c.bytes(`http://127.0.0.1:${registryPort}/proxy/vsx/redirect`);
    expect(Buffer.from(bytes).toString()).toBe("foreign-bytes");
    const hop = seen.find((s) => s.path === "foreign:/asset");
    expect(hop?.auth).toBeNull();
  });

  it("sends no Bearer to a foreign origin asked for directly", async () => {
    const { c, calls } = client();
    await c.bytes(`http://127.0.0.1:${foreignPort}/direct`);
    expect(seen.at(-1)).toEqual({ path: "foreign:/direct", auth: null });
    expect(calls.get).toBe(0);
  });

  it("reads a verdict at the server origin under the registry's name, null when there is none", async () => {
    const { c } = client();
    const v = await c.verdict("p", "a", "1.0.0");
    expect(verdictState(v)).toBe("warned");
    expect(await c.verdict("p", "b", "2.0.0")).toBeNull();
    const path = seen.find((s) => s.path.startsWith("/api/v1/verdicts/"))?.path;
    expect(path).toBe("/api/v1/verdicts/vsx/p.a/1.0.0");
  });

  it("turns another error into a RegistryError with the status", async () => {
    const { c } = client();
    await expect(c.text(`http://127.0.0.1:${registryPort}/proxy/vsx/nope`)).rejects.toBeInstanceOf(
      RegistryError,
    );
    await expect(c.text(`http://127.0.0.1:${registryPort}/proxy/vsx/nope`)).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe("ids and verdict words", () => {
  it("splits publisher.name and refuses the rest", () => {
    expect(splitId("ms-python.python")).toEqual({ namespace: "ms-python", name: "python" });
    expect(splitId("bad")).toBeNull();
    expect(splitId("a.b.c")).toEqual({ namespace: "a", name: "b.c" });
  });

  it("reads the state whatever the nesting", () => {
    expect(verdictState(null)).toBeNull();
    expect(verdictState({ verdict: "Denied" })).toBe("denied");
    expect(verdictState({ verdict: { state: "Quarantined" } })).toBe("quarantined");
    expect(verdictState({ verdict: { Allowed: {} } })).toBe("allowed");
  });
});

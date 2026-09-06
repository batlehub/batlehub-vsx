import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readContract, writeContractEntry } from "../src/contract";
import { ChainDeps, CredentialChain } from "../src/credentials";

let dir: string;
let file: string;
const origin = "https://hub.example.dev";
const now = Date.parse("2026-09-06T12:00:00Z");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-chain-"));
  file = path.join(dir, "vsx-token.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function chain(over: Partial<ChainDeps> = {}) {
  const log: string[] = [];
  const deps: ChainDeps = {
    origin,
    contractPath: file,
    env: {},
    cli: async () => null,
    minTtlMs: 120_000,
    log: (m) => log.push(m),
    now: () => now,
    ...over,
  };
  return { chain: new CredentialChain(deps), log };
}

describe("the credential chain (RFC 0011 §4.2)", () => {
  it("1. takes a valid contract entry first", async () => {
    writeContractEntry(file, origin, {
      token: "from-file",
      kind: "oidc",
      expires_at: "2026-09-06T13:00:00Z",
      refresh: { source: "cli", owner: "batlehub-cli" },
    });
    const { chain: c } = chain({ env: { BATLEHUB_TOKEN: "from-env" } });
    const cred = await c.resolve({ interactive: false });
    expect(cred).toMatchObject({
      token: "from-file",
      source: "contract",
      kind: "oidc",
      refreshOwner: "batlehub-cli",
    });
  });

  it("1b. refreshes an expired entry it owns, and writes the result back", async () => {
    writeContractEntry(file, origin, {
      token: "old",
      kind: "oidc",
      expires_at: "2026-09-06T12:01:00Z",
      refresh: { source: "cli", owner: "batlehub-vsx" },
    });
    const { chain: c } = chain({
      refreshOwn: async () => ({
        token: "fresh",
        kind: "oidc",
        expiresAt: new Date(now + 3_600_000),
      }),
    });
    const cred = await c.resolve({ interactive: false });
    expect(cred).toMatchObject({
      token: "fresh",
      source: "contract",
      refreshOwner: "batlehub-vsx",
    });
    const entry = readContract(file).file?.registries[origin];
    expect(entry?.token).toBe("fresh");
    expect(entry?.refresh).toEqual({ source: "cli", owner: "batlehub-vsx" });
  });

  it("1c. leaves an expired entry someone else owns alone and falls through", async () => {
    writeContractEntry(file, origin, {
      token: "old",
      kind: "oidc",
      expires_at: "2026-09-06T11:00:00Z",
      refresh: { source: "cli", owner: "batlehub-cli" },
    });
    let refreshed = false;
    const { chain: c } = chain({
      env: { BATLEHUB_TOKEN: "from-env" },
      refreshOwn: async () => {
        refreshed = true;
        return null;
      },
    });
    const cred = await c.resolve({ interactive: false });
    expect(refreshed).toBe(false);
    expect(cred).toMatchObject({ token: "from-env", source: "env" });
    expect(readContract(file).file?.registries[origin]?.token).toBe("old");
  });

  it("2. takes BATLEHUB_TOKEN when the file has nothing, telling a PAT by its prefix", async () => {
    const { chain: c } = chain({ env: { BATLEHUB_TOKEN: " bh_pat_abc " } });
    expect(await c.resolve({ interactive: false })).toMatchObject({
      token: "bh_pat_abc",
      kind: "pat",
      source: "env",
    });
  });

  it("3. asks the CLI, and records its credential under the CLI's ownership", async () => {
    const { chain: c } = chain({
      cli: async (o) =>
        o === origin
          ? { token: "cli-tok", kind: "oidc", expires_at: "2026-09-06T12:30:00Z" }
          : null,
    });
    expect(await c.resolve({ interactive: false })).toMatchObject({
      token: "cli-tok",
      source: "cli",
      refreshOwner: "batlehub-cli",
    });
    const entry = readContract(file).file?.registries[origin];
    expect(entry).toEqual({
      token: "cli-tok",
      kind: "oidc",
      expires_at: "2026-09-06T12:30:00.000Z",
      refresh: { source: "cli", owner: "batlehub-cli" },
    });
  });

  it("4–5. asks the user only when allowed, and writes the answer as its own", async () => {
    let asked = 0;
    const { chain: c } = chain({
      interactive: async () => {
        asked++;
        return { token: "typed", kind: "pat" };
      },
    });
    expect(await c.resolve({ interactive: false })).toBeNull();
    expect(asked).toBe(0);
    expect(await c.resolve({ interactive: true })).toMatchObject({
      token: "typed",
      source: "interactive",
      kind: "pat",
    });
    expect(readContract(file).file?.registries[origin]?.refresh).toEqual({ source: "none" });
  });

  it("4. an OIDC sign-in becomes an entry this extension owns, refresh material kept out of the file", async () => {
    const { chain: c } = chain({
      interactive: async () => ({ token: "acc", kind: "oidc", expiresAt: new Date(now + 600_000) }),
    });
    await c.resolve({ interactive: true });
    const entry = readContract(file).file?.registries[origin];
    expect(entry?.refresh).toEqual({ source: "cli", owner: "batlehub-vsx" });
    expect(JSON.stringify(entry)).not.toContain("refresh_token");
  });

  it("warns once about an unparseable file and still falls through", async () => {
    fs.writeFileSync(file, "nope");
    const { chain: c, log } = chain({ env: { BATLEHUB_TOKEN: "e" } });
    await c.resolve({ interactive: false });
    await c.resolve({ interactive: false });
    expect(log.filter((l) => /not JSON/.test(l))).toHaveLength(1);
  });

  it("returns nothing when every step is dry", async () => {
    const { chain: c } = chain();
    expect(await c.resolve({ interactive: true })).toBeNull();
  });
});

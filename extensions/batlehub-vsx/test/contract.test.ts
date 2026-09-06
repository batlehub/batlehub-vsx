import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultContractPath,
  entryState,
  jsonPointer,
  originOf,
  readContract,
  removeContractEntry,
  resolveToken,
  validateContract,
  writeContractEntry,
} from "../src/contract";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-contract-"));
  file = path.join(dir, "state", "vsx-token.json");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the contract path", () => {
  it("is $BATLEHUB_HOME/state/vsx-token.json, BATLEHUB_HOME defaulting to ~/.batlehub", () => {
    expect(defaultContractPath({ BATLEHUB_HOME: "/x/y" }, "/home/u")).toBe(
      "/x/y/state/vsx-token.json",
    );
    expect(defaultContractPath({}, "/home/u")).toBe("/home/u/.batlehub/state/vsx-token.json");
    expect(defaultContractPath({ BATLEHUB_HOME: "  " }, "/home/u")).toBe(
      "/home/u/.batlehub/state/vsx-token.json",
    );
  });

  it("keys entries by bare origin", () => {
    expect(originOf("https://hub.example.dev/proxy/vsx/")).toBe("https://hub.example.dev");
    expect(originOf("http://127.0.0.1:8123/proxy/vsx")).toBe("http://127.0.0.1:8123");
  });
});

describe("reading", () => {
  it("is 'no credential' for an absent, unparseable or malformed file, with the reason", () => {
    expect(readContract(file)).toEqual({ file: null, exists: false });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(readContract(file).error).toMatch(/not JSON/);
    fs.writeFileSync(file, JSON.stringify({ version: 2, registries: {} }));
    expect(readContract(file).error).toMatch(/version must be 1/);
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, registries: { "https://h/": { token: "t", kind: "pat" } } }),
    );
    expect(readContract(file).error).toMatch(/not a bare origin/);
  });

  it("validates the schema's shapes", () => {
    const ok = (e: unknown) => validateContract({ version: 1, registries: { "https://h": e } });
    expect(ok({ token: "t", kind: "pat" })).toBeNull();
    expect(
      ok({
        token: { from: "file", path: "/p" },
        kind: "kubernetes",
        refresh: { source: "reresolve" },
      }),
    ).toBeNull();
    expect(ok({ token: { from: "file", path: "rel" }, kind: "kubernetes" })).toMatch(/absolute/);
    expect(ok({ token: "", kind: "pat" })).toMatch(/empty/);
    expect(ok({ token: "t", kind: "magic" })).toMatch(/kind/);
    expect(ok({ token: "t", kind: "oidc", expires_at: "yesterday" })).toMatch(/RFC 3339/);
    expect(ok({ token: "t", kind: "oidc", refresh: { source: "reresolve" } })).toMatch(
      /never refresh/,
    );
    expect(ok({ token: { from: "exchange", endpoint: "x" }, kind: "oidc", extra: 1 })).toBeNull();
  });
});

describe("resolving a token source", () => {
  it("takes a string, an inline source, and a file source raw or as JSON with a pointer", () => {
    const warns: string[] = [];
    const p = path.join(dir, "tok");
    fs.writeFileSync(p, "  secret\n", { mode: 0o600 });
    expect(resolveToken("lit", (w) => warns.push(w))).toBe("lit");
    expect(resolveToken({ from: "inline", value: "v" })).toBe("v");
    expect(resolveToken({ from: "file", path: p }, (w) => warns.push(w))).toBe("secret");
    const j = path.join(dir, "tok.json");
    fs.writeFileSync(j, JSON.stringify({ token: "jt", nested: { a: ["x", "y"] } }), {
      mode: 0o600,
    });
    expect(resolveToken({ from: "file", path: j, format: "json" })).toBe("jt");
    expect(resolveToken({ from: "file", path: j, format: "json", pointer: "/nested/a/1" })).toBe(
      "y",
    );
    expect(
      resolveToken({ from: "file", path: j, format: "json", pointer: "/nope" }, (w) =>
        warns.push(w),
      ),
    ).toBeNull();
    expect(warns.some((w) => /nothing at \/nope/.test(w))).toBe(true);
  });

  it("is 'no credential', with a warning, for reserved and unknown sources and a missing file", () => {
    const warns: string[] = [];
    expect(resolveToken({ from: "env", name: "X" }, (w) => warns.push(w))).toBeNull();
    expect(resolveToken({ from: "wat" }, (w) => warns.push(w))).toBeNull();
    expect(
      resolveToken({ from: "file", path: path.join(dir, "absent") }, (w) => warns.push(w)),
    ).toBeNull();
    expect(resolveToken({ from: "file", path: "relative" }, (w) => warns.push(w))).toBeNull();
    expect(warns).toHaveLength(4);
    expect(warns[0]).toMatch(/reserved/);
    expect(warns[1]).toMatch(/unknown/);
  });

  it("warns about a world-readable credential file and caps the read", () => {
    const warns: string[] = [];
    const p = path.join(dir, "open");
    fs.writeFileSync(p, "x".repeat(70 * 1024), { mode: 0o644 });
    const v = resolveToken({ from: "file", path: p }, (w) => warns.push(w));
    expect(v?.length).toBe(64 * 1024);
    expect(warns.some((w) => /world-readable|group-/.test(w))).toBe(true);
  });

  it("walks JSON pointers with escapes", () => {
    expect(jsonPointer({ "a/b": { "~c": 1 } }, "/a~1b/~0c")).toBe(1);
    expect(jsonPointer({ a: 1 }, "a")).toBeUndefined();
    expect(jsonPointer({ a: 1 }, "")).toEqual({ a: 1 });
  });
});

describe("entry state", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  it("is ok, expired under min-ttl, unset or invalid", () => {
    expect(entryState(undefined)).toBe("unset");
    expect(entryState({ token: "t", kind: "pat" }, now)).toBe("ok");
    expect(entryState({ token: "t", kind: "oidc", expires_at: "2026-09-06T12:01:00Z" }, now)).toBe(
      "ok",
    );
    expect(
      entryState({ token: "t", kind: "oidc", expires_at: "2026-09-06T12:01:00Z" }, now, 120_000),
    ).toBe("expired");
    expect(entryState({ token: "t", kind: "oidc", expires_at: "2026-09-06T11:00:00Z" }, now)).toBe(
      "expired",
    );
    expect(entryState({ token: "", kind: "oidc" }, now)).toBe("invalid");
  });
});

describe("writing", () => {
  it("creates the file 0600 under 0700 directories, and preserves other entries and unknown fields", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        registries: { "https://other": { token: "o", kind: "pat", custom: true } },
        future_field: { keep: "me" },
      }),
    );
    writeContractEntry(file, "https://hub", {
      token: "t",
      kind: "oidc",
      expires_at: "2026-09-06T12:00:00Z",
      refresh: { source: "cli", owner: "batlehub-vsx" },
    });
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(doc.future_field).toEqual({ keep: "me" });
    expect(doc.registries["https://other"]).toEqual({ token: "o", kind: "pat", custom: true });
    expect(doc.registries["https://hub"].refresh.owner).toBe("batlehub-vsx");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp"))).toHaveLength(0);
  });

  it("creates the directories when nothing exists yet", () => {
    writeContractEntry(file, "https://hub", { token: "t", kind: "pat" });
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(readContract(file).file?.registries["https://hub"]?.token).toBe("t");
  });

  it("refuses an invalid entry and removes an existing one", () => {
    expect(() => writeContractEntry(file, "https://hub", { token: "", kind: "pat" })).toThrow(
      /invalid/,
    );
    writeContractEntry(file, "https://hub", { token: "t", kind: "pat" });
    expect(removeContractEntry(file, "https://hub")).toBe(true);
    expect(removeContractEntry(file, "https://hub")).toBe(false);
    expect(readContract(file).file?.registries).toEqual({});
  });

  it("replaces an unparseable file rather than failing forever", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "garbage");
    writeContractEntry(file, "https://hub", { token: "t", kind: "pat" });
    expect(readContract(file).file?.version).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { parseOidcPaste } from "../src/auth-provider";
import { remaining } from "../src/broker";
import { cliToken, cliWriteTokenFile, parseCliToken } from "../src/cli";
import { decideMode } from "../src/mode";

describe("the CLI step", () => {
  it("parses `auth token --output json` and refuses anything else", () => {
    expect(
      parseCliToken(
        '{"registry":"https://h","token":"t","kind":"oidc","expires_at":"2026-09-04T21:40:00Z"}\n',
      ),
    ).toEqual({
      registry: "https://h",
      token: "t",
      kind: "oidc",
      expires_at: "2026-09-04T21:40:00Z",
    });
    expect(parseCliToken("not json")).toBeNull();
    expect(parseCliToken('{"token":""}')).toBeNull();
    expect(parseCliToken('{"token":"t"}')).toEqual({ token: "t", kind: "oidc" });
  });

  it("passes the server and min-ttl, and reads an absent CLI as no credential", async () => {
    const calls: string[][] = [];
    const t = await cliToken("batlehub-cli", "https://h", {
      minTtlSeconds: 120,
      run: async (_f, args) => {
        calls.push(args);
        return { code: 0, stdout: '{"token":"x","kind":"pat"}', stderr: "" };
      },
    });
    expect(t).toEqual({ token: "x", kind: "pat" });
    expect(calls[0]).toEqual([
      "--server",
      "https://h",
      "auth",
      "token",
      "--output",
      "json",
      "--min-ttl",
      "120",
    ]);
    expect(
      await cliToken("nope", "https://h", {
        run: async () => ({ code: -2, stdout: "", stderr: "" }),
      }),
    ).toBeNull();
    expect(
      await cliToken("cli", "https://h", {
        run: async () => ({ code: 1, stdout: "", stderr: "no credential" }),
      }),
    ).toBeNull();
    expect(
      await cliWriteTokenFile("cli", "https://h", {
        contractPath: "/p",
        run: async (_f, a) => ({ code: a.includes("--path") ? 0 : 1, stdout: "", stderr: "" }),
      }),
    ).toBe(true);
  });
});

describe("the sign-in paste", () => {
  it("reads the server's landing URL like the CLI does, and a bare token", () => {
    const p = parseOidcPaste(
      "https://hub/#oidc_access_token=ACC&oidc_state=S1&oidc_provider=oidc&oidc_refresh_token=REF&oidc_expires_in=3600",
    );
    expect(p).toEqual({
      accessToken: "ACC",
      refreshToken: "REF",
      expiresIn: 3600,
      state: "S1",
      provider: "oidc",
    });
    expect(parseOidcPaste("  bare-token ")).toEqual({ accessToken: "bare-token" });
    expect(parseOidcPaste("")).toBeNull();
    expect(parseOidcPaste("https://hub/?oidc_access_token=A")).toEqual({ accessToken: "A" });
  });
});

describe("mode detection (RFC 0011 §4.2)", () => {
  const none = { vsxRegistryAuthSupport: false, galleryServiceUrl: null };
  it("follows the setting, the environment, product.json, then the gallery", () => {
    expect(decideMode("broker", none, {}, "").mode).toBe("broker");
    expect(
      decideMode("marketplace", { vsxRegistryAuthSupport: true, galleryServiceUrl: null }, {}, "")
        .mode,
    ).toBe("marketplace");
    expect(decideMode("auto", none, { VSX_REGISTRY_AUTH_SUPPORT: "1" }, "").mode).toBe("broker");
    expect(
      decideMode("auto", { vsxRegistryAuthSupport: true, galleryServiceUrl: null }, {}, "").mode,
    ).toBe("broker");
    expect(
      decideMode(
        "auto",
        { ...none, galleryServiceUrl: "https://hub/proxy/vsx/vscode/gallery" },
        {},
        "https://hub/proxy/vsx",
      ).mode,
    ).toBe("broker");
    expect(
      decideMode(
        "auto",
        { ...none, galleryServiceUrl: "http://127.0.0.1:4123/s3ss10n/vsx/vscode/gallery" },
        {},
        "https://hub/proxy/vsx",
      ).mode,
    ).toBe("broker");
    const stock = decideMode(
      "auto",
      { ...none, galleryServiceUrl: "https://marketplace.visualstudio.com/_apis/public/gallery" },
      {},
      "https://hub/proxy/vsx",
    );
    expect(stock.mode).toBe("marketplace");
    expect(stock.reason).toMatch(/cannot be repointed/);
    expect(decideMode("auto", none, {}, "").mode).toBe("marketplace");
  });
});

describe("time left", () => {
  it("is human", () => {
    const now = 0;
    expect(remaining(new Date(30_000), now)).toBe("30s");
    expect(remaining(new Date(5 * 60_000), now)).toBe("5m");
    expect(remaining(new Date(3 * 3_600_000), now)).toBe("3h");
    expect(remaining(new Date(72 * 3_600_000), now)).toBe("3d");
    expect(remaining(new Date(-1), now)).toBe("expired");
  });
});

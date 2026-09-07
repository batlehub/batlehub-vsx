import { describe, expect, it } from "vitest";
import { expiryOf, isFresh, pollForToken, refresh, requestDeviceCode } from "../src/oidc";
import { fakeFetch, jwt } from "./helpers";

const DEVICE = "https://auth.example.dev/application/o/device/";
const TOKEN = "https://auth.example.dev/application/o/token/";
const nowSeconds = 1_800_000_000;
const now = () => nowSeconds * 1000;
const sleep = () => Promise.resolve();
const idToken = jwt({ sub: "max", exp: nowSeconds + 3600 });

const device = {
  deviceCode: "dev-code-1234",
  userCode: "ABCD-EFGH",
  verificationUri: "https://auth.example.dev/device",
  interval: 5,
  expiresAt: nowSeconds + 600,
};

describe("expiryOf", () => {
  it("reads exp out of the payload", () => {
    expect(expiryOf(idToken)).toBe(nowSeconds + 3600);
  });

  it("refuses a token whose life cannot be seen", () => {
    expect(() => expiryOf("not-a-jwt")).toThrow(/not a JWT/);
    expect(() => expiryOf(jwt({ sub: "max" }))).toThrow(/no exp claim/);
  });
});

describe("isFresh", () => {
  it("counts the skew against the expiry", () => {
    const set = { idToken, expiresAt: nowSeconds + 30 };
    expect(isFresh(set, 60, now)).toBe(false);
    expect(isFresh(set, 10, now)).toBe(true);
  });
});

describe("requestDeviceCode", () => {
  it("asks for the scopes and returns the code the user types", async () => {
    const { fetch, calls } = fakeFetch({
      [DEVICE]: {
        body: {
          device_code: "dev-code-1234",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.example.dev/device",
          verification_uri_complete: "https://auth.example.dev/device?code=ABCD-EFGH",
          interval: 5,
          expires_in: 600,
        },
      },
    });
    const got = await requestDeviceCode(DEVICE, "che-cluster", "s3cret", ["openid", "email"], {
      fetch,
      now,
    });
    expect(got.userCode).toBe("ABCD-EFGH");
    expect(got.verificationUriComplete).toContain("code=ABCD-EFGH");
    expect(got.expiresAt).toBe(nowSeconds + 600);
    expect(calls[0]!.body).toContain("scope=openid+email");
    expect(calls[0]!.body).toContain("client_secret=s3cret");
  });

  it("reports what the provider refused", async () => {
    const { fetch } = fakeFetch({
      [DEVICE]: { status: 400, body: { error: "invalid_client", error_description: "bad secret" } },
    });
    await expect(
      requestDeviceCode(DEVICE, "che-cluster", "wrong", ["openid"], { fetch, now }),
    ).rejects.toThrow(/bad secret/);
  });
});

describe("pollForToken", () => {
  it("waits through authorization_pending and slow_down", async () => {
    const { fetch, calls } = fakeFetch({
      [TOKEN]: [
        { status: 400, body: { error: "authorization_pending" } },
        { status: 400, body: { error: "slow_down" } },
        { body: { id_token: idToken, refresh_token: "r1" } },
      ],
    });
    const set = await pollForToken(TOKEN, device, "che-cluster", "s3cret", { fetch, now, sleep });
    expect(set).toEqual({ idToken, refreshToken: "r1", expiresAt: nowSeconds + 3600 });
    expect(calls).toHaveLength(3);
  });

  it("stops when the device code has expired", async () => {
    const { fetch } = fakeFetch({});
    const expired = { ...device, expiresAt: nowSeconds - 1 };
    await expect(
      pollForToken(TOKEN, expired, "che-cluster", "s3cret", { fetch, now, sleep }),
    ).rejects.toThrow(/expired/);
  });

  it("stops on a refusal that is not part of the grant", async () => {
    const { fetch } = fakeFetch({
      [TOKEN]: { status: 400, body: { error: "access_denied", error_description: "user said no" } },
    });
    await expect(
      pollForToken(TOKEN, device, "che-cluster", "s3cret", { fetch, now, sleep }),
    ).rejects.toThrow(/user said no/);
  });

  it("refuses a response without an id_token, which is what the apiserver reads", async () => {
    const { fetch } = fakeFetch({ [TOKEN]: { body: { access_token: "opaque" } } });
    await expect(
      pollForToken(TOKEN, device, "che-cluster", "s3cret", { fetch, now, sleep }),
    ).rejects.toThrow(/no id_token/);
  });

  it("honours cancellation", async () => {
    const { fetch } = fakeFetch({});
    const ac = new AbortController();
    ac.abort();
    await expect(
      pollForToken(TOKEN, device, "che-cluster", "s3cret", {
        fetch,
        now,
        sleep,
        signal: ac.signal,
      }),
    ).rejects.toThrow(/cancelled/);
  });
});

describe("refresh", () => {
  it("keeps the old refresh token when the provider does not rotate it", async () => {
    const { fetch } = fakeFetch({ [TOKEN]: { body: { id_token: idToken } } });
    const set = await refresh(TOKEN, "r1", "che-cluster", "s3cret", { fetch, now });
    expect(set.refreshToken).toBe("r1");
  });

  it("takes the new one when it rotates", async () => {
    const { fetch } = fakeFetch({ [TOKEN]: { body: { id_token: idToken, refresh_token: "r2" } } });
    const set = await refresh(TOKEN, "r1", "che-cluster", "s3cret", { fetch, now });
    expect(set.refreshToken).toBe("r2");
  });

  it("reports a refusal", async () => {
    const { fetch } = fakeFetch({ [TOKEN]: { status: 400, body: { error: "invalid_grant" } } });
    await expect(refresh(TOKEN, "r1", "che-cluster", "s3cret", { fetch, now })).rejects.toThrow(
      /invalid_grant/,
    );
  });
});

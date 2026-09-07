import { describe, expect, it } from "vitest";
import {
  discoverChe,
  discoveryCandidates,
  fetchOidcMetadata,
  isApiServer,
  normalizeUrl,
  probeApiServer,
  probeOauthStart,
} from "../src/discovery";
import { fakeFetch } from "./helpers";

const AUTHORIZE = "https://auth.example.dev/application/o/authorize/";
const REDIRECT = `${AUTHORIZE}?client_id=che-cluster&response_type=code&scope=openid`;
const DISCO = "https://auth.example.dev/application/o/che-cluster/.well-known/openid-configuration";

const metadata = {
  issuer: "https://auth.example.dev/application/o/che-cluster/",
  authorization_endpoint: AUTHORIZE,
  token_endpoint: "https://auth.example.dev/application/o/token/",
  device_authorization_endpoint: "https://auth.example.dev/application/o/device/",
};

describe("normalizeUrl", () => {
  it("drops trailing slashes so joins never double them", () => {
    expect(normalizeUrl("https://che.example.dev/")).toBe("https://che.example.dev");
    expect(normalizeUrl("  https://che.example.dev//  ")).toBe("https://che.example.dev");
  });
});

describe("probeOauthStart", () => {
  it("reads the client id and the authorize endpoint out of the redirect", async () => {
    const { fetch } = fakeFetch({
      "https://che.example.dev/oauth/start": { status: 302, headers: { location: REDIRECT } },
    });
    const found = await probeOauthStart("https://che.example.dev", { fetch });
    expect(found).toEqual({ clientId: "che-cluster", authorizeEndpoint: AUTHORIZE });
  });

  it("returns null when Che does not redirect", async () => {
    const { fetch } = fakeFetch({
      "https://che.example.dev/oauth/start": { status: 200, body: {} },
    });
    expect(await probeOauthStart("https://che.example.dev", { fetch })).toBeNull();
  });

  it("refuses a redirect that carries no client_id", async () => {
    const { fetch } = fakeFetch({
      "https://che.example.dev/oauth/start": { status: 302, headers: { location: AUTHORIZE } },
    });
    await expect(probeOauthStart("https://che.example.dev", { fetch })).rejects.toThrow(
      /client_id/,
    );
  });
});

describe("discoveryCandidates", () => {
  it("puts the Authentik per-application document first", () => {
    expect(discoveryCandidates(AUTHORIZE, "che-cluster")[0]).toBe(DISCO);
  });

  it("knows where Keycloak keeps a realm's document", () => {
    const authorize = "https://sso.example.dev/realms/dev/protocol/openid-connect/auth";
    expect(discoveryCandidates(authorize, "k8s")).toContain(
      "https://sso.example.dev/realms/dev/.well-known/openid-configuration",
    );
  });

  it("always offers the document at the root", () => {
    expect(discoveryCandidates(AUTHORIZE, "che-cluster")).toContain(
      "https://auth.example.dev/.well-known/openid-configuration",
    );
  });
});

describe("fetchOidcMetadata", () => {
  it("accepts the document whose authorize endpoint is the one we were sent to", async () => {
    const { fetch } = fakeFetch({ [DISCO]: { body: metadata } });
    expect(await fetchOidcMetadata(AUTHORIZE, "che-cluster", { fetch })).toEqual(metadata);
  });

  it("skips a document that belongs to another client", async () => {
    const { fetch } = fakeFetch({
      [DISCO]: { body: { ...metadata, authorization_endpoint: "https://elsewhere/authorize" } },
      "https://auth.example.dev/.well-known/openid-configuration": { body: metadata },
    });
    expect(await fetchOidcMetadata(AUTHORIZE, "che-cluster", { fetch })).toEqual(metadata);
  });

  it("fails when nothing matches", async () => {
    const { fetch } = fakeFetch({});
    await expect(fetchOidcMetadata(AUTHORIZE, "che-cluster", { fetch })).rejects.toThrow(
      /no OpenID configuration matched/,
    );
  });
});

describe("discoverChe", () => {
  it("chains both probes", async () => {
    const { fetch } = fakeFetch({
      "https://che.example.dev/oauth/start": { status: 302, headers: { location: REDIRECT } },
      [DISCO]: { body: metadata },
    });
    const che = await discoverChe("https://che.example.dev/", { fetch });
    expect(che).toEqual({
      cheUrl: "https://che.example.dev",
      clientId: "che-cluster",
      oidc: metadata,
    });
  });
});

describe("isApiServer", () => {
  it("recognises the Status object an anonymous request is refused with", async () => {
    const { fetch } = fakeFetch({
      "https://che.example.dev:6443/version": {
        status: 401,
        body: { kind: "Status", apiVersion: "v1", code: 401 },
      },
    });
    expect(await isApiServer("https://che.example.dev:6443", { fetch })).toBe(true);
  });

  it("recognises an apiserver that answers the version payload", async () => {
    const { fetch } = fakeFetch({
      "https://k8s.example.dev:6443/version": {
        body: { major: "1", minor: "31", gitVersion: "v1.31.0" },
      },
    });
    expect(await isApiServer("https://k8s.example.dev:6443", { fetch })).toBe(true);
  });

  it("rejects a web server that happens to answer JSON", async () => {
    const { fetch } = fakeFetch({
      "https://che.example.dev:6443/version": { body: { hello: "world" } },
    });
    expect(await isApiServer("https://che.example.dev:6443", { fetch })).toBe(false);
  });

  it("rejects a host that does not answer at all", async () => {
    const refused = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    expect(await isApiServer("https://nothing.example.dev:6443", { fetch: refused })).toBe(false);
  });
});

describe("probeApiServer", () => {
  it("tries the Che host before the api. prefix", async () => {
    const { fetch, calls } = fakeFetch({
      "https://che.example.dev:6443/version": {
        status: 401,
        body: { kind: "Status", apiVersion: "v1" },
      },
    });
    expect(await probeApiServer("https://che.example.dev", { fetch })).toBe(
      "https://che.example.dev:6443",
    );
    expect(calls).toHaveLength(1);
  });

  it("gives up rather than guess", async () => {
    const { fetch } = fakeFetch({});
    expect(await probeApiServer("https://che.example.dev", { fetch })).toBeNull();
  });
});

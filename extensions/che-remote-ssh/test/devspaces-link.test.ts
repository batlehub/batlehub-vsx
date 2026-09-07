import { describe, expect, it } from "vitest";
import { decodeKey, parseDevSpacesLink, summarizeLink } from "../src/devspaces-link";
import { opensshKey } from "./helpers";

const { pem } = opensshKey();
const key = Buffer.from(pem, "utf8").toString("base64");

function link(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    namespace: "dev-ws-max",
    podName: "workspaceb089-5cbb99967c-4nbdc",
    userName: "user",
    dwName: "weebo-dev-setup",
    key,
    url: "https://che.example.dev",
    ...overrides,
  });
  return `vscode://redhat.devspaces-remote-ssh?${params.toString()}`;
}

describe("parseDevSpacesLink", () => {
  it("reads every field the dashboard puts in the link", () => {
    const parsed = parseDevSpacesLink(link());
    expect(parsed.namespace).toBe("dev-ws-max");
    expect(parsed.podName).toBe("workspaceb089-5cbb99967c-4nbdc");
    expect(parsed.userName).toBe("user");
    expect(parsed.dwName).toBe("weebo-dev-setup");
    expect(parsed.cheUrl).toBe("https://che.example.dev");
    expect(parsed.key).toBe(pem);
  });

  it("accepts the query on its own, which is what survives some pastes", () => {
    const query = link().split("?")[1]!;
    expect(parseDevSpacesLink(query).dwName).toBe("weebo-dev-setup");
  });

  it("does not care which extension id the link names", () => {
    expect(
      parseDevSpacesLink(link().replace("redhat.devspaces-remote-ssh", "batlehub.che")).podName,
    ).toBe("workspaceb089-5cbb99967c-4nbdc");
  });

  it("drops the trailing slash on the instance", () => {
    expect(parseDevSpacesLink(link({ url: "https://che.example.dev/" })).cheUrl).toBe(
      "https://che.example.dev",
    );
  });

  it("names the field that is missing", () => {
    const without = link().replace(/&podName=[^&]*/, "");
    expect(() => parseDevSpacesLink(without)).toThrow(/no podName/);
  });

  it("refuses a namespace that is not a Kubernetes name", () => {
    expect(() => parseDevSpacesLink(link({ namespace: "Dev/../etc" }))).toThrow(/namespace is not/);
  });

  it("refuses a pod name that could be an argument", () => {
    expect(() => parseDevSpacesLink(link({ podName: "--kubeconfig=/etc/x" }))).toThrow(
      /podName is not/,
    );
  });

  it("refuses an account name with a shell character in it", () => {
    expect(() => parseDevSpacesLink(link({ userName: "user;rm -rf /" }))).toThrow(
      /userName is not/,
    );
  });

  it("refuses an instance that is not http(s)", () => {
    expect(() => parseDevSpacesLink(link({ url: "file:///etc/passwd" }))).toThrow(/not http/);
  });

  it("refuses nothing at all", () => {
    expect(() => parseDevSpacesLink("   ")).toThrow(/nothing was pasted/);
    expect(() => parseDevSpacesLink("hello")).toThrow(/does not look like/);
  });
});

describe("decodeKey", () => {
  it("adds the trailing newline OpenSSH insists on", () => {
    const without = pem.trimEnd();
    expect(decodeKey(Buffer.from(without).toString("base64"))).toBe(`${without}\n`);
  });

  it("refuses something that did not decode to a key", () => {
    expect(() => decodeKey(Buffer.from("hello").toString("base64"))).toThrow(
      /did not decode to a private key/,
    );
  });
});

describe("summarizeLink", () => {
  const rows = summarizeLink(parseDevSpacesLink(link()));
  const flat = rows.map(([l, v]) => `${l}: ${v}`).join("\n");

  it("never contains the key", () => {
    expect(flat).not.toContain("PRIVATE");
    expect(flat).not.toContain(pem.split("\n")[1]);
  });

  it("identifies the key by its fingerprint instead", () => {
    expect(flat).toMatch(/ssh-ed25519, SHA256:[A-Za-z0-9+/]+/);
  });

  it("says which instance and which host the entry becomes", () => {
    expect(flat).toContain("https://che.example.dev");
    expect(flat).toContain("weebo-dev-setup");
  });
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeKey, describeKeySafely } from "../src/sshkey";
import { opensshKey, pemBanner } from "./helpers";

describe("describeKey", () => {
  it("reads the type and the fingerprint ssh-keygen would print", () => {
    const { pem, publicBlob } = opensshKey();
    const expected = createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "");
    const described = describeKey(pem);
    expect(described.type).toBe("ssh-ed25519");
    expect(described.fingerprint).toBe(`SHA256:${expected}`);
    expect(described.encrypted).toBe(false);
  });

  it("reads a key of another type", () => {
    expect(describeKey(opensshKey("ecdsa-sha2-nistp256", Buffer.alloc(65, 3)).pem).type).toBe(
      "ecdsa-sha2-nistp256",
    );
  });

  it("says when the secret half is passphrase-protected, without needing it", () => {
    const described = describeKey(opensshKey("ssh-ed25519", Buffer.alloc(32, 9), "aes256-ctr").pem);
    expect(described.encrypted).toBe(true);
    expect(described.type).toBe("ssh-ed25519");
  });

  it("never returns the key itself", () => {
    const { pem } = opensshKey();
    const described = describeKey(pem);
    expect(JSON.stringify(described)).not.toContain(pem.split("\n")[1]);
  });

  it("refuses something that is not an OpenSSH key", () => {
    expect(() => describeKey("hello")).toThrow(/not an OpenSSH private key/);
  });

  it("refuses a body that is not an openssh-key-v1 blob", () => {
    const pem = `${pemBanner("BEGIN")}\n${Buffer.from("nope").toString("base64")}\n${pemBanner("END")}\n`;
    expect(() => describeKey(pem)).toThrow(/openssh-key-v1/);
  });

  it("refuses a truncated blob rather than read past its end", () => {
    const { pem } = opensshKey();
    const lines = pem.trim().split("\n");
    const truncated = [lines[0], lines[1]!.slice(0, 20), lines.at(-1)].join("\n");
    expect(() => describeKey(truncated)).toThrow();
  });
});

describe("describeKeySafely", () => {
  it("reports rather than throws, so a summary always renders", () => {
    expect(describeKeySafely("hello")).toEqual({ error: "this is not an OpenSSH private key" });
    expect(describeKeySafely(opensshKey().pem)).toHaveProperty("fingerprint");
  });
});

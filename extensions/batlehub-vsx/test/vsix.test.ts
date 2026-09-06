import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  publicKeyObject,
  readVsixManifest,
  readZipEntry,
  sha256Base64,
  verifyVsixSignature,
  zipEntries,
} from "../src/vsix";
import { makeVsix, makeZip } from "./zip";

// RFC 0020 §4.4: the archive the registry serves, byte for byte Open VSX's.
function signatureArchive(
  vsix: Buffer,
  privateKey: crypto.KeyObject,
  tamper?: (m: Record<string, unknown>) => void,
): Buffer {
  const manifest: Record<string, unknown> = {
    package: { size: vsix.length, digests: { sha256: sha256Base64(vsix) } },
    entries: {
      [Buffer.from("extension.vsixmanifest").toString("base64")]: {
        size: 1,
        digests: { sha256: "x" },
      },
    },
  };
  tamper?.(manifest);
  const sig = crypto.sign(null, vsix, privateKey);
  return makeZip([
    { name: ".signature.sig", data: sig },
    { name: ".signature.manifest", data: JSON.stringify(manifest) },
    { name: ".signature.p7s", data: Buffer.alloc(0) },
  ]);
}

describe("the zip reader", () => {
  it("lists entries and inflates deflated ones", () => {
    const zip = makeZip([
      { name: "a.txt", data: "stored" },
      { name: "dir/b.txt", data: "deflated ".repeat(50), deflate: true },
    ]);
    expect(zipEntries(zip).map((e) => e.name)).toEqual(["a.txt", "dir/b.txt"]);
    expect(readZipEntry(zip, "a.txt")?.toString()).toBe("stored");
    expect(readZipEntry(zip, "dir/b.txt")?.toString()).toBe("deflated ".repeat(50));
    expect(readZipEntry(zip, "missing")).toBeNull();
  });

  it("refuses what is not a zip", () => {
    expect(() => zipEntries(Buffer.from("not a zip at all, nothing to see"))).toThrow(/not a zip/);
  });
});

describe("the VSIX manifest", () => {
  it("reads the id, the dependencies and the pack", () => {
    const vsix = makeVsix({
      name: "n",
      publisher: "p",
      version: "1.2.3",
      extensionDependencies: ["a.b"],
      extensionPack: ["c.d", 7],
    });
    const m = readVsixManifest(vsix);
    expect(m).toMatchObject({
      name: "n",
      publisher: "p",
      version: "1.2.3",
      extensionDependencies: ["a.b"],
      extensionPack: ["c.d"],
    });
  });

  it("names a package without a manifest", () => {
    expect(() => readVsixManifest(makeZip([{ name: "x", data: "y" }]))).toThrow(/not a VSIX/);
  });
});

describe("the registry signature (RFC 0020)", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const hex = (publicKey.export({ type: "spki", format: "der" }) as Buffer)
    .subarray(-32)
    .toString("hex");
  const vsix = makeVsix({ name: "n", publisher: "p", version: "1.0.0" });

  it("verifies with the PEM the registry serves and the hex the CLI prints", () => {
    const archive = signatureArchive(vsix, privateKey);
    expect(verifyVsixSignature(vsix, archive, pem).ok).toBe(true);
    expect(verifyVsixSignature(vsix, archive, hex).ok).toBe(true);
    expect(verifyVsixSignature(vsix, archive, publicKeyObject(hex)).ok).toBe(true);
  });

  it("refuses another key's signature", () => {
    const other = crypto.generateKeyPairSync("ed25519").privateKey;
    const r = verifyVsixSignature(vsix, signatureArchive(vsix, other), pem);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not verify/);
  });

  it("names an archive that describes other bytes before checking the signature", () => {
    const otherVsix = makeVsix({ name: "n", publisher: "p", version: "2.0.0" });
    const r = verifyVsixSignature(otherVsix, signatureArchive(vsix, privateKey), pem);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/byte package|other bytes/);
  });

  it("refuses a manifest whose digest was edited", () => {
    const archive = signatureArchive(vsix, privateKey, (m) => {
      (m.package as { digests: { sha256: string } }).digests.sha256 = sha256Base64(
        Buffer.from("x"),
      );
    });
    expect(verifyVsixSignature(vsix, archive, pem).reason).toMatch(/other bytes/);
  });

  it("names a missing entry and a wrong-length signature", () => {
    const noSig = makeZip([{ name: ".signature.manifest", data: "{}" }]);
    expect(verifyVsixSignature(vsix, noSig, pem).reason).toMatch(/no \.signature\.sig/);
    const short = makeZip([
      { name: ".signature.sig", data: Buffer.alloc(10) },
      { name: ".signature.manifest", data: "{}" },
    ]);
    expect(verifyVsixSignature(vsix, short, pem).reason).toMatch(/10 bytes/);
  });

  it("names an unreadable key", () => {
    const r = verifyVsixSignature(vsix, signatureArchive(vsix, privateKey), "not a key");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/public key is not readable/);
  });
});

// A `.vsix` is a zip. Two things are read out of it here: the manifest
// (`extension/package.json`), for dependencies and packs the installer has
// to resolve first, and the whole file's digest, for the registry's
// signature archive (RFC 0020 §4.4: three entries, `.signature.sig` a
// 64-byte Ed25519 signature over the entire VSIX, `.signature.manifest`
// the sizes and SHA-256 digests, `.signature.p7s` empty).
//
// The zip reader is deliberately small — central directory, stored or
// deflated entries — so the extension bundles no archive dependency.
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";

export interface ZipEntry {
  name: string;
  compressedSize: number;
  size: number;
  method: number;
  localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The central directory of a zip held in memory. */
export function zipEntries(buf: Uint8Array): ZipEntry[] {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  // The end-of-central-directory record is at most 64 KiB + 22 bytes from the end.
  const min = Math.max(0, b.length - 65_557);
  let eocd = -1;
  for (let i = b.length - 22; i >= min; i--) {
    if (b.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== CENTRAL)
      throw new Error("corrupt zip central directory");
    const method = b.readUInt16LE(off + 10);
    const compressedSize = b.readUInt32LE(off + 20);
    const size = b.readUInt32LE(off + 24);
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const localHeaderOffset = b.readUInt32LE(off + 42);
    const name = b.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    entries.push({ name, compressedSize, size, method, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The bytes of one entry, inflated when needed; null when the name is absent. */
export function readZipEntry(buf: Uint8Array, name: string): Buffer | null {
  const entry = zipEntries(buf).find((e) => e.name === name);
  if (!entry) return null;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const lh = entry.localHeaderOffset;
  if (lh + 30 > b.length || b.readUInt32LE(lh) !== LOCAL)
    throw new Error(`corrupt zip local header for ${name}`);
  const nameLen = b.readUInt16LE(lh + 26);
  const extraLen = b.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const data = b.subarray(start, start + entry.compressedSize);
  switch (entry.method) {
    case 0:
      return Buffer.from(data);
    case 8:
      return zlib.inflateRawSync(data);
    default:
      throw new Error(
        `zip entry ${name} uses compression method ${entry.method}, which this reader does not handle`,
      );
  }
}

export interface VsixManifest {
  name: string;
  publisher: string;
  version: string;
  displayName?: string;
  engines?: Record<string, string>;
  extensionDependencies: string[];
  extensionPack: string[];
}

/** `extension/package.json` out of a VSIX. */
export function readVsixManifest(vsix: Uint8Array): VsixManifest {
  const raw = readZipEntry(vsix, "extension/package.json");
  if (!raw) throw new Error("the package has no extension/package.json — not a VSIX");
  const d = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const list = (k: string) =>
    Array.isArray(d[k])
      ? (d[k] as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  if (
    typeof d.name !== "string" ||
    typeof d.publisher !== "string" ||
    typeof d.version !== "string"
  )
    throw new Error("the VSIX manifest lacks name, publisher or version");
  return {
    name: d.name,
    publisher: d.publisher,
    version: d.version,
    displayName: typeof d.displayName === "string" ? d.displayName : undefined,
    engines:
      typeof d.engines === "object" && d.engines !== null
        ? (d.engines as Record<string, string>)
        : undefined,
    extensionDependencies: list("extensionDependencies"),
    extensionPack: list("extensionPack"),
  };
}

export interface SignatureCheck {
  ok: boolean;
  reason: string;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A public key as the registry serves it (PEM SPKI) or as the CLI prints it (64 hex chars). */
export function publicKeyObject(key: string): crypto.KeyObject {
  const t = key.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) {
    return crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(t, "hex")]),
      format: "der",
      type: "spki",
    });
  }
  return crypto.createPublicKey({ key: t, format: "pem" });
}

/**
 * Verify a signature archive against the VSIX it claims to describe. The
 * manifest is checked first — size and SHA-256 of the package — so an
 * archive that belongs to other bytes is named as such rather than as a
 * bad signature.
 */
export function verifyVsixSignature(
  vsix: Uint8Array,
  archive: Uint8Array,
  publicKey: string | crypto.KeyObject,
): SignatureCheck {
  let sig: Buffer | null;
  let manifestRaw: Buffer | null;
  try {
    sig = readZipEntry(archive, ".signature.sig");
    manifestRaw = readZipEntry(archive, ".signature.manifest");
  } catch (e) {
    return { ok: false, reason: `the signature archive is not readable: ${(e as Error).message}` };
  }
  if (!sig) return { ok: false, reason: "the signature archive has no .signature.sig" };
  if (!manifestRaw)
    return { ok: false, reason: "the signature archive has no .signature.manifest" };
  if (sig.length !== 64)
    return {
      ok: false,
      reason: `.signature.sig is ${sig.length} bytes, not the 64 of an Ed25519 signature`,
    };
  let manifest: { package?: { size?: number; digests?: { sha256?: string } } };
  try {
    manifest = JSON.parse(manifestRaw.toString("utf8"));
  } catch {
    return { ok: false, reason: ".signature.manifest is not JSON" };
  }
  const size = manifest.package?.size;
  const digest = manifest.package?.digests?.sha256;
  if (typeof size !== "number" || typeof digest !== "string")
    return { ok: false, reason: ".signature.manifest names no package size or digest" };
  if (size !== vsix.byteLength)
    return {
      ok: false,
      reason: `the manifest describes a ${size}-byte package, this one is ${vsix.byteLength}`,
    };
  const actual = crypto.createHash("sha256").update(vsix).digest("base64");
  if (actual !== digest)
    return {
      ok: false,
      reason: "the manifest's SHA-256 is not this package's — the archive belongs to other bytes",
    };
  let key: crypto.KeyObject;
  try {
    key = typeof publicKey === "string" ? publicKeyObject(publicKey) : publicKey;
  } catch (e) {
    return { ok: false, reason: `the public key is not readable: ${(e as Error).message}` };
  }
  let ok: boolean;
  try {
    ok = crypto.verify(null, vsix, key, sig);
  } catch (e) {
    return { ok: false, reason: `verification failed to run: ${(e as Error).message}` };
  }
  return ok
    ? { ok: true, reason: "Ed25519 signature verifies with the registry's key" }
    : { ok: false, reason: "the Ed25519 signature does not verify with the registry's key" };
}

export function sha256Base64(data: Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("base64");
}

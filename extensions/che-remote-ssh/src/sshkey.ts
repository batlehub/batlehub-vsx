// Reading a private key just enough to describe it.
//
// A link carries a key, and showing a user what a link contains must never
// mean showing the key. An OpenSSH private key file holds the matching
// public key in clear, before the part the passphrase protects, so the
// standard fingerprint can be computed without decrypting anything and
// without ever printing the secret half.
//
// Format, from PROTOCOL.key: "openssh-key-v1\0", then the cipher name, the
// kdf name, the kdf options, the number of keys, then each public key as a
// length-prefixed blob. Only the first public key is read here.
import { createHash } from "node:crypto";

export interface KeyDescription {
  /** e.g. `ssh-ed25519`, `ecdsa-sha2-nistp256`. */
  type: string;
  /** The `SHA256:…` form `ssh-keygen -l` prints. */
  fingerprint: string;
  /** True when the file's own key material is passphrase-protected. */
  encrypted: boolean;
}

const MAGIC = "openssh-key-v1\0";
const PEM = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/;

export class KeyError extends Error {}

/** A length-prefixed string, as every SSH wire format encodes one. */
function readString(buf: Buffer, at: number): { value: Buffer; next: number } {
  if (at + 4 > buf.length) throw new KeyError("the key ends in the middle of a field");
  const length = buf.readUInt32BE(at);
  const start = at + 4;
  if (start + length > buf.length) throw new KeyError("the key declares a field it does not hold");
  return { value: buf.subarray(start, start + length), next: start + length };
}

/**
 * Describe an OpenSSH private key. Only the public half is read, so nothing
 * that could authenticate anyone leaves this function.
 */
export function describeKey(pem: string): KeyDescription {
  const body = PEM.exec(pem);
  if (!body) throw new KeyError("this is not an OpenSSH private key");
  const blob = Buffer.from(body[1]!.replace(/\s+/g, ""), "base64");
  if (blob.subarray(0, MAGIC.length).toString("binary") !== MAGIC) {
    throw new KeyError("the key does not carry the openssh-key-v1 header");
  }
  let at = MAGIC.length;
  const cipher = readString(blob, at);
  at = cipher.next;
  const kdf = readString(blob, at);
  at = kdf.next;
  const kdfOptions = readString(blob, at);
  at = kdfOptions.next;
  if (at + 4 > blob.length) throw new KeyError("the key declares no public key");
  const count = blob.readUInt32BE(at);
  at += 4;
  if (count < 1) throw new KeyError("the key declares no public key");
  const publicKey = readString(blob, at);

  const type = readString(publicKey.value, 0).value.toString("utf8");
  const digest = createHash("sha256").update(publicKey.value).digest("base64").replace(/=+$/, "");
  return {
    type,
    fingerprint: `SHA256:${digest}`,
    encrypted: cipher.value.toString("utf8") !== "none",
  };
}

/** Describe a key, or say why it cannot be described. Never throws. */
export function describeKeySafely(pem: string): KeyDescription | { error: string } {
  try {
    return describeKey(pem);
  } catch (err) {
    return { error: err instanceof KeyError ? err.message : String(err) };
  }
}

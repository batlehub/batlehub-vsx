// The server's download (RFC 0008 revision 5): JetBrains' current
// standalone release into the satellite's storage, its sha256 checked
// against the one JetBrains publishes beside the archive, unpacked with the
// system `tar`, one version kept. No `vscode`: plain Node, tested as such.
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { run } from "@batlehub/java-rules/io";
import { parseSha256, releaseUrls, versionOfTag } from "./server";

const LATEST = "https://api.github.com/repos/Kotlin/kotlin-lsp/releases/latest";

/** The version of JetBrains' latest release, from GitHub. */
export async function latestVersion(get = fetch): Promise<string> {
  const r = await get(LATEST, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!r.ok)
    throw new Error(
      `GitHub answered ${r.status} for the latest kotlin-lsp release`,
    );
  const tag = ((await r.json()) as { tag_name?: string }).tag_name ?? "";
  const v = versionOfTag(tag);
  if (!v) throw new Error(`unexpected kotlin-lsp release tag: ${tag}`);
  return v;
}

/** `<dir>/<version>`, when that version is unpacked and complete. */
export function installed(dir: string, version: string): string | undefined {
  const home = path.join(dir, version);
  return existsSync(path.join(home, "product-info.json")) ? home : undefined;
}

/**
 * The server `version` unpacked under `dir`: downloaded when absent, its
 * sha256 checked, unpacked beside and renamed into place (a half-written
 * directory is never `installed`), every other version removed.
 */
export async function ensure(
  dir: string,
  version: string,
  progress: (m: string) => void,
  get = fetch,
): Promise<string> {
  const have = installed(dir, version);
  if (have) return have;
  mkdirSync(dir, { recursive: true });
  const { archive, sha256 } = releaseUrls(version);
  const sumResponse = await get(sha256);
  if (!sumResponse.ok)
    throw new Error(
      `no published checksum for ${version} (${sumResponse.status})`,
    );
  const expected = parseSha256(await sumResponse.text());
  if (!expected) throw new Error(`unreadable checksum for ${version}`);
  const part = path.join(dir, `${version}.tar.gz.part`);
  progress(`downloading kotlin-server ${version}`);
  const r = await get(archive);
  if (!r.ok || !r.body)
    throw new Error(`download of ${version} failed (${r.status})`);
  const hash = createHash("sha256");
  const body = Readable.fromWeb(
    r.body as import("node:stream/web").ReadableStream,
  );
  body.on("data", (c: Buffer) => hash.update(c));
  await pipeline(body, createWriteStream(part));
  const got = hash.digest("hex");
  if (got !== expected) {
    rmSync(part, { force: true });
    throw new Error(
      `kotlin-server ${version}: sha256 ${got}, JetBrains publishes ${expected} — refused`,
    );
  }
  progress(`unpacking kotlin-server ${version}`);
  const tmp = path.join(dir, `${version}.part`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  const x = await run("tar", ["xzf", part, "-C", tmp]);
  rmSync(part, { force: true });
  if (x.code !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `unpacking kotlin-server ${version} failed: ${x.stderr.trim()}`,
    );
  }
  // The archive holds one top directory; the server is its content.
  const [top] = readdirSync(tmp);
  const home = path.join(dir, version);
  rmSync(home, { recursive: true, force: true });
  renameSync(
    top && !existsSync(path.join(tmp, "product-info.json"))
      ? path.join(tmp, top)
      : tmp,
    home,
  );
  rmSync(tmp, { recursive: true, force: true });
  for (const other of readdirSync(dir))
    if (other !== version && other !== "system")
      rmSync(path.join(dir, other), { recursive: true, force: true });
  return home;
}

// The server the engine runs (RFC 0002 §4.1 "Cache", §7): the pinned
// redhat.java VSIX, downloaded once from the gallery the extension already
// trusts, its sha256 checked before anything is unpacked, unpacked with no
// entry leaving the cache. `BATLEHUB_JDTLS_HOME` skips all of it.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `MIN_REDHAT_JAVA` of java-core (§9 "Version coupling"); a test holds the two equal. */
export const PIN = {
  version: "1.56.0",
  sha256: "3c6a821d7612eb879fa40280b6c585342eec82d6b1b3e8dcfe4d0395e0624343",
};

/** The server's own floor: redhat.java 1.56's JDT.LS refuses to start below 21. */
export const SERVER_MIN_JAVA = 21;

export const cacheDir = (): string =>
  path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "batlehub",
    "jdtls",
  );

const vsixUrl = (v: string) =>
  `https://open-vsx.org/api/redhat/java/${v}/file/redhat.java-${v}.vsix`;

/** `<dir>/plugins` or `<dir>/extension/server/plugins`: the unpacked server, wherever it was pointed. */
export function serverIn(dir: string): string | undefined {
  for (const s of [dir, path.join(dir, "extension", "server")])
    if (existsSync(path.join(s, "plugins"))) return s;
  return undefined;
}

/** Where the server is, without fetching it: what `status` prints. */
export function locate(): { server?: string; from: string } {
  const home = process.env.BATLEHUB_JDTLS_HOME;
  if (home) return { server: serverIn(home), from: home };
  const dir = path.join(cacheDir(), PIN.version);
  return { server: serverIn(dir), from: dir };
}

/** A zip entry that would land outside the directory it is unpacked into. */
export function escapes(entry: string): boolean {
  return (
    path.isAbsolute(entry) ||
    /^[A-Za-z]:/.test(entry) ||
    entry.split(/[/\\]/).includes("..")
  );
}

export function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const jarTool = (jdk: string, args: string[], cwd: string) =>
  new Promise<string>((resolve, reject) =>
    execFile(
      path.join(jdk, "bin", "jar"),
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    ),
  );

/**
 * The unpacked server, fetched on first use. `jdk` unpacks it (the JDK's
 * `jar` tool: nothing else is guaranteed to be there). Throws one line.
 */
export async function ensure(
  jdk: string,
  say: (l: string) => void,
): Promise<string> {
  const { server, from } = locate();
  if (server) return server;
  if (process.env.BATLEHUB_JDTLS_HOME)
    throw new Error(
      `BATLEHUB_JDTLS_HOME=${from} holds no JDT.LS (no plugins/)`,
    );
  const vsix = `${from}.vsix`;
  mkdirSync(path.dirname(vsix), { recursive: true });
  if (!existsSync(vsix)) {
    say(
      `downloading redhat.java ${PIN.version} (once, ~55 MB) from open-vsx.org`,
    );
    const res = await fetch(vsixUrl(PIN.version));
    if (!res.ok)
      throw new Error(
        `download of redhat.java ${PIN.version}: HTTP ${res.status}`,
      );
    const part = `${vsix}.part`;
    writeFileSync(part, Buffer.from(await res.arrayBuffer()));
    renameSync(part, vsix);
  }
  const got = sha256(vsix);
  if (got !== PIN.sha256) {
    rmSync(vsix, { force: true });
    throw new Error(
      `redhat.java-${PIN.version}.vsix has sha256 ${got}, not the pinned ${PIN.sha256}: deleted, nothing unpacked`,
    );
  }
  const bad = (await jarTool(jdk, ["tf", vsix], os.tmpdir()))
    .split("\n")
    .filter((e) => e && escapes(e));
  if (bad.length)
    throw new Error(
      `the VSIX has entries outside its directory (${bad[0]}): not unpacked`,
    );
  const tmp = `${from}.unpacking`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await jarTool(jdk, ["xf", vsix], tmp);
  rmSync(from, { recursive: true, force: true });
  renameSync(tmp, from);
  const s = serverIn(from);
  if (!s)
    throw new Error(`redhat.java ${PIN.version} unpacked with no server in it`);
  return s;
}

/** The BatleHub JDT bundle: `BATLEHUB_JDT_BUNDLE`, else the one `task jdt:build` puts beside java-core. */
export function bundleJar(): string | undefined {
  const jar =
    process.env.BATLEHUB_JDT_BUNDLE ??
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "extensions",
      "java-core",
      "jdt",
      "batlehub-jdt-core.jar",
    );
  return existsSync(jar) ? jar : undefined;
}

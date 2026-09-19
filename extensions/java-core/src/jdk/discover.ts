// JDK discovery (RFC 0001 §4.2 "JDK resolution", A.1): mise, sdkman, the
// environment, the well-known directories — merged with what
// `java.configuration.runtimes` already lists. Pure: the filesystem and the
// child process are injected (`Io`), so every source is a unit test.
import type { JdkSource, Runtime } from "../api-types";

export interface Io {
  /** `undefined` when the file cannot be read. */
  readFile(path: string): string | undefined;
  /** Directory entries (names), or [] when it is not a directory. */
  readDir(path: string): string[];
  isDir(path: string): boolean;
  /** stdout, or undefined when the command failed or is absent. Argument array, never a shell string (§7). */
  exec(cmd: string, args: string[]): Promise<string | undefined>;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}

/** The `release` file every JDK ships: `JAVA_VERSION="21.0.11"`, `IMPLEMENTOR="Eclipse Adoptium"`. */
export function parseRelease(
  text: string,
): { version: string; vendor?: string } | undefined {
  const get = (k: string) => new RegExp(`^${k}="([^"]*)"`, "m").exec(text)?.[1];
  const version = get("JAVA_VERSION");
  if (!version) return undefined;
  return { version, vendor: get("IMPLEMENTOR") };
}

/** `21.0.11` → 21; `1.8.0_392` → 8; `17` → 17. */
export function majorOf(version: string): number {
  const m = /^(\d+)(?:\.(\d+))?/.exec(version);
  if (!m) return 0;
  const first = Number(m[1]);
  return first === 1 && m[2] ? Number(m[2]) : first;
}

export const runtimeName = (major: number): string =>
  major <= 8 ? `JavaSE-1.${major}` : `JavaSE-${major}`;

/** A JDK at `home`, or undefined when there is no `release` file and no `bin/java`. */
export function runtimeAt(
  io: Io,
  home: string,
  source: JdkSource,
): Runtime | undefined {
  const rel = io.readFile(`${home}/release`);
  const parsed = rel ? parseRelease(rel) : undefined;
  if (!parsed) return undefined;
  const major = majorOf(parsed.version);
  if (!major) return undefined;
  return {
    name: runtimeName(major),
    path: home,
    version: parsed.version,
    major,
    vendor: parsed.vendor,
    source,
  };
}

/** `mise ls java --json`: `[{ version, install_path, installed }]`. */
export function parseMiseLs(json: string): string[] {
  try {
    const arr = JSON.parse(json) as {
      install_path?: string;
      installed?: boolean;
    }[];
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e.installed !== false && e.install_path)
      .map((e) => e.install_path!);
  } catch {
    return [];
  }
}

async function fromMise(io: Io): Promise<Runtime[]> {
  const out = await io.exec("mise", ["ls", "java", "--json"]);
  if (!out) return [];
  return parseMiseLs(out)
    .map((p) => runtimeAt(io, p, "mise"))
    .filter((r): r is Runtime => !!r);
}

function fromSdkman(io: Io): Runtime[] {
  const base = io.env.SDKMAN_DIR || `${io.home}/.sdkman`;
  const dir = `${base}/candidates/java`;
  return io
    .readDir(dir)
    .filter((n) => n !== "current")
    .map((n) => runtimeAt(io, `${dir}/${n}`, "sdkman"))
    .filter((r): r is Runtime => !!r);
}

function fromEnv(io: Io): Runtime[] {
  const out: Runtime[] = [];
  for (const k of ["JAVA_HOME", "JDK_HOME"]) {
    const p = io.env[k];
    if (!p) continue;
    const r = runtimeAt(io, p.replace(/[/\\]+$/, ""), "env");
    if (r) out.push(r);
  }
  return out;
}

export function wellKnownDirs(io: Io): string[] {
  const dirs = [
    `${io.home}/.jdks`,
    "/usr/lib/jvm",
    "/opt/java",
    "/usr/java",
    "/usr/local/java",
  ];
  if (io.platform === "darwin") dirs.push("/Library/Java/JavaVirtualMachines");
  if (io.platform === "win32")
    dirs.push("C:\\Program Files\\Java", "C:\\Program Files\\Eclipse Adoptium");
  return dirs;
}

function fromWellKnown(io: Io): Runtime[] {
  const out: Runtime[] = [];
  for (const dir of wellKnownDirs(io)) {
    for (const n of io.readDir(dir)) {
      const home = `${dir}/${n}`;
      const r =
        runtimeAt(io, home, "wellKnown") ??
        runtimeAt(io, `${home}/Contents/Home`, "wellKnown");
      if (r) out.push(r);
    }
  }
  return out;
}

export interface SettingsRuntime {
  name: string;
  path: string;
  default?: boolean;
}

/**
 * Every runtime, deduplicated by path; the first source in `sources` wins a
 * duplicate, `settings` entries keep their own path but get a real version
 * read from disk when the directory exists.
 */
export async function discover(
  io: Io,
  sources: JdkSource[],
  settings: SettingsRuntime[] = [],
): Promise<Runtime[]> {
  const found: Runtime[] = [];
  for (const s of sources) {
    if (s === "mise") found.push(...(await fromMise(io)));
    else if (s === "sdkman") found.push(...fromSdkman(io));
    else if (s === "env") found.push(...fromEnv(io));
    else if (s === "wellKnown") found.push(...fromWellKnown(io));
  }
  for (const s of settings) {
    const path = s.path.replace(/[/\\]+$/, "");
    const r = runtimeAt(io, path, "settings");
    found.push(
      r ?? {
        name: s.name,
        path,
        version: s.name.replace(/^JavaSE-(1\.)?/, ""),
        major: majorOf(s.name.replace(/^JavaSE-/, "")),
        source: "settings",
      },
    );
  }
  const byPath = new Map<string, Runtime>();
  for (const r of found) if (!byPath.has(r.path)) byPath.set(r.path, r);
  return [...byPath.values()].sort(
    (a, b) => b.major - a.major || b.version.localeCompare(a.version),
  );
}

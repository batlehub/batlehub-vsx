// Detection is a pure function of the machine and the workspace, returning
// a JSON snapshot (RFC 0001 §4.2): jdk, build, maven, gradle, registry,
// resources. The core diffs it against the previous one and against
// overrides; re-running it never discards an override.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { JavaVersionRange, Resolution, Runtime } from "../api-types";
import { requiredJavaOf as gradleRequired } from "../build/gradle/script";
import { requiredJavaOf as mavenRequired, parsePom } from "../build/maven/pom";
import { isOverridden, readSettings, type MavenConfiguration } from "../config";
import { homeIo } from "../io";
import {
  discover,
  type Io,
  parseMiseLs,
  type SettingsRuntime,
} from "../jdk/discover";
import { availableManagers, type Manager } from "../jdk/install";
import { resolve } from "../jdk/resolve";
import { budget, type ResourceSnapshot } from "./resources";

export type Origin =
  | { kind: "detected"; source: string }
  | { kind: "override" }
  | { kind: "default" };

export interface FolderSnapshot {
  folder: string;
  tool?: "maven" | "gradle";
  buildFile?: string;
  wrapper?: string;
  required?: JavaVersionRange;
  resolution: Resolution;
  mavenProfiles: string[];
}

export interface Snapshot {
  at: string;
  runtimes: Runtime[];
  managers: Manager[];
  folders: FolderSnapshot[];
  maven: {
    configurations: MavenConfiguration[];
    origin: Origin;
    home?: string;
    version?: string;
  };
  gradle: { home?: string; wrapper: boolean };
  resources: ResourceSnapshot;
  trusted: boolean;
  origins: Record<string, Origin>;
}

const exists = (p: string) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

/** `~/.m2/settings*.xml` → one named configuration each, `settings.xml` first as `default`. */
export function detectMavenConfigurations(io: Io): MavenConfiguration[] {
  const m2 = path.join(io.home, ".m2");
  const files = io
    .readDir(m2)
    .filter((n) => /^settings.*\.xml$/.test(n))
    .sort();
  return files.map((n) => ({
    name:
      n === "settings.xml"
        ? "default"
        : n.replace(/^settings[-_.]?/, "").replace(/\.xml$/, ""),
    settingsFile: path.join(m2, n),
  }));
}

function buildOf(
  root: string,
): Pick<FolderSnapshot, "tool" | "buildFile" | "wrapper"> {
  if (exists(path.join(root, "pom.xml")))
    return {
      tool: "maven",
      buildFile: path.join(root, "pom.xml"),
      wrapper: exists(path.join(root, "mvnw"))
        ? path.join(root, "mvnw")
        : undefined,
    };
  for (const f of [
    "build.gradle.kts",
    "build.gradle",
    "settings.gradle.kts",
    "settings.gradle",
  ]) {
    if (exists(path.join(root, f)))
      return {
        tool: "gradle",
        buildFile: path.join(root, f),
        wrapper: exists(path.join(root, "gradlew"))
          ? path.join(root, "gradlew")
          : undefined,
      };
  }
  return {};
}

export function requiredOf(
  build: Pick<FolderSnapshot, "tool" | "buildFile">,
): JavaVersionRange | undefined {
  if (!build.buildFile) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(build.buildFile, "utf8");
  } catch {
    return undefined;
  }
  const r = build.tool === "maven" ? mavenRequired(text) : gradleRequired(text);
  return r ? { min: r.min, origin: r.origin } : undefined;
}

/**
 * The newest install of a mise tool as a *home* — the directory whose `bin/`
 * holds the tool. mise unpacks some distributions one level down
 * (`installs/maven/3.9.16/apache-maven-3.9.16/bin/mvn`), so the install path
 * is not always the home. `mise ls` is a home probe (§7.1), not a workspace
 * command: the tool name is ours and the cwd is the home directory.
 */
export async function miseHome(
  io: Io,
  tool: string,
  bin: string,
): Promise<string | undefined> {
  const out = await io.exec("mise", ["ls", tool, "--json"]);
  if (!out) return undefined;
  const install = parseMiseLs(out).at(-1);
  if (!install) return undefined;
  return homeWithBin(io, install, bin);
}

/** `home` when `home/bin/<bin>` exists, else the one child directory that has it. */
export function homeWithBin(
  io: Io,
  home: string,
  bin: string,
): string | undefined {
  if (io.readFile(`${home}/bin/${bin}`) !== undefined) return home;
  for (const child of io.readDir(home)) {
    if (io.readFile(`${home}/${child}/bin/${bin}`) !== undefined)
      return `${home}/${child}`;
  }
  return undefined;
}

export async function detect(trusted: boolean): Promise<Snapshot> {
  const s = readSettings();
  // Detection execs nothing the workspace controls: `mise ls … --json`,
  // `mise --version` and `sdk version`, from the home directory. §7.1 calls
  // that a fact rather than an input, so it answers before trust too — which
  // is the difference between a Restricted-Mode panel that says "JDK 21, from
  // mise" and one that says nothing at all.
  const io = homeIo();
  const settingsRuntimes = (
    vscode.workspace
      .getConfiguration("java")
      .get<SettingsRuntime[]>("configuration.runtimes") ?? []
  ).filter((r) => r && typeof r.path === "string");
  const runtimes = await discover(io, s.jdkSources, settingsRuntimes);
  const managers = await availableManagers(io);
  const folders: FolderSnapshot[] = [];
  let gradle = false;
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const build = buildOf(f.uri.fsPath);
    const required = requiredOf(build);
    let mavenProfiles: string[] = [];
    if (build.tool === "maven" && build.buildFile) {
      try {
        mavenProfiles = parsePom(
          fs.readFileSync(build.buildFile, "utf8"),
        ).profiles;
      } catch {
        /* unreadable: no profiles */
      }
    }
    if (build.tool === "gradle") gradle = true;
    folders.push({
      folder: f.uri.fsPath,
      ...build,
      required,
      resolution: resolve(runtimes, required, s.matchProject),
      mavenProfiles,
    });
  }
  const mavenOverride = isOverridden("maven.configurations");
  const mavenConfigurations = mavenOverride
    ? (s.mavenConfigurations ?? [])
    : detectMavenConfigurations(io);
  // Maven and Gradle the way the JDK is found: the environment, then the
  // manager (`mise ls <tool> --json`), because a mise shim on PATH with no
  // global version set fails rather than being absent — a task that runs
  // `mvn` from PATH there says "No version is set for shim: mvn".
  const mavenHome =
    io.env.MAVEN_HOME || io.env.M2_HOME || (await miseHome(io, "maven", "mvn"));
  const gradleHome =
    io.env.GRADLE_HOME || (await miseHome(io, "gradle", "gradle"));
  const jdtVmargs =
    vscode.workspace.getConfiguration("java").get<string>("jdt.ls.vmargs") ??
    "";
  const groovy = !!vscode.extensions.getExtension("batlehub.java-groovy");
  return {
    at: new Date().toISOString(),
    runtimes,
    managers,
    folders,
    maven: {
      configurations: mavenConfigurations,
      origin: mavenOverride
        ? { kind: "override" }
        : { kind: "detected", source: "~/.m2" },
      home: mavenHome,
    },
    gradle: {
      home: gradleHome,
      wrapper: folders.some((f) => f.tool === "gradle" && !!f.wrapper),
    },
    resources: budget({ read: io.readFile, jdtVmargs, gradle, groovy }),
    trusted,
    origins: {
      "jdk.sources": isOverridden("jdk.sources")
        ? { kind: "override" }
        : { kind: "default" },
      "jdk.installVia": isOverridden("jdk.installVia")
        ? { kind: "override" }
        : { kind: "detected", source: managers[0] ?? "none" },
      "maven.configurations": mavenOverride
        ? { kind: "override" }
        : { kind: "detected", source: "~/.m2" },
      "registry.url": isOverridden("registry.url")
        ? { kind: "override" }
        : { kind: "detected", source: "batlehub-vsx" },
    },
  };
}

/** The snapshot without home paths and user names, for `Report a problem`. */
export function redactSnapshot(
  snap: Snapshot,
  home: string,
  user: string,
): string {
  let text = JSON.stringify(snap, null, 2);
  if (home) text = text.split(home).join("~");
  if (user.length > 2) text = text.split(user).join("<user>");
  return text;
}

// Gradle behind the BuildToolProvider seam (RFC 0001 §12 phase 7): the
// subprojects of settings.gradle, the toolchain requirement, tasks and
// dependency insight from the wrapper (PATH `gradle` second), the
// `init.d/batlehub.gradle` registry link. Nothing runs untrusted.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import type { JavaVersionRange, Module } from "../../api-types";
import type { Core } from "../../extension";
import { run } from "../../io";
import { withLock } from "../../lock";
import { log } from "../../log";
import { writeOwnedFile } from "../../manifest";
import type {
  BuildDescriptor,
  BuildTask,
  BuildToolProvider,
  DependencyNode,
} from "../types";
import { includedProjects, isJavaBuild, requiredJavaOf } from "./script";
import { initScript, parseDependencies, parseTasks } from "./tasks";

const exists = (p: string) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const buildFileOf = (dir: string) =>
  ["build.gradle.kts", "build.gradle"]
    .map((f) => path.join(dir, f))
    .find(exists);

export function readModules(root: string): Module[] {
  const settings = ["settings.gradle.kts", "settings.gradle"]
    .map((f) => path.join(root, f))
    .find(exists);
  const included = settings
    ? includedProjects(fs.readFileSync(settings, "utf8"))
    : [];
  const mod = (dir: string, name: string): Module | undefined => {
    const bf = buildFileOf(dir);
    if (!bf) return undefined;
    const roots = (dirs: string[]) =>
      dirs.map((d) => path.join(dir, d)).filter(exists);
    return {
      name,
      root: dir,
      buildFile: bf,
      tool: "gradle",
      sourceRoots: roots([
        "src/main/java",
        "src/main/kotlin",
        "src/main/groovy",
      ]),
      testRoots: roots(["src/test/java", "src/test/kotlin", "src/test/groovy"]),
      resourceRoots: roots(["src/main/resources", "src/test/resources"]),
      children: [],
    };
  };
  const rootBuild = buildFileOf(root);
  const rootModule: Module = mod(root, path.basename(root)) ?? {
    name: path.basename(root),
    root,
    buildFile: settings ?? rootBuild ?? path.join(root, "build.gradle"),
    tool: "gradle",
    sourceRoots: [],
    testRoots: [],
    resourceRoots: [],
    children: [],
  };
  rootModule.children = included
    .map((p) => mod(path.join(root, p), p.replace(/\//g, ":")))
    .filter((m): m is Module => !!m);
  return [rootModule];
}

export class GradleProvider implements BuildToolProvider {
  readonly id = "gradle" as const;
  constructor(private readonly core: Core) {}

  async detect(
    folder: vscode.WorkspaceFolder,
  ): Promise<BuildDescriptor | undefined> {
    const root = folder.uri.fsPath;
    const bf =
      buildFileOf(root) ??
      ["settings.gradle.kts", "settings.gradle"]
        .map((f) => path.join(root, f))
        .find(exists);
    if (!bf) return undefined;
    return {
      tool: "gradle",
      root,
      buildFile: bf,
      wrapper: exists(path.join(root, "gradlew"))
        ? path.join(root, "gradlew")
        : undefined,
    };
  }

  async modules(desc: BuildDescriptor): Promise<Module[]> {
    return readModules(desc.root);
  }

  async requiredJava(
    desc: BuildDescriptor,
  ): Promise<JavaVersionRange | undefined> {
    for (const f of [
      desc.buildFile,
      ...readModules(desc.root)[0]!.children.map((m) => m.buildFile),
    ]) {
      try {
        const text = fs.readFileSync(f, "utf8");
        if (!isJavaBuild(text) && f !== desc.buildFile) continue;
        const r = requiredJavaOf(text);
        if (r) return r;
      } catch {
        /* next */
      }
    }
    return undefined;
  }

  private async gradle(
    desc: BuildDescriptor,
    args: string[],
  ): Promise<{ stdout: string; code: number; stderr: string }> {
    if (!this.core.trusted())
      return { stdout: "", code: 1, stderr: "untrusted workspace" };
    const cmd = desc.wrapper ?? "gradle";
    const jdk = this.core
      .snapshot()
      ?.folders.find((f) => f.folder === desc.root)?.resolution.runtime?.path;
    const env = {
      ...process.env,
      ...(jdk
        ? { JAVA_HOME: jdk, PATH: `${jdk}/bin:${process.env.PATH ?? ""}` }
        : {}),
    };
    const t0 = Date.now();
    const r = await run(cmd, ["-q", "--console=plain", ...args], {
      cwd: desc.root,
      env,
      timeout: 600_000,
    });
    log.info(
      `${path.basename(cmd)} ${args.join(" ")}: exit ${r.code} in ${Date.now() - t0} ms`,
      "Gradle",
    );
    if (r.code !== 0) log.error(r.stderr || r.stdout, "Gradle");
    return r;
  }

  async tasks(desc: BuildDescriptor): Promise<BuildTask[]> {
    const r = await this.gradle(desc, ["tasks", "--all"]);
    if (r.code !== 0)
      return ["build", "clean", "test", "assemble", "check"].map((name) => ({
        name,
        group: "task" as const,
      }));
    return parseTasks(r.stdout).map((t) => ({
      name: t.name,
      group: "task" as const,
      description: t.description ? `${t.group}: ${t.description}` : t.group,
    }));
  }

  async dependencyTree(module: Module): Promise<DependencyNode> {
    const empty: DependencyNode = {
      id: module.name,
      groupId: "",
      artifactId: module.name,
      version: "",
      children: [],
    };
    const root = this.core
      .snapshot()
      ?.folders.find((f) => module.root.startsWith(f.folder))?.folder;
    if (!root) return empty;
    const desc: BuildDescriptor = {
      tool: "gradle",
      root,
      buildFile: module.buildFile,
      wrapper: exists(path.join(root, "gradlew"))
        ? path.join(root, "gradlew")
        : undefined,
    };
    const project =
      module.root === root
        ? ""
        : `:${path.relative(root, module.root).replace(/[\\/]/g, ":")}`;
    const r = await this.gradle(desc, [
      `${project}:dependencies`.replace(/^::/, ":"),
      "--configuration",
      "runtimeClasspath",
    ]);
    if (r.code !== 0) return empty;
    return parseDependencies(r.stdout) ?? empty;
  }

  /** `~/.gradle/init.d/batlehub.gradle`, an owned file (whole file, 0600, in the manifest). */
  async configureRegistry(
    link: { url: string; token: string | null },
    enable: boolean,
  ): Promise<void> {
    const file = path.join(
      os.homedir(),
      ".gradle",
      "init.d",
      "batlehub.gradle",
    );
    await withLock(file, () => {
      if (enable) writeOwnedFile(file, initScript(link.url, link.token));
      else fs.rmSync(file, { force: true });
      log.info(`${enable ? "wrote" : "removed"} ${file}`, "Gradle");
    });
  }
}

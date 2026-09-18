// Maven behind the BuildToolProvider seam (RFC 0001 §5.2, §12 phase 5):
// modules from the POM hierarchy, the Java requirement, the lifecycle as
// tasks, the dependency tree from `dependency:tree`, the effective POM, the
// named configurations, the profiles for goals and for the import.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { JavaVersionRange, Module } from "../../api-types";
import { readSettings, type MavenConfiguration } from "../../config";
import type { Core } from "../../extension";
import { run } from "../../io";
import { withLock } from "../../lock";
import { log } from "../../log";
import {
  ensureGitignore,
  recordBlock,
  writeForeignSetting,
  writeOwnedFile,
} from "../../manifest";
import { activeMaven, commandFor } from "../tasks";
import type {
  BuildDescriptor,
  BuildTask,
  BuildToolProvider,
  DependencyNode,
} from "../types";
import { conflicts, parseTree } from "./deptree";
import { activeProfilesOf, setActiveProfiles } from "./m2e";
import { overlayOf } from "./overlay";
import { parsePom, requiredJavaOf } from "./pom";
import { MARKER, setLink, unsetLink } from "./settings";
import { MAVEN_EXTRAS, MAVEN_LIFECYCLE } from "../tasks";

const exists = (p: string) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

/** The module tree by reading POMs: `<modules>` recursively, source roots that exist. */
export function readModules(
  root: string,
  inherited: Record<string, string> = {},
): Module[] {
  const pomPath = path.join(root, "pom.xml");
  let text: string;
  try {
    text = fs.readFileSync(pomPath, "utf8");
  } catch {
    return [];
  }
  const pom = parsePom(text);
  const props = { ...inherited, ...pom.properties };
  const roots = (dirs: string[]) =>
    dirs.map((d) => path.join(root, d)).filter(exists);
  const m: Module = {
    name: pom.artifactId ?? path.basename(root),
    root,
    buildFile: pomPath,
    tool: "maven",
    sourceRoots: roots(["src/main/java"]),
    testRoots: roots(["src/test/java"]),
    resourceRoots: roots(["src/main/resources", "src/test/resources"]),
    children: pom.modules.flatMap((rel) =>
      readModules(path.join(root, rel), props),
    ),
  };
  return [m];
}

export class MavenProvider implements BuildToolProvider {
  readonly id = "maven" as const;
  constructor(private readonly core: Core) {}

  async detect(
    folder: vscode.WorkspaceFolder,
  ): Promise<BuildDescriptor | undefined> {
    const root = folder.uri.fsPath;
    if (!exists(path.join(root, "pom.xml"))) return undefined;
    return {
      tool: "maven",
      root,
      buildFile: path.join(root, "pom.xml"),
      wrapper: exists(path.join(root, "mvnw"))
        ? path.join(root, "mvnw")
        : undefined,
    };
  }

  async modules(desc: BuildDescriptor): Promise<Module[]> {
    return readModules(desc.root);
  }

  async requiredJava(
    desc: BuildDescriptor,
  ): Promise<JavaVersionRange | undefined> {
    try {
      const r = requiredJavaOf(fs.readFileSync(desc.buildFile, "utf8"));
      return r ? { ...r } : undefined;
    } catch {
      return undefined;
    }
  }

  async tasks(): Promise<BuildTask[]> {
    return [
      ...MAVEN_LIFECYCLE.map((name) => ({ name, group: "lifecycle" as const })),
      ...MAVEN_EXTRAS.map((name) => ({ name, group: "plugin" as const })),
    ];
  }

  /** `mvn dependency:tree` of one module, parsed; conflicts kept on the nodes. Runs nothing untrusted. */
  async dependencyTree(module: Module): Promise<DependencyNode> {
    const empty: DependencyNode = {
      id: module.name,
      groupId: "",
      artifactId: module.name,
      version: "",
      children: [],
    };
    if (!this.core.trusted()) return empty;
    const snap = this.core.snapshot();
    const fs0 = snap?.folders.find((f) => module.root.startsWith(f.folder));
    if (!snap || !fs0) return empty;
    const out = path.join(
      os.tmpdir(),
      "batlehub-java",
      `deptree-${process.pid}-${Date.now()}.txt`,
    );
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    const { cmd, args } = commandFor(
      {
        type: "batlehub-java",
        tool: "maven",
        goal: "dependency:tree",
        args: [`-DoutputFile=${out}`, "-DoutputType=text", "-q"],
      },
      fs0,
      activeMaven(snap),
      readSettings().mavenActiveProfiles,
    );
    const jdk = fs0.resolution.runtime?.path;
    const env = {
      ...process.env,
      ...(jdk
        ? { JAVA_HOME: jdk, PATH: `${jdk}/bin:${process.env.PATH ?? ""}` }
        : {}),
    };
    const t0 = Date.now();
    const r = await run(cmd, args, { cwd: module.root, env });
    log.info(
      `dependency:tree for ${module.name}: exit ${r.code} in ${Date.now() - t0} ms`,
      "Maven",
    );
    if (r.code !== 0) {
      log.error(`dependency:tree failed:\n${r.stderr || r.stdout}`, "Maven");
      return empty;
    }
    let text = "";
    try {
      text = fs.readFileSync(out, "utf8");
      fs.rmSync(out, { force: true });
    } catch {
      text = r.stdout;
    }
    const tree = parseTree(text) ?? empty;
    const c = conflicts(tree);
    if (Object.keys(c).length)
      log.info(
        `conflicts in ${module.name}: ${Object.entries(c)
          .map(([k, v]) => `${k} → ${v.won} (lost ${v.lost.join(", ")})`)
          .join("; ")}`,
        "Maven",
      );
    return tree;
  }

  /** `help:effective-pom` opened beside the raw POM, as a read-only document. */
  async effectivePom(module: Module): Promise<void> {
    if (!this.core.trusted()) return;
    const snap = this.core.snapshot();
    const fs0 = snap?.folders.find((f) => module.root.startsWith(f.folder));
    if (!snap || !fs0) return;
    const out = path.join(
      os.tmpdir(),
      "batlehub-java",
      `effective-${Date.now()}.xml`,
    );
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    const { cmd, args } = commandFor(
      {
        type: "batlehub-java",
        tool: "maven",
        goal: "help:effective-pom",
        args: [`-Doutput=${out}`, "-q"],
      },
      fs0,
      activeMaven(snap),
      readSettings().mavenActiveProfiles,
    );
    const jdk = fs0.resolution.runtime?.path;
    const r = await run(cmd, args, {
      cwd: module.root,
      env: { ...process.env, ...(jdk ? { JAVA_HOME: jdk } : {}) },
    });
    if (r.code !== 0) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          "Java: help:effective-pom failed — see the BatleHub Java: Maven log.",
        ),
      );
      log.error(r.stderr || r.stdout, "Maven");
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(out));
    await vscode.window.showTextDocument(doc, {
      preview: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(module.buildFile),
      vscode.Uri.file(out),
      vscode.l10n.t("{0}: raw ↔ effective POM", module.name),
    );
  }

  /** Switch the active configuration: `java.configuration.maven.userSettings` (workspace) + re-import. */
  async switchConfiguration(name: string): Promise<void> {
    const snap = this.core.snapshot();
    const cfg = snap?.maven.configurations.find((c) => c.name === name);
    if (!cfg) return;
    await vscode.workspace
      .getConfiguration("batlehub.java")
      .update(
        "maven.activeConfiguration",
        name,
        vscode.ConfigurationTarget.Workspace,
      );
    if (cfg.settingsFile)
      await writeForeignSetting(
        "java",
        "configuration.maven.userSettings",
        cfg.settingsFile,
      );
    log.info(
      `Maven configuration → ${name} (${cfg.settingsFile ?? "no settings file"}); re-import requested`,
      "Maven",
    );
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) await this.core.server.reimport(folder);
  }

  /**
   * Profiles for the import (decision 14): the m2e preference first — for
   * every module directory that has (or will have) `.settings/` — then, only
   * when `overlay` is asked for, the credential-bearing overlay of §4.2.
   */
  async applyProfiles(
    folder: vscode.WorkspaceFolder,
    profiles: string[],
    overlay = false,
  ): Promise<void> {
    const modules = readModules(folder.uri.fsPath);
    const walk = (ms: Module[]): Module[] =>
      ms.flatMap((m) => [m, ...walk(m.children)]);
    for (const m of walk(modules)) {
      const prefs = path.join(
        m.root,
        ".settings",
        "org.eclipse.m2e.core.prefs",
      );
      let before: string | undefined;
      try {
        before = fs.readFileSync(prefs, "utf8");
      } catch {
        before = undefined;
      }
      if (activeProfilesOf(before).join(",") === profiles.join(",")) continue;
      writeOwnedFile(prefs, setActiveProfiles(before, profiles));
    }
    log.info(
      `activeProfiles=${profiles.join(",")} written to ${walk(modules).length} module(s)' .settings/org.eclipse.m2e.core.prefs`,
      "Maven",
    );
    if (overlay) {
      const snap = this.core.snapshot();
      const cfg = snap ? activeMaven(snap) : undefined;
      if (!cfg?.settingsFile || !exists(cfg.settingsFile)) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            "Java: no Maven settings file to build the overlay from.",
          ),
        );
      } else {
        // The .gitignore line first, and no overlay at all if it cannot be written (§7).
        try {
          ensureGitignore(folder.uri.fsPath);
        } catch (e) {
          void vscode.window.showErrorMessage(
            vscode.l10n.t(
              "Java: the overlay carries credentials and .gitignore is not writable ({0}); nothing written.",
              (e as Error).message,
            ),
          );
          return;
        }
        const target = path.join(
          folder.uri.fsPath,
          ".batlehub",
          "java",
          "settings-overlay.xml",
        );
        writeOwnedFile(
          target,
          overlayOf(fs.readFileSync(cfg.settingsFile, "utf8"), profiles),
        );
        await writeForeignSetting(
          "java",
          "configuration.maven.userSettings",
          target,
        );
        log.info(`overlay written (0600) at ${target}`, "Maven");
      }
    }
    await this.core.server.reimport(folder);
  }

  /** The registry link in `~/.m2/settings.xml`, under the lock, in a block the core owns. */
  async configureRegistry(
    link: { url: string; token: string | null },
    enable: boolean,
  ): Promise<void> {
    const file = path.join(os.homedir(), ".m2", "settings.xml");
    await withLock(file, () => {
      let cur: string | undefined;
      try {
        cur = fs.readFileSync(file, "utf8");
      } catch {
        cur = undefined;
      }
      const next = enable
        ? setLink(cur, { url: link.url, token: link.token })
        : unsetLink(cur);
      if (next === (cur ?? "")) return;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, next, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      if (enable) recordBlock(file, MARKER);
      log.info(
        `${enable ? "wrote" : "removed"} the ${MARKER} block in ${file} (0600)`,
        "Maven",
      );
    });
  }
}

/** The remover the manifest replays for the `batlehub` block. */
export function removeMavenBlock(file: string): void {
  let cur: string;
  try {
    cur = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  fs.writeFileSync(file, unsetLink(cur));
}

export function configurationNames(list: MavenConfiguration[]): string[] {
  return list.map((c) => c.name);
}

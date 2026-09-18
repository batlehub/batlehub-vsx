// Goals and tasks through the Task API (RFC 0001 §4.2 "Running build
// commands"): a provider of type `batlehub-java`, so tasks are writable by
// hand in tasks.json and reusable as `preLaunchTask`, run in an integrated
// terminal with the resolved JDK, the active Maven configuration and the
// active profiles applied. Argument arrays, never a shell string (§7);
// nothing runs in an untrusted workspace (decision 40).
import * as vscode from "vscode";
import { readSettings, type MavenConfiguration } from "../config";
import type { FolderSnapshot, Snapshot } from "../detect";
import type { Core } from "../extension";

export interface JavaTaskDefinition extends vscode.TaskDefinition {
  type: "batlehub-java";
  tool: "maven" | "gradle";
  /** `clean package`, `dependency:tree`, `build`, `test`… */
  goal: string;
  /** Maven `-P`; absent means the workspace's active profiles. */
  profiles?: string[];
  /** Extra arguments after the goal. */
  args?: string[];
}

export const MAVEN_LIFECYCLE = [
  "clean",
  "validate",
  "compile",
  "test",
  "package",
  "verify",
  "install",
];
export const MAVEN_EXTRAS = [
  "dependency:tree",
  "help:effective-pom",
  "versions:display-dependency-updates",
];
export const GRADLE_COMMON = [
  "build",
  "clean",
  "test",
  "assemble",
  "check",
  "tasks --all",
  "dependencies",
];

/** Pure: the command line for a definition, given the folder's snapshot and the active Maven configuration. */
export function commandFor(
  def: JavaTaskDefinition,
  folder: FolderSnapshot,
  maven: MavenConfiguration | undefined,
  activeProfiles: string[] | undefined,
): { cmd: string; args: string[] } {
  if (def.tool === "maven") {
    const cmd =
      folder.wrapper ??
      (maven?.mavenHome ? `${maven.mavenHome}/bin/mvn` : "mvn");
    const args = ["-B"];
    if (maven?.settingsFile) args.push("-s", maven.settingsFile);
    if (maven?.toolchainsFile) args.push("-t", maven.toolchainsFile);
    const profiles = def.profiles ?? activeProfiles ?? maven?.profiles;
    if (profiles?.length) args.push("-P", profiles.join(","));
    args.push(...def.goal.split(/\s+/).filter(Boolean), ...(def.args ?? []));
    return { cmd, args };
  }
  const cmd = folder.wrapper ?? "gradle";
  return {
    cmd,
    args: [...def.goal.split(/\s+/).filter(Boolean), ...(def.args ?? [])],
  };
}

export function activeMaven(s: Snapshot): MavenConfiguration | undefined {
  const settings = readSettings();
  const list = s.maven.configurations;
  return (
    list.find((c) => c.name === settings.mavenActiveConfiguration) ??
    (settings.mavenActiveConfiguration ? undefined : list[0])
  );
}

export class JavaTaskProvider implements vscode.TaskProvider {
  static readonly type = "batlehub-java";
  constructor(private readonly core: Core) {}

  private make(
    def: JavaTaskDefinition,
    folder: vscode.WorkspaceFolder,
    fs: FolderSnapshot,
    snap: Snapshot,
  ): vscode.Task {
    const maven = activeMaven(snap);
    const { cmd, args } = commandFor(
      def,
      fs,
      maven,
      readSettings().mavenActiveProfiles,
    );
    const jdk = fs.resolution.runtime?.path;
    const env: Record<string, string> = { ...maven?.env };
    if (jdk) {
      env.JAVA_HOME = jdk;
      env.PATH = `${jdk}/bin${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
    }
    const exec = this.core.trusted()
      ? new vscode.ProcessExecution(cmd, args, { cwd: folder.uri.fsPath, env })
      : new vscode.ProcessExecution(process.execPath, [
          "-e",
          "console.error('BatleHub Java: nothing runs in an untrusted workspace (trust it first)'); process.exit(1)",
        ]);
    const task = new vscode.Task(
      def,
      folder,
      `${def.tool} ${def.goal}`,
      "batlehub-java",
      exec,
      def.tool === "maven" ? "$batlehub-maven" : "$gradle",
    );
    task.group = /^(test|check)\b/.test(def.goal)
      ? vscode.TaskGroup.Test
      : vscode.TaskGroup.Build;
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Shared,
      clear: true,
    };
    task.detail = `${cmd} ${args.join(" ")}${jdk ? `  (JAVA_HOME=${jdk})` : ""}`;
    return task;
  }

  provideTasks(): vscode.Task[] {
    const snap = this.core.snapshot();
    if (!snap) return [];
    const out: vscode.Task[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const fs = snap.folders.find((f) => f.folder === folder.uri.fsPath);
      if (!fs?.tool) continue;
      const goals =
        fs.tool === "maven"
          ? [...MAVEN_LIFECYCLE, ...MAVEN_EXTRAS]
          : GRADLE_COMMON;
      for (const goal of goals)
        out.push(
          this.make(
            { type: "batlehub-java", tool: fs.tool, goal },
            folder,
            fs,
            snap,
          ),
        );
    }
    return out;
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as JavaTaskDefinition;
    if (def.type !== "batlehub-java" || !def.goal || !def.tool)
      return undefined;
    const snap = this.core.snapshot();
    const folder =
      task.scope instanceof Object && "uri" in task.scope
        ? (task.scope as vscode.WorkspaceFolder)
        : vscode.workspace.workspaceFolders?.[0];
    const fs = snap?.folders.find((f) => f.folder === folder?.uri.fsPath);
    if (!snap || !folder || !fs) return undefined;
    return this.make(def, folder, fs, snap);
  }
}

/** `Java: Run a Maven goal / Gradle task…`: an input box, then the task. */
export async function runGoal(core: Core): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const fs = core
    .snapshot()
    ?.folders.find((f) => f.folder === folder?.uri.fsPath);
  if (!folder || !fs?.tool) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Java: no Maven or Gradle build in the first workspace folder.",
      ),
    );
    return;
  }
  const goals =
    fs.tool === "maven" ? [...MAVEN_LIFECYCLE, ...MAVEN_EXTRAS] : GRADLE_COMMON;
  const pick = await vscode.window.showQuickPick(
    [
      ...goals.map((g) => ({ label: g })),
      { label: "$(edit) " + vscode.l10n.t("Other…"), other: true },
    ],
    { title: vscode.l10n.t("Java: run which {0} goal?", fs.tool) },
  );
  if (!pick) return;
  let goal = pick.label;
  if ((pick as { other?: boolean }).other) {
    const typed = await vscode.window.showInputBox({
      title: vscode.l10n.t("Java: {0} goal or task", fs.tool),
      placeHolder:
        fs.tool === "maven" ? "clean verify -DskipTests" : "build -x test",
    });
    if (!typed) return;
    goal = typed;
  }
  const task = new JavaTaskProvider(core).resolveTask(
    new vscode.Task(
      { type: "batlehub-java", tool: fs.tool, goal } as JavaTaskDefinition,
      folder,
      goal,
      "batlehub-java",
    ),
  );
  if (task) await vscode.tasks.executeTask(task);
}

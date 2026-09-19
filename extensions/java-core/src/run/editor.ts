// The run-configuration editor (RFC 0001 §12 phase 4): a form over
// `launch.json` entries of type `java` — main class, project, VM args,
// program args, env, working dir, before-launch, templates, copy.
// ponytail: the "form" is the editor's own multi-step quick input rather
// than a second webview — native, themed and accessible for free; a webview
// form comes back the day a field needs layout the quick input cannot give.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Core } from "../extension";
import { log } from "../log";
import {
  duplicate,
  javaConfigs,
  type JavaLaunch,
  readLaunch,
  removeConfig,
  TEMPLATES,
  upsertConfig,
} from "./configs";

function launchPath(folder: vscode.WorkspaceFolder): string {
  return path.join(folder.uri.fsPath, ".vscode", "launch.json");
}

export function readAll(folder: vscode.WorkspaceFolder): {
  text: string | undefined;
  configs: JavaLaunch[];
} {
  try {
    const text = fs.readFileSync(launchPath(folder), "utf8");
    return { text, configs: javaConfigs(readLaunch(text)) };
  } catch {
    return { text: undefined, configs: [] };
  }
}

export function writeAll(folder: vscode.WorkspaceFolder, text: string): void {
  const p = launchPath(folder);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

/** `public static void main` classes of the workspace, by a text scan — enough for a picker; JDT.LS is not needed before indexing. */
export async function mainClasses(
  folder: vscode.WorkspaceFolder,
): Promise<{ mainClass: string; projectName: string }[]> {
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, "**/src/main/java/**/*.java"),
    "**/{target,build,node_modules}/**",
    500,
  );
  const out: { mainClass: string; projectName: string }[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f.fsPath, "utf8");
    } catch {
      continue;
    }
    if (!/public\s+static\s+void\s+main\s*\(/.test(text)) continue;
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
    const cls = path.basename(f.fsPath, ".java");
    const rel = path.relative(folder.uri.fsPath, f.fsPath);
    const projectName =
      rel.split(path.sep)[0] === "src"
        ? path.basename(folder.uri.fsPath)
        : rel.split(path.sep)[0]!;
    out.push({ mainClass: pkg ? `${pkg}.${cls}` : cls, projectName });
  }
  return out.sort((a, b) => a.mainClass.localeCompare(b.mainClass));
}

const ask = (
  title: string,
  value: string | undefined,
  prompt: string,
  placeHolder?: string,
) =>
  vscode.window.showInputBox({
    title,
    value: value ?? "",
    prompt,
    placeHolder,
    ignoreFocusOut: true,
  });

/** The form, field by field; Escape at any step leaves the file untouched. */
export async function editForm(
  folder: vscode.WorkspaceFolder,
  initial: JavaLaunch,
): Promise<JavaLaunch | undefined> {
  const c: JavaLaunch = { ...initial };
  const name = await ask(
    vscode.l10n.t("Run configuration: name"),
    c.name,
    vscode.l10n.t("Shown in the Run and Debug view"),
  );
  if (name === undefined) return undefined;
  c.name = name.trim() || c.name;
  if (c.request === "launch") {
    const mains = await mainClasses(folder);
    const pick = await vscode.window.showQuickPick(
      [
        ...mains.map((m) => ({
          label: m.mainClass,
          description: m.projectName,
          m,
        })),
        {
          label: "$(edit) " + vscode.l10n.t("Type a class name…"),
          m: undefined,
        },
      ],
      {
        title: vscode.l10n.t("Run configuration: main class"),
        ignoreFocusOut: true,
      },
    );
    if (!pick) return undefined;
    if (pick.m) {
      c.mainClass = pick.m.mainClass;
      c.projectName = pick.m.projectName;
    } else {
      const typed = await ask(
        vscode.l10n.t("Run configuration: main class"),
        c.mainClass,
        "com.example.Main",
      );
      if (typed === undefined) return undefined;
      c.mainClass = typed.trim();
      const project = await ask(
        vscode.l10n.t("Run configuration: project (module) name"),
        c.projectName,
        vscode.l10n.t("The module's artifactId / Gradle project name"),
      );
      if (project === undefined) return undefined;
      c.projectName = project.trim() || undefined;
    }
    const args = await ask(
      vscode.l10n.t("Run configuration: program arguments"),
      typeof c.args === "string" ? c.args : (c.args ?? []).join(" "),
      vscode.l10n.t("Empty for none"),
    );
    if (args === undefined) return undefined;
    if (args.trim()) c.args = args.trim();
    else delete c.args;
    const vm = await ask(
      vscode.l10n.t("Run configuration: VM arguments"),
      typeof c.vmArgs === "string" ? c.vmArgs : (c.vmArgs ?? []).join(" "),
      "-Xmx2g -Dspring.profiles.active=dev",
    );
    if (vm === undefined) return undefined;
    if (vm.trim()) c.vmArgs = vm.trim();
    else delete c.vmArgs;
    const env = await ask(
      vscode.l10n.t(
        "Run configuration: environment (KEY=value, comma-separated)",
      ),
      Object.entries(c.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(", "),
      vscode.l10n.t("Empty for none"),
    );
    if (env === undefined) return undefined;
    const entries = env
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/=(.*)/s).slice(0, 2) as [string, string]);
    if (entries.length) c.env = Object.fromEntries(entries);
    else delete c.env;
    const cwd = await ask(
      vscode.l10n.t("Run configuration: working directory"),
      c.cwd,
      "${workspaceFolder}",
    );
    if (cwd === undefined) return undefined;
    if (cwd.trim()) c.cwd = cwd.trim();
    else delete c.cwd;
    const pre = await ask(
      vscode.l10n.t(
        'Run configuration: before launch (a task label, e.g. "maven package")',
      ),
      c.preLaunchTask,
      vscode.l10n.t(
        'Empty for none; BatleHub Java tasks are named "<tool> <goal>"',
      ),
    );
    if (pre === undefined) return undefined;
    if (pre.trim()) c.preLaunchTask = pre.trim();
    else delete c.preLaunchTask;
  } else {
    const host = await ask(
      vscode.l10n.t("Attach: host"),
      c.hostName ?? "localhost",
      "localhost",
    );
    if (host === undefined) return undefined;
    c.hostName = host.trim() || "localhost";
    const port = await ask(
      vscode.l10n.t("Attach: port"),
      String(c.port ?? 5005),
      "5005",
    );
    if (port === undefined) return undefined;
    c.port = Number(port) || 5005;
  }
  return c;
}

export async function newConfig(core: Core): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const t = await vscode.window.showQuickPick(
    TEMPLATES.map((x) => ({ label: x.label, t: x })),
    { title: vscode.l10n.t("Run configuration: template") },
  );
  if (!t) return;
  const first = (await mainClasses(folder))[0];
  const draft = t.t.make({
    mainClass: first?.mainClass ?? "",
    projectName:
      (first?.projectName ?? core.snapshot()?.folders[0]?.buildFile)
        ? path.basename(folder.uri.fsPath)
        : "",
  });
  const c = await editForm(folder, draft);
  if (!c) return;
  writeAll(folder, upsertConfig(readAll(folder).text, c));
  log.info(`run configuration "${c.name}" written to launch.json`);
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Java: run configuration "{0}" written to .vscode/launch.json.',
      c.name,
    ),
  );
}

export async function editConfigs(core: Core, name?: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const { text, configs } = readAll(folder);
  let target = name ? configs.find((c) => c.name === name) : undefined;
  if (!target) {
    const pick = await vscode.window.showQuickPick(
      [
        ...configs.map((c) => ({
          label: c.name,
          description: `${c.request} ${c.mainClass ?? c.hostName ?? ""}`,
          c,
        })),
        {
          label: "$(add) " + vscode.l10n.t("New configuration…"),
          c: undefined,
        },
      ],
      { title: vscode.l10n.t("Java: run configurations") },
    );
    if (!pick) return;
    if (!pick.c) return newConfig(core);
    target = pick.c;
  }
  const action = await vscode.window.showQuickPick(
    [
      { label: "$(edit) " + vscode.l10n.t("Edit fields"), id: "edit" },
      { label: "$(copy) " + vscode.l10n.t("Copy this one"), id: "copy" },
      { label: "$(play) " + vscode.l10n.t("Run"), id: "run" },
      { label: "$(debug) " + vscode.l10n.t("Debug"), id: "debug" },
      {
        label: "$(go-to-file) " + vscode.l10n.t("Open launch.json"),
        id: "open",
      },
      { label: "$(trash) " + vscode.l10n.t("Delete"), id: "delete" },
    ],
    { title: `${target.name}` },
  );
  if (!action) return;
  switch (action.id) {
    case "edit": {
      const c = await editForm(folder, target);
      if (!c) return;
      let next = text;
      if (c.name !== target.name) next = removeConfig(next ?? "", target.name);
      writeAll(folder, upsertConfig(next, c));
      return;
    }
    case "copy":
      writeAll(folder, upsertConfig(text, duplicate(target)));
      return;
    case "run":
    case "debug":
      return startConfig(target.name, action.id === "run");
    case "open":
      await vscode.window.showTextDocument(vscode.Uri.file(launchPath(folder)));
      return;
    case "delete":
      writeAll(folder, removeConfig(text ?? "", target.name));
      return;
  }
}

export async function startConfig(
  name: string,
  noDebug: boolean,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  if (!vscode.extensions.getExtension("vscjava.vscode-java-debug")) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Java: running needs the Java debugger (vscjava.vscode-java-debug); the configuration is in launch.json for when it is installed.",
      ),
    );
    return;
  }
  const c = readAll(folder).configs.find((x) => x.name === name);
  if (!c) return;
  await vscode.debug.startDebugging(folder, {
    ...c,
    noDebug,
  } as vscode.DebugConfiguration);
}

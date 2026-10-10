// The team's `.batlehub/java/project.json` (RFC 0006) in the editor: read for
// the first workspace folder, cached by mtime, its problems on the file. The
// rules — parse, validate, the precedence — are `project-config.ts`'s; this
// side only reads the file and says where values came from. Reading needs no
// trust; *applying* does, so `appliedProject()` is empty until the workspace
// is trusted and `readSettings()` layers it under the developer's settings.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  parseProjectFile,
  resolve,
  type ProjectKey,
  type ProjectValues,
} from "@batlehub/java-rules/project-config";

export const PROJECT_FILE = ".batlehub/java/project.json";

/** project.json key → the `batlehub.java.*` setting that overrides it. */
export const SETTING_OF: Partial<Record<ProjectKey, string>> = {
  "maven.configuration": "maven.activeConfiguration",
  "maven.configurations": "maven.configurations",
  "maven.activeProfiles": "maven.activeProfiles",
  "registry.enabled": "registry.enabled",
};

type Parsed = ReturnType<typeof parseProjectFile> & { file: string };
let cache: { mtime: number; parsed: Parsed } | undefined;

/** The file as last read, or undefined when there is none. */
export function projectFile(): Parsed | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  const file = path.join(root, PROJECT_FILE);
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    cache = undefined;
    return undefined;
  }
  if (cache?.parsed.file !== file || cache.mtime !== mtime)
    cache = {
      mtime,
      parsed: { file, ...parseProjectFile(fs.readFileSync(file, "utf8")) },
    };
  return cache.parsed;
}

const home = (p: unknown) =>
  typeof p === "string" && p.startsWith("~/")
    ? path.join(os.homedir(), p.slice(2))
    : p;

/** Where the developer's answers about a repo-supplied settings file are kept (workspace scope). */
let memento: vscode.Memento | undefined;
export function useMemento(m: vscode.Memento): void {
  memento = m;
}
export const choiceKey = (file: string) =>
  `batlehub.java.repoSettingsFile:${file}`;

/**
 * Decision 8 / use case 8: the settings file — and so the credentials — a
 * committed configuration selects, and the developer's own. `repo` is set
 * only when the two differ; the file's Maven configuration then waits for
 * `Use it` before it applies.
 */
export function repoSettingsFile(
  values: ProjectValues,
): { repo: string; own: string } | undefined {
  const list = values["maven.configurations"] as
    { name: string; settingsFile?: string }[] | undefined;
  if (!Array.isArray(list)) return undefined;
  const name = values["maven.configuration"];
  const pick =
    list.find((c) => c.name === name) ?? (name ? undefined : list[0]);
  const repo = home(pick?.settingsFile) as string | undefined;
  if (!repo) return undefined;
  const c = vscode.workspace.getConfiguration("batlehub.java");
  const mine = c.get<{ name: string; settingsFile?: string }[]>(
    "maven.configurations",
  );
  const active = c.get<string>("maven.activeConfiguration");
  const own =
    (home((mine?.find((m) => m.name === active) ?? mine?.[0])?.settingsFile) as
      string | undefined) ?? path.join(os.homedir(), ".m2", "settings.xml");
  return repo === own ? undefined : { repo, own };
}

/** The project layer the editor applies: nothing before trust (§4.2), `~/` expanded, a foreign settings file only once accepted. */
export function appliedProject(): ProjectValues {
  if (!vscode.workspace.isTrusted) return {};
  const values: ProjectValues = { ...(projectFile()?.values ?? {}) };
  const cfgs = values["maven.configurations"];
  if (Array.isArray(cfgs))
    values["maven.configurations"] = cfgs.map((c) => ({
      ...c,
      settingsFile: home(c.settingsFile),
      toolchainsFile: home(c.toolchainsFile),
    }));
  const foreign = repoSettingsFile(values);
  if (foreign && memento?.get(choiceKey(foreign.repo)) !== "use") {
    delete values["maven.configurations"];
    delete values["maven.configuration"];
  }
  return values;
}

/** The developer's own layer: each key whose setting is set in some scope. */
export function settingsLayer(): ProjectValues {
  const c = vscode.workspace.getConfiguration("batlehub.java");
  const out: ProjectValues = {};
  for (const [key, setting] of Object.entries(SETTING_OF)) {
    const i = c.inspect(setting!);
    const v = i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
    if (v !== undefined) out[key as ProjectKey] = v;
  }
  return out;
}

/**
 * `Java: Show effective configuration` (§4.2): `effective`, the editor's
 * merge with an origin per key, and `project`, the same `resolve()` with no
 * settings layer — what RFC 0002's `config --print` emits.
 */
export function effectiveConfiguration(detected: ProjectValues): {
  trusted: boolean;
  effective: ReturnType<typeof resolve>;
  project: ReturnType<typeof resolve>;
} {
  const file = projectFile()?.values ?? {};
  return {
    trusted: vscode.workspace.isTrusted,
    effective: resolve(settingsLayer(), file, detected),
    project: resolve({}, file, detected),
  };
}

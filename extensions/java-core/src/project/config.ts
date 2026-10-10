// The team's `.batlehub/java/project.json` (RFC 0006) in the editor: read for
// the first workspace folder, cached by mtime, its problems on the file. The
// rules — parse, validate, the precedence — are `project-config.ts`'s; this
// side only reads the file and says where values came from. Reading needs no
// trust; *applying* does, so `appliedProject()` is empty until the workspace
// is trusted and `readSettings()` layers it under the developer's settings.
import * as fs from "node:fs";
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

/** The project layer the editor applies: nothing before trust (§4.2). */
export function appliedProject(): ProjectValues {
  return vscode.workspace.isTrusted ? (projectFile()?.values ?? {}) : {};
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

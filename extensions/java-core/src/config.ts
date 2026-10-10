// The `batlehub.java.*` settings (RFC 0001 §4.1), read once per use. An
// environment key that is absent is "detect"; a value is an override that
// wins until removed. Only taste keys have plain defaults. In a trusted
// workspace the team's project.json (RFC 0006) sits under the developer's
// settings: a key nobody set takes the file's value.
import * as vscode from "vscode";
import type { ProjectKey } from "@batlehub/java-rules/project-config";
import { appliedProject } from "./project/config";
import type { JdkSource } from "./api-types";
import type { InstallVia } from "./jdk/install";
import type { Level } from "@batlehub/java-rules/redact";
import { SHORTCUT_DEFAULTS, type ShortcutSettings } from "./generate/options";

export interface MavenConfiguration {
  name: string;
  settingsFile?: string;
  toolchainsFile?: string;
  mavenHome?: string;
  env?: Record<string, string>;
  profiles?: string[];
}

export interface Settings {
  jdkSources: JdkSource[];
  installVia: InstallVia | undefined;
  matchProject: boolean;
  logLevel: Level;
  warnBelow: string;
  budgetMiB: number;
  stopGraceMs: number;
  defaultMemoryMiB: number;
  showTerminals: boolean;
  statusBarItems: Record<string, boolean>;
  mavenConfigurations: MavenConfiguration[] | undefined;
  mavenActiveConfiguration: string | undefined;
  mavenActiveProfiles: string[] | undefined;
  registryEnabled: "ask" | "true" | "false";
  registryUrl: string;
  reportUrl: string;
  experimental: Record<string, boolean>;
  coexistence: Record<string, unknown>;
  generate: {
    getterPrefix: string;
    booleanPrefix: string;
    fluentSetters: boolean;
    finalFields: "keepSetters" | "skipSetters";
  };
  shortcuts: ShortcutSettings;
  inspections: { enabled: boolean; severityOverrides: Record<string, string> };
  completion: {
    chain: "auto" | "shortcut" | "off";
    chainBudgetMs: number;
    chainMaxDepth: number;
  };
}

export const SECTION = "batlehub.java";

export function cfg(
  scope?: vscode.ConfigurationScope,
): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION, scope);
}

/** Set by the user (any scope) rather than detected? The panel shows `set by you` / `detected: …`. */
export function isOverridden(
  key: string,
  scope?: vscode.ConfigurationScope,
): boolean {
  const i = cfg(scope).inspect(key);
  return (
    !!i &&
    (i.globalValue !== undefined ||
      i.workspaceValue !== undefined ||
      i.workspaceFolderValue !== undefined)
  );
}

export function readSettings(scope?: vscode.ConfigurationScope): Settings {
  const c = cfg(scope);
  const sources = c.get<JdkSource[]>("jdk.sources") ?? [
    "mise",
    "sdkman",
    "env",
    "wellKnown",
  ];
  const lvl = c.get<Level>("log.level") ?? "info";
  const project = appliedProject();
  /** The setting when set in any scope, else project.json's value, else the setting's default. */
  const layered = <T>(setting: string, key: ProjectKey): T | undefined =>
    !isOverridden(setting, scope) && project[key] !== undefined
      ? (project[key] as T)
      : c.get<T>(setting);
  return {
    jdkSources: sources.filter((s) =>
      ["mise", "sdkman", "env", "wellKnown"].includes(s),
    ),
    installVia: c.get<InstallVia>("jdk.installVia"),
    matchProject: c.get<boolean>("jdk.matchProject") ?? true,
    logLevel: ["error", "warn", "info", "debug", "trace"].includes(lvl)
      ? lvl
      : "info",
    warnBelow: c.get<string>("resources.warnBelow") ?? "2Gi",
    budgetMiB: c.get<number>("resources.budgetMiB") ?? 8192,
    stopGraceMs: c.get<number>("run.stopGraceMs") ?? 10000,
    defaultMemoryMiB: c.get<number>("run.defaultMemoryMiB") ?? 512,
    showTerminals: c.get<boolean>("run.showTerminals") ?? true,
    statusBarItems: c.get<Record<string, boolean>>("statusBar.items") ?? {},
    mavenConfigurations: layered<MavenConfiguration[]>(
      "maven.configurations",
      "maven.configurations",
    ),
    mavenActiveConfiguration: layered<string>(
      "maven.activeConfiguration",
      "maven.configuration",
    ),
    mavenActiveProfiles: layered<string[]>(
      "maven.activeProfiles",
      "maven.activeProfiles",
    ),
    registryEnabled:
      layered<Settings["registryEnabled"]>(
        "registry.enabled",
        "registry.enabled",
      ) ?? "ask",
    registryUrl: (c.get<string>("registry.url") ?? "").trim(),
    reportUrl: (c.get<string>("report.url") ?? "").trim(),
    experimental: c.get<Record<string, boolean>>("experimental") ?? {},
    coexistence: c.get<Record<string, unknown>>("coexistence") ?? {},
    generate: {
      getterPrefix: c.get<string>("generate.getterPrefix") ?? "get",
      booleanPrefix: c.get<string>("generate.booleanPrefix") ?? "is",
      fluentSetters: c.get<boolean>("generate.fluentSetters") ?? false,
      finalFields:
        c.get<"keepSetters" | "skipSetters">("generate.finalFields") ??
        "keepSetters",
    },
    shortcuts: {
      methodPrefix:
        c.get<ShortcutSettings["methodPrefix"]>(
          "generate.builder.methodPrefix",
        ) ?? SHORTCUT_DEFAULTS.methodPrefix,
      placement:
        c.get<ShortcutSettings["placement"]>("generate.builder.placement") ??
        SHORTCUT_DEFAULTS.placement,
      lombok:
        c.get<ShortcutSettings["lombok"]>("generate.builder.lombok") ??
        SHORTCUT_DEFAULTS.lombok,
      withersStyle:
        c.get<ShortcutSettings["withersStyle"]>("generate.withers.style") ??
        SHORTCUT_DEFAULTS.withersStyle,
      catchType:
        c.get<ShortcutSettings["catchType"]>(
          "generate.surroundWith.catchType",
        ) ?? SHORTCUT_DEFAULTS.catchType,
    },
    inspections: {
      enabled: c.get<boolean>("inspections.enabled") ?? true,
      severityOverrides:
        c.get<Record<string, string>>("inspections.severityOverrides") ?? {},
    },
    completion: {
      chain: c.get<"auto" | "shortcut" | "off">("completion.chain") ?? "auto",
      chainBudgetMs: c.get<number>("completion.chainBudgetMs") ?? 150,
      chainMaxDepth: c.get<number>("completion.chainMaxDepth") ?? 3,
    },
  };
}

/** Workspace-scope write of one of our own keys (never user scope, §4.2). */
export async function writeWorkspace(
  key: string,
  value: unknown,
  folder?: vscode.WorkspaceFolder,
): Promise<void> {
  await cfg(folder).update(
    key,
    value,
    folder
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : vscode.ConfigurationTarget.Workspace,
  );
}

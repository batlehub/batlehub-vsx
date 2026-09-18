// The `batlehub.java.*` settings (RFC 0001 §4.1), read once per use. An
// environment key that is absent is "detect"; a value is an override that
// wins until removed. Only taste keys have plain defaults.
import * as vscode from "vscode";
import type { JdkSource } from "./api-types";
import type { InstallVia } from "./jdk/install";
import type { Level } from "./redact";

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
  inspections: { enabled: boolean; severityOverrides: Record<string, string> };
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
    statusBarItems: c.get<Record<string, boolean>>("statusBar.items") ?? {},
    mavenConfigurations: c.get<MavenConfiguration[]>("maven.configurations"),
    mavenActiveConfiguration: c.get<string>("maven.activeConfiguration"),
    mavenActiveProfiles: c.get<string[]>("maven.activeProfiles"),
    registryEnabled:
      (c.get<string>("registry.enabled") as Settings["registryEnabled"]) ??
      "ask",
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
    inspections: {
      enabled: c.get<boolean>("inspections.enabled") ?? true,
      severityOverrides:
        c.get<Record<string, string>>("inspections.severityOverrides") ?? {},
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

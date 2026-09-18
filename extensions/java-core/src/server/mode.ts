// `redhat.java`'s server mode, followed and never assumed (RFC 0001 §4.2,
// decision 36): the gating table is pure; `trackServerMode` is the glue over
// the API spike (b) pinned (`serverMode`, `onDidServerModeChange`,
// `java.server.mode.switch`, `java.server.restart`).
import type * as vscode from "vscode";

export type ServerMode = "Standard" | "LightWeight" | "Hybrid";

export interface Gate {
  rename: boolean;
  generate: boolean;
  inspections: boolean;
  workspaceCommands: boolean;
  /** One line for the tooltip and the disabled menu entries. */
  reason?: string;
}

export function gate(mode: ServerMode | undefined): Gate {
  if (mode === "Standard")
    return {
      rename: true,
      generate: true,
      inspections: true,
      workspaceCommands: true,
    };
  const reason =
    mode === "LightWeight"
      ? "the Java language server runs in LightWeight mode: no rename, no generators, no inspections"
      : mode === "Hybrid"
        ? "the Java language server is still starting (Hybrid mode)"
        : "the Java language server has not reported its mode";
  return {
    rename: false,
    generate: false,
    inspections: false,
    workspaceCommands: false,
    reason,
  };
}

/** The slice of `redhat.java`'s exports the core reads (spike b). */
export interface RedHatApi {
  apiVersion?: string;
  serverMode?: ServerMode;
  onDidServerModeChange?: vscode.Event<ServerMode>;
  serverReady?: () => Promise<boolean>;
  getClasspaths?: (
    uri: string,
    options: { scope: "runtime" | "test" },
  ) => Promise<{
    projectRoot: string;
    classpaths: string[];
    modulepaths: string[];
  }>;
  onDidProjectsImport?: vscode.Event<unknown>;
  onDidClasspathUpdate?: vscode.Event<unknown>;
  status?: string;
}

/** The oldest `redhat.java` with every API spike (b) needs — decision 8, pinned here and read by the validation of §4.3. */
export const MIN_REDHAT_JAVA = "1.56.0";

export function versionAtLeast(have: string, min: string): boolean {
  const a = have.split(".").map((x) => Number(x) || 0);
  const b = min.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}

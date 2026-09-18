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

/** What `redhat.java` resolved for itself: the JRE it runs JDT.LS on, and the project default. */
export interface JavaRequirement {
  tooling_jre?: string;
  tooling_jre_version?: number;
  java_home?: string;
  java_version?: number;
}

/** The slice of `redhat.java`'s exports the core reads (spike b). */
export interface RedHatApi {
  apiVersion?: string;
  serverMode?: ServerMode;
  onDidServerModeChange?: vscode.Event<ServerMode>;
  serverReady?: () => Promise<boolean>;
  /** A promise in `redhat.java` 1.56 (api 0.14) — awaited, never read as a boolean. */
  serverRunning?: () => boolean | Promise<boolean>;
  javaRequirement?: JavaRequirement;
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
  /**
   * `redhat.java`'s own request trace: `type` is the LSP method, `duration` is
   * in milliseconds. The core reads it to *report* latency (RFC 0012 §2.1 use
   * case 3), never to act on it — the numbers go to the debug log and the
   * heavy suite's performance gate reads them from there.
   */
  onDidRequestEnd?: vscode.Event<{
    type?: string;
    duration?: number;
    resultLength?: number;
    error?: unknown;
  }>;
  status?: string;
}

/** The oldest `redhat.java` with every API spike (b) needs — decision 8, pinned here and read by the validation of §4.3. */
export const MIN_REDHAT_JAVA = "1.56.0";

/**
 * The newest `redhat.java` the nightly matrix (§13) has passed. Above it the
 * core warns and never blocks (§7.1 "Distribution"): a newer server is far
 * more likely to work than to be worth refusing, but the developer should
 * know which of the two we tested.
 */
export const TESTED_REDHAT_JAVA = "1.56.0";

export function versionAtLeast(have: string, min: string): boolean {
  const a = have.split(".").map((x) => Number(x) || 0);
  const b = min.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return true;
}

/** Strictly newer than what the nightly has passed — the "tested up to" warning. */
export function newerThanTested(have: string, tested = TESTED_REDHAT_JAVA) {
  return have !== tested && versionAtLeast(have, tested);
}

/**
 * Whether the core should write `java.jdt.ls.java.home` (revision 7, §4.2).
 *
 * The question is read off `redhat.java` itself — its activation failed, or it
 * is not running and resolved no requirement — never off the core's own scan.
 * A desktop or a CI runner has `/usr/lib/jvm`, which `redhat.java` scans and
 * the core did not count: writing there put a second JDT.LS on the same
 * `jdt_ws` and the bundle ping waited ten minutes (§15.5). A server that is
 * running is never reloaded by the core.
 *
 * The order is the point, not a detail: `running` is a *thunk* because
 * `serverRunning()` answers a promise that settles when the server does, and
 * asking it on every activation cost seven seconds of it (§15.1). It decides
 * only when `redhat.java` both activated and resolved nothing, so it is asked
 * there and nowhere else.
 */
export async function serverNeedsJdk(s: {
  activationFailed: boolean;
  javaRequirement: unknown;
  running: () => boolean | Promise<boolean>;
}): Promise<boolean> {
  if (s.activationFailed) return true;
  if (s.javaRequirement) return false;
  return !(await s.running());
}

/** Which JDK the language server itself runs on, for the panel and the tooltip. */
export function serverJdkOf(req: JavaRequirement | undefined) {
  if (!req) return undefined;
  const home = req.tooling_jre ?? req.java_home;
  if (!home) return undefined;
  const major = req.tooling_jre_version ?? req.java_version;
  return major ? `Java ${major} (${home})` : home;
}

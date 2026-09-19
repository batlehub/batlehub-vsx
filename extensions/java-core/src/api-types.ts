// The contract (RFC 0001 §5.2): what `batlehub.java-core` exports from its
// `activate`, and what a satellite imports as `api.d.ts` (generated from this
// file by `pnpm run api`). Versioned by `contractVersion`: a minor bump adds
// optional members, a major bump is a coordinated release of every satellite.
import type * as vscode from "vscode";

export interface ContractVersion {
  readonly major: number;
  readonly minor: number;
}

export type JdkSource = "mise" | "sdkman" | "env" | "wellKnown" | "settings";

export interface Runtime {
  /** `JavaSE-21`, the name `java.configuration.runtimes` uses. */
  name: string;
  path: string;
  version: string;
  major: number;
  vendor?: string;
  source: JdkSource;
}

export interface JavaVersionRange {
  min: number;
  max?: number;
  /** Where the requirement came from: `maven.compiler.release`, `toolchain`, … */
  origin: string;
}

export interface Resolution {
  runtime?: Runtime;
  required?: JavaVersionRange;
  reason: "matches" | "newest" | "none";
}

export interface JdkService {
  list(): Promise<Runtime[]>;
  resolve(folder: vscode.WorkspaceFolder): Promise<Resolution>;
  /** The JDK the language server itself runs on, once known. */
  onDidChange: vscode.Event<void>;
}

export type BuildTool = "maven" | "gradle";

export interface Module {
  name: string;
  root: string;
  buildFile: string;
  tool: BuildTool;
  sourceRoots: string[];
  testRoots: string[];
  resourceRoots: string[];
  children: Module[];
}

export interface ProjectService {
  modules(folder: vscode.WorkspaceFolder): Promise<Module[]>;
  onDidChange: vscode.Event<vscode.WorkspaceFolder>;
}

export interface RegistryLink {
  enabled(): "ask" | "true" | "false";
  /**
   * Forwarded from `batlehub-vsx`; `null` when it is absent or signed out.
   *
   * @deprecated Contract 1.0 only, and **gone in 1.1** (RFC 0001 §5.2, red
   * line 2): the registry token is written by the core, in fenced blocks, and
   * handed to no one. A satellite that needs a build tool to authenticate asks
   * for `writeCredential(target)` — a target reviewed in the core — instead of
   * holding the credential itself. The one consumer is in this repository.
   */
  token(): Promise<string | null>;
  url(): Promise<string | null>;
}

/** A language a satellite brings (Groovy, …): the core hands it the JDK and the classpath. */
export interface LanguageProvider {
  id: string;
  languages: string[];
  /** Called with the runtime the core resolved for the folder; returns a disposable server handle. */
  start(ctx: {
    runtime: Runtime | undefined;
    folder: vscode.WorkspaceFolder;
    classpath: string[];
  }): Promise<vscode.Disposable>;
}

export interface PanelTab {
  id: string;
  title: string;
  /** Plain HTML for the tab's body; `--vscode-*` tokens only. */
  html(): Promise<string> | string;
  onMessage?(message: unknown): Promise<void> | void;
}

export interface SatelliteStatusBarItem {
  id: string;
  /** Shown by default? The RFC says: only for a one-glance state. */
  defaultShown: boolean;
  text: string;
  tooltip?: string;
  command?: string;
}

export interface Inspection {
  id: string;
  title: string;
  severity: "error" | "warning" | "info" | "hint";
}

export interface InspectionBundle {
  id: string;
  inspections: Inspection[];
}

export interface JavaCoreApi {
  readonly contractVersion: ContractVersion;
  registerLanguage(provider: LanguageProvider): vscode.Disposable;
  registerPanelTab(tab: PanelTab): vscode.Disposable;
  registerStatusBarItem(item: SatelliteStatusBarItem): vscode.Disposable;
  registerInspectionBundle(bundle: InspectionBundle): vscode.Disposable;
  readonly jdk: JdkService;
  readonly project: ProjectService;
  readonly registry: RegistryLink;
  /** Throws with both versions named when the satellite's major differs from the core's. */
  assertContract(satelliteMajor: number): void;
}

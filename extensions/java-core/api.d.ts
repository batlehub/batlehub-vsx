import type * as vscode from "vscode";
export interface ContractVersion {
    readonly major: number;
    readonly minor: number;
}
export type { JavaVersionRange, JdkSource, Resolution, Runtime, } from "@batlehub/java-rules/types";
import type { Resolution, Runtime } from "@batlehub/java-rules/types";
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
    /**
     * 1.1 (RFC 0011 phase 3): a goal run as a `batlehub-java` task — its
     * terminal, the core's Maven or Gradle, `-s`, `-P`, the JDK — resolved with
     * its exit code. Rejects in an untrusted workspace.
     */
    runGoal(folder: vscode.WorkspaceFolder, goal: KindGoal): Promise<number | null>;
}
/** Open (1.1): handle a value you do not know. A new target is a reviewed change in the core. */
export type CredentialTarget = "maven-settings" | "gradle-init" | (string & {});
export interface RegistryLink {
    enabled(): "ask" | "true" | "false";
    url(): Promise<string | null>;
    /**
     * 1.1. The core writes the registry mirror and its credential — `0600`,
     * under the lock, in the manifest — into a target it knows. The token is
     * handed to no one (RFC 0001 §5.2, red line 2); `token()` left the
     * contract in 1.1. Resolves `false` when the link is not enabled or the
     * workspace is untrusted; rejects on a target the core does not know.
     */
    writeCredential(target: CredentialTarget): Promise<boolean>;
}
/** 1.1 (RFC 0001 §5.2): a satellite's foreign-setting write, in the core's one manifest. */
export interface ManifestService {
    /**
     * `"section.key"` at workspace scope, under the default-on rule of RFC 0001
     * §7.1: never over a value the user set at any scope. Resolves `false` when
     * nothing was written for that reason, or the workspace is untrusted.
     */
    writeSetting(key: string, value: unknown): Promise<boolean>;
}
/** A readiness probe (RFC 0003 §4.1); one of its kinds, or none: alive after `intervalMs`. */
export interface Probe {
    port?: number;
    http?: string;
    /** For `http`; any 2xx when absent. */
    status?: number;
    /** A regex over the process's output. */
    log?: string;
    exit?: number;
    timeoutMs?: number;
    intervalMs?: number;
}
/** RFC 0003 §6.3. */
export interface ProcessSpec {
    /** Stable: "groovy-ls", "run:<config>:<step>". */
    id: string;
    /** Never a shell string. */
    argv: [string, ...string[]];
    cwd?: string;
    env?: Record<string, string>;
    /** The declared cap: the process group's expected resident memory, not a heap. */
    memoryMiB: number;
    ready?: Probe;
    /** Tried before SIGTERM: a command, or a line written to the process's stdin (dev mode's `q`). */
    stop?: GracefulStop;
    stopGraceMs?: number;
    /** "streams": stdin/stdout are the caller's (LSP over stdio); only stderr is logged and matched. */
    stdio?: "log" | "streams";
    /** The run step kind that started it, when one did: what `running()` reports. */
    kind?: string;
}
/** 1.1: a graceful stop — a command run beside the process, or input written to it. */
export type GracefulStop = {
    cmd: string;
    args: string[];
} | {
    stdin: string;
};
/** 1.1: a managed process that is running, as `process.running()` lists it. */
export interface RunningProcess {
    id: string;
    pid: number;
    memoryMiB: number;
    kind?: string;
}
export type StopStage = "graceful" | "term" | "kill" | "exited";
export interface ManagedProcess {
    readonly id: string;
    readonly pid: number;
    readonly memoryMiB: number;
    readonly ready: Promise<void>;
    onOutput(f: (text: string) => void): () => void;
    onExit(f: (code: number | null) => void): () => void;
    readonly streams?: {
        reader: NodeJS.ReadableStream;
        writer: NodeJS.WritableStream;
    };
    stop(): Promise<{
        peakRssMiB?: number;
        stage: StopStage;
    }>;
}
/** A JVM another extension starts (RFC 0003 decision 17): counted in the sum, not managed. */
export interface Estimate {
    id: string;
    memoryMiB: number;
    label: string;
}
/** 1.1: the one start path for anything long-lived (RFC 0003). */
export interface ProcessService {
    /**
     * Rejects in an untrusted workspace, and with an Error named
     * `"SkippedForMemory"` when the user chose `Skip` over budget.
     */
    start(spec: ProcessSpec): Promise<ManagedProcess>;
    declare(estimate: Estimate): vscode.Disposable;
    /** 1.1: what is running now — a satellite's "already running" check and its tab's state. */
    running(): RunningProcess[];
    /** 1.1: a managed process started or stopped. */
    onDidChange: vscode.Event<void>;
}
/** A `launch.json` entry of any type; the core writes it with comments kept. */
export interface RunLaunch {
    type: string;
    name: string;
    request: string;
    [k: string]: unknown;
}
/** A `tasks.json` task; the core writes it by label with comments kept. */
export interface RunTask {
    label: string;
    type: string;
    [k: string]: unknown;
}
/** 1.1 (RFC 0010 §5.2, with RFC 0011's task): an entry of `Java: New run configuration`. */
export interface RunTemplate {
    id: string;
    title: string;
    /** Only offered when it returns true for the folder. */
    applies(folder: vscode.WorkspaceFolder): Promise<boolean>;
    build(folder: vscode.WorkspaceFolder): Promise<{
        launch?: RunLaunch;
        task?: RunTask;
    }>;
}
/** A `server` step of a `batlehub-run` (RFC 0003 §4.1). */
export interface ServerStep {
    server: string;
    deploy?: string;
    port?: number;
    /** `debug: true`: the kind opens JDWP on `localhost:<debugPort>` (default 5005), the core attaches. */
    debug?: boolean;
    debugPort?: number;
    jvmArgs?: string[];
    /** Appended to the kind's start command (RFC 0011 decision 12: `-Ddebug=5005`). */
    extraArgs?: string[];
    memoryMiB?: number;
    ready?: Probe;
}
/** 1.1 (RFC 0011 §5.1): a build-tool goal the core runs as every `batlehub-java` task. */
export interface KindGoal {
    tool: BuildTool;
    /** `quarkus:dev`, `bootRun`… */
    goal: string;
    args?: string[];
}
/**
 * 1.1 (RFC 0003 §6.4): pure functions the run engine calls. A kind starts
 * either a `goal` — run with the core's Maven or Gradle, `-s`, `-P` and the
 * resolved JDK, like any `batlehub-java` task — or an `argv` it builds itself.
 */
export interface RunStepKind {
    id: string;
    defaultMemoryMiB: number;
    defaultProbe(step: ServerStep): Probe;
    /** The kind's home, or undefined when it needs none. */
    locate?(): Promise<string | undefined>;
    prepare?(home: string | undefined, base: string, step: ServerStep): Promise<void>;
    goal?(step: ServerStep): KindGoal;
    argv?(home: string | undefined, base: string, jdk: Runtime | undefined, step: ServerStep): {
        cmd: string;
        args: string[];
        env?: Record<string, string>;
    };
    stop?(home: string | undefined, base: string): GracefulStop;
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
    /** 1.1 */
    readonly process: ProcessService;
    /** 1.1 */
    readonly manifest: ManifestService;
    /** 1.1 */
    registerRunTemplate(template: RunTemplate): vscode.Disposable;
    /** 1.1. The kind is kept for the run engine (RFC 0003 phases 3–4). */
    registerRunStepKind(kind: RunStepKind): vscode.Disposable;
    /** Throws with both versions named when the satellite's major differs from the core's. */
    assertContract(satelliteMajor: number): void;
}

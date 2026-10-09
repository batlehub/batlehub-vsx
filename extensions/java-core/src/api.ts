// The JavaCoreApi implementation exported from `activate` (RFC 0001 §5.2).
import * as vscode from "vscode";
import type {
  ContractVersion,
  InspectionBundle,
  JavaCoreApi,
  JdkService,
  LanguageProvider,
  ManifestService,
  PanelTab,
  ProcessService,
  ProjectService,
  RegistryLink,
  RunStepKind,
  RunTemplate,
  SatelliteStatusBarItem,
} from "./api-types";
import { log } from "./log";

export const CONTRACT: ContractVersion = { major: 1, minor: 1 };

/** Pure: the refusal of §4.3, with both versions named. */
export function checkContract(
  core: ContractVersion,
  satelliteMajor: number,
): string | undefined {
  if (satelliteMajor === core.major) return undefined;
  return `satellite contract major ${satelliteMajor} does not match the core's ${core.major}.${core.minor}; both must be released together`;
}

export interface Registries {
  languages: Map<string, LanguageProvider>;
  tabs: Map<string, PanelTab>;
  bundles: Map<string, InspectionBundle>;
  templates: Map<string, RunTemplate>;
  /** Read by the run engine (RFC 0003 phases 3–4), not before. */
  kinds: Map<string, RunStepKind>;
  onDidChange: vscode.EventEmitter<void>;
}

export function makeApi(deps: {
  jdk: JdkService;
  project: ProjectService;
  registry: RegistryLink;
  process: ProcessService;
  manifest: ManifestService;
  statusBar: (item: SatelliteStatusBarItem) => vscode.Disposable;
  onLanguage: (p: LanguageProvider) => Promise<vscode.Disposable>;
}): { api: JavaCoreApi; registries: Registries } {
  const registries: Registries = {
    languages: new Map(),
    tabs: new Map(),
    bundles: new Map(),
    templates: new Map(),
    kinds: new Map(),
    onDidChange: new vscode.EventEmitter(),
  };
  const add = <T extends { id: string }>(
    map: Map<string, T>,
    item: T,
    extra?: () => Promise<vscode.Disposable>,
  ): vscode.Disposable => {
    map.set(item.id, item);
    registries.onDidChange.fire();
    let inner: vscode.Disposable | undefined;
    void extra?.().then((d) => (inner = d));
    return new vscode.Disposable(() => {
      map.delete(item.id);
      inner?.dispose();
      registries.onDidChange.fire();
    });
  };
  // `project` and `registry` are replaced by the real services once the
  // build providers are wired (build/index.ts), so the object is mutable.
  const api: JavaCoreApi = {
    contractVersion: CONTRACT,
    registerLanguage: (p) =>
      add(registries.languages, p, () => deps.onLanguage(p)),
    registerPanelTab: (t) => add(registries.tabs, t),
    registerStatusBarItem: (i) => deps.statusBar(i),
    registerInspectionBundle: (b) => add(registries.bundles, b),
    jdk: deps.jdk,
    project: deps.project,
    registry: deps.registry,
    process: deps.process,
    manifest: deps.manifest,
    registerRunTemplate: (t) => add(registries.templates, t),
    registerRunStepKind: (k) => add(registries.kinds, k),
    assertContract: (major) => {
      const problem = checkContract(CONTRACT, major);
      if (problem) {
        log.error(`contract refused: ${problem}`);
        void vscode.window.showErrorMessage(
          vscode.l10n.t("BatleHub Java: {0}", problem),
        );
        throw new Error(problem);
      }
    },
  };
  return { api, registries };
}

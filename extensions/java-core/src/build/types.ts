// The build-tool seam of RFC 0001 §5.2 — internal to the core until phase 9.
import type * as vscode from "vscode";
import type { BuildTool, JavaVersionRange, Module } from "../api-types";

export interface BuildDescriptor {
  tool: BuildTool;
  root: string;
  buildFile: string;
  /** `mvnw` / `gradlew` beside the build file, when present. */
  wrapper?: string;
}

export interface BuildTask {
  /** `clean`, `test`, `dependency:tree`, `build`… */
  name: string;
  group: "lifecycle" | "plugin" | "task";
  description?: string;
}

export interface DependencyNode {
  id: string;
  groupId: string;
  artifactId: string;
  version: string;
  scope?: string;
  /** The version that lost to `version` (Maven's "omitted for conflict with"). */
  conflict?: string;
  omitted?: "duplicate" | "conflict";
  children: DependencyNode[];
}

export interface BuildToolProvider {
  readonly id: BuildTool;
  detect(folder: vscode.WorkspaceFolder): Promise<BuildDescriptor | undefined>;
  modules(desc: BuildDescriptor): Promise<Module[]>;
  requiredJava(desc: BuildDescriptor): Promise<JavaVersionRange | undefined>;
  tasks(desc: BuildDescriptor): Promise<BuildTask[]>;
  dependencyTree(module: Module): Promise<DependencyNode>;
  configureRegistry?(
    link: { url: string; token: string | null },
    enable: boolean,
  ): Promise<void>;
}

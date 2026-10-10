// What a JDK is, for the extension and the engine alike (RFC 0001 §4.2,
// RFC 0002 decision 7). `java-core`'s api-types re-exports these: they are
// part of the satellite contract, so a change here is a contract change.

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

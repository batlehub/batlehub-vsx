// What the engine reads (RFC 0002 decision 10): the committed
// `.batlehub/java/` files and nothing else — never a settings.json. The same
// shared functions as the editor, called with an empty settings layer, so
// CI and the editor's `project` view agree (RFC 0005 phase 4, RFC 0006 §4.2).
import { existsSync } from "node:fs";
import path from "node:path";
import {
  GRADLE_BUILD_FILES,
  requiredJavaOf as gradleRequired,
} from "@batlehub/java-rules/gradle-script";
import { requiredJavaOf as mavenRequired } from "@batlehub/java-rules/pom";
import {
  BRIDGED_DEFAULTS,
  parseProfile,
  PROFILE,
  validate,
  type Level,
  type ProfileProblem,
  type Severity,
} from "@batlehub/java-rules/profile";
import {
  parseProjectFile,
  PROJECT_FILE,
  resolve,
  type ProjectProblem,
  type ProjectValues,
} from "@batlehub/java-rules/project-config";

/**
 * Where the committed `.batlehub/java/` is: the workspace root or the first
 * folder above it that has one, never past the repository's `.git`. `inspect
 * core` in a multi-module build starts the server on `core/`, while the team
 * commits its files at the root, where the editor reads them.
 */
export function committedBase(root: string): string {
  for (let d = root; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".batlehub", "java"))) return d;
    if (existsSync(path.join(d, ".git")) || path.dirname(d) === d) return root;
  }
}

/** The bundle's answer to `batlehub.ping`: its rule ids and their default levels. */
export interface BundleRules {
  inspections?: string[];
  defaults?: Record<string, Severity>;
}

export interface TeamProfile {
  /** The file read; undefined when the workspace commits none. */
  file?: string;
  /** code → the team's level, over the bundle's defaults. */
  levels: Record<string, Level>;
  reasons: Record<string, string>;
  /** Rows the editor would put on the file; the profile still applies without those entries. */
  problems: ProfileProblem[];
  known: string[];
  defaults: Record<string, Severity>;
}

/**
 * The team's inspection profile, validated against the running bundle as
 * the editor does. `file` is `--profile`; without it, the committed one or
 * none. A file that is no profile at all (§4.3's hard errors) throws: a CI
 * gate on a broken profile must fail, not pass at the defaults.
 */
export function teamProfile(
  root: string,
  bundle: BundleRules | undefined,
  read: (p: string) => string | undefined,
  file?: string,
): TeamProfile {
  const known = bundle?.inspections ?? [];
  const defaults = { ...BRIDGED_DEFAULTS, ...bundle?.defaults };
  const f = file ? path.resolve(file) : path.join(committedBase(root), PROFILE);
  const text = read(f);
  const none = { levels: {}, reasons: {}, problems: [], known, defaults };
  if (text === undefined) {
    if (file) throw new Error(`${file}: no such profile`);
    return none;
  }
  const { profile, lines, problems } = parseProfile(text);
  if (!profile)
    throw new Error(
      `${f}: not an inspection profile — ${problems.map((p) => `line ${p.line + 1}: ${p.message}`).join("; ")}`,
    );
  const v = validate(profile, lines, known, defaults);
  return {
    file: f,
    levels: v.merged,
    reasons: v.reasons,
    problems: [...problems, ...v.problems],
    known,
    defaults,
  };
}

/** `--print-profile`: every rule the bundle knows, at its effective level, and where that level comes from. */
export function printedProfile(p: TeamProfile) {
  const codes = [...new Set([...p.known, ...Object.keys(p.levels)])].sort();
  return {
    file: p.file ?? null,
    rules: Object.fromEntries(
      codes.map((c) => [
        c,
        {
          level: p.levels[c] ?? p.defaults[c] ?? "error",
          origin: p.levels[c] !== undefined ? "profile" : "default",
          default: p.defaults[c] ?? "error",
          ...(p.reasons[c] ? { why: p.reasons[c] } : {}),
        },
      ]),
    ),
  };
}

/** The Java floor the build file declares, read as detection reads it (`jdk.requirement`). */
export function requiredJava(
  root: string,
  read: (p: string) => string | undefined,
): number | undefined {
  const pom = read(path.join(root, "pom.xml"));
  if (pom !== undefined) return mavenRequired(pom)?.min;
  const gradle = GRADLE_BUILD_FILES.map((f) => path.join(root, f)).find((f) =>
    existsSync(f),
  );
  const text = gradle ? read(gradle) : undefined;
  return text === undefined ? undefined : gradleRequired(text)?.min;
}

/**
 * `config --print`: the editor's `project` object (`Java: Show effective
 * configuration`), byte for byte — `resolve()` with no settings layer over
 * project.json and the build file's requirement.
 */
export function projectConfig(
  root: string,
  read: (p: string) => string | undefined,
): {
  config: ReturnType<typeof resolve>;
  problems: ProjectProblem[];
  file: string;
} {
  const file = path.join(committedBase(root), PROJECT_FILE);
  const text = read(file);
  const parsed = text === undefined ? undefined : parseProjectFile(text);
  const min = requiredJava(root, read);
  const detected: ProjectValues =
    min === undefined ? {} : { "jdk.requirement": String(min) };
  return {
    config: resolve({}, parsed?.values ?? {}, detected),
    problems: parsed?.problems ?? [],
    file,
  };
}

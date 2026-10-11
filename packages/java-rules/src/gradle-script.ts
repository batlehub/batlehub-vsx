// What the core reads out of a Gradle build without Gradle: the toolchain
// requirement, the subprojects of `settings.gradle[.kts]`, the plugins that
// mark a Java module. Pure scanning; Gradle itself answers the rest (phase 7).

/** The files that make a folder a Gradle build, in the order detection reads them. */
export const GRADLE_BUILD_FILES = [
  "build.gradle.kts",
  "build.gradle",
  "settings.gradle.kts",
  "settings.gradle",
] as const;

const clean = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

/** `toolchain { languageVersion = JavaLanguageVersion.of(21) }`, `sourceCompatibility = 17`, `JavaVersion.VERSION_1_8`. */
export function requiredJavaOf(
  text: string,
): { min: number; origin: string } | undefined {
  const s = clean(text);
  const tc = /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(s);
  if (tc) return { min: Number(tc[1]), origin: "toolchain languageVersion" };
  // Kotlin's shorthand for the same toolchain (RFC 0008 phase 2).
  const kt = /\bjvmToolchain\(\s*(\d+)\s*\)/.exec(s);
  if (kt) return { min: Number(kt[1]), origin: "kotlin jvmToolchain" };
  const compat =
    /(?:sourceCompatibility|targetCompatibility)\s*=?\s*(?:JavaVersion\.VERSION_(\d+)(?:_(\d+))?|['"]?(?:1\.)?(\d+)['"]?)/.exec(
      s,
    );
  if (compat) {
    const n = compat[2] ? Number(compat[2]) : Number(compat[1] ?? compat[3]);
    return { min: n, origin: "sourceCompatibility" };
  }
  const release = /options\.release(?:\.set\(|\s*=\s*)(\d+)/.exec(s);
  if (release) return { min: Number(release[1]), origin: "options.release" };
  return undefined;
}

/** `include 'app', ':lib'` / `include("app", "lib")` → `["app", "lib"]`. */
export function includedProjects(settings: string): string[] {
  const out: string[] = [];
  for (const m of clean(settings).matchAll(
    /include\s*\(?\s*((?:['"][^'"]+['"]\s*,?\s*)+)\)?/g,
  )) {
    for (const q of m[1]!.matchAll(/['"]:?([^'"]+)['"]/g))
      out.push(q[1]!.replace(/:/g, "/"));
  }
  return [...new Set(out)];
}

export function isJavaBuild(script: string): boolean {
  return /(?:\bkotlin\s*\(\s*["']jvm["']\s*\)|id\s*\(?\s*['"]org\.jetbrains\.kotlin\.jvm['"]|id\s*\(?\s*['"](?:java|java-library|application|groovy)['"]|apply\s+plugin:\s*['"](?:java|java-library|groovy)['"]|\bjava\b\s*\{|`java-library`|\bjava-library\b)/.test(
    clean(script),
  );
}

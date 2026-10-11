// The pure parts of the Kotlin satellite (RFC 0008 §6.1, revision 5): which
// release, where it comes from, the argument array it runs with, the state →
// status text. Tested as plain Node; `extension.ts` and `fetch.ts` do the I/O.
//
// Revision 5: JetBrains' server is downloaded on first use, not bundled — a
// build stops working about four weeks after its release ("This build of
// kotlin-server has expired"), and it needs Java 25, which its own JBR
// provides. §11 records the measurements.
import path from "node:path";

export type State =
  | "stopped"
  | "downloading"
  | "starting"
  | "running"
  | "failed"
  | "expired"
  | "untrusted"
  | "disabled";

/** The contract major this satellite was written against (RFC 0001 §5.2). */
export const CONTRACT_MAJOR = 1;

/**
 * The cap declared to the core's managed process (RFC 0003 §4.2, decision
 * 14 here): the measured process tree — the server at `-Xmx1G` plus the
 * Gradle and Kotlin daemons it starts — not the server's heap.
 */
export const DECLARED_MIB = 2800;

const RELEASES = "https://download.jetbrains.com/language-server/kotlin-server";

/** The release archive and its published checksum, by version (`263.6379.0`). */
export function releaseUrls(version: string): {
  archive: string;
  sha256: string;
} {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`not a kotlin-server version: ${version}`);
  const archive = `${RELEASES}/${version}/kotlin-server-${version}.tar.gz`;
  return { archive, sha256: `${archive}.sha256` };
}

/** The version of GitHub's latest `Kotlin/kotlin-lsp` release (`kotlin-lsp/v263.6379.0`). */
export function versionOfTag(tag: string): string | undefined {
  return /^kotlin-lsp\/v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
}

/** `<hex>  <file>` or `<hex> *<file>`, as `sha256sum` writes it. */
export function parseSha256(text: string): string | undefined {
  return /^([0-9a-f]{64})\b/.exec(text.trim())?.[1];
}

export interface ProductInfo {
  minRequiredJavaVersion?: number;
  launch: {
    os: string;
    javaExecutablePath?: string;
    vmOptionsFilePath: string;
    bootClassPathJarNames: string[];
    additionalJvmArguments: string[];
    mainClass: string;
  }[];
}

/**
 * The server's own launch, from its `product-info.json` and VM options file:
 * its JBR, its boot class path and JVM arguments (`$IDE_HOME` expanded), its
 * main class, `--stdio`. An argument array, never a shell string (§7). The
 * heap is ours (`-Xmx1G`, decision 5): the file's `-Xms`/`-Xmx` are dropped.
 */
export function launch(
  home: string,
  info: ProductInfo,
  vmOptions: string,
  o: { xmx: string; extra: string[]; systemPath: string },
): { command: string; args: string[] } {
  const l = info.launch.find((x) => x.os === "Linux") ?? info.launch[0];
  if (!l) throw new Error("product-info.json has no launch entry");
  const expand = (s: string) => s.replaceAll("$IDE_HOME", home);
  const vm = vmOptions
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#") && !/^-Xm[sx]/.test(s));
  return {
    command: path.join(home, l.javaExecutablePath ?? "jbr/bin/java"),
    args: [
      `-Xmx${o.xmx}`,
      ...vm,
      ...l.additionalJvmArguments.map(expand),
      ...o.extra,
      "-cp",
      l.bootClassPathJarNames.map((j) => path.join(home, "lib", j)).join(":"),
      l.mainClass,
      "--stdio",
      "--system-path",
      o.systemPath,
    ],
  };
}

/** The server's own refusal once its build is past its date. */
export function isExpired(log: string): boolean {
  return /has expired|EAP build has expired/.test(log);
}

export function statusText(state: State): { text: string; tooltip: string } {
  const glyph =
    state === "running"
      ? "$(check)"
      : state === "starting" || state === "downloading"
        ? "$(sync~spin)"
        : state === "failed" || state === "expired"
          ? "$(error)"
          : "$(circle-slash)";
  const why: Record<State, string> = {
    stopped: "Kotlin language server: stopped",
    downloading:
      "Kotlin language server: downloading JetBrains' current release",
    starting: "Kotlin language server: starting",
    running: "Kotlin language server: running",
    failed: "Kotlin language server failed to start (see the log)",
    expired:
      "Kotlin language server: this release has expired — Restart fetches the current one",
    untrusted: "Kotlin language server: not started in an untrusted workspace",
    disabled: "Kotlin language server: off (batlehub.java.kotlin.enabled)",
  };
  return { text: `${glyph} Kotlin`, tooltip: why[state] };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** The panel tab's body: plain HTML on the core's tokens, escaped here. */
export function tabHtml(p: {
  state: State;
  version?: string;
  home?: string;
  jdk?: string;
  classpath: number;
}): string {
  return `<section aria-labelledby="h-kotlin"><h2 id="h-kotlin">Kotlin language server</h2>
<p>State: <b>${esc(statusText(p.state).tooltip)}</b></p>
<ul><li>Server: JetBrains kotlin-server ${esc(p.version ?? (p.home ? "configured" : "not downloaded yet"))}${p.home ? ` (${esc(p.home)})` : ""}, on its own Java 25</li><li>The project's JDK: ${esc(p.jdk ?? "none resolved")}</li><li>Classpath entries handed by the core: ${p.classpath}</li><li>Memory declared: ${DECLARED_MIB} MiB — the server and the Gradle and Kotlin daemons it starts</li></ul>
<p class="muted">.kt and .kts (build.gradle.kts) are served by the same server. The first diagnostic of a session can take a minute: the analyser is warming up.</p>
<div class="row"><button data-cmd="batlehub.java.kotlin.restart">Restart</button> <button data-cmd="batlehub.java.kotlin.showLog">Show the log</button></div>
</section>`;
}

// The pure parts of the satellite (RFC 0001 §6.3): the argument array the
// server is launched with, the settings it reads, the state → status bar
// text. Tested as plain Node; `extension.ts` is the glue.

export type State =
  "stopped" | "starting" | "running" | "failed" | "no-jdk" | "untrusted";

/** `<jdk>/bin/java -jar <jar>` — an argument array, never a shell string (§7). */
export function launch(
  jdkPath: string,
  jar: string,
): { command: string; args: string[] } {
  return { command: `${jdkPath}/bin/java`, args: ["-jar", jar] };
}

/** What `workspace/didChangeConfiguration` carries: the server reads `groovy.classpath`. */
export function settingsFor(classpath: string[]): {
  groovy: { classpath: string[] };
} {
  return { groovy: { classpath } };
}

export function statusText(state: State): { text: string; tooltip: string } {
  const glyph =
    state === "running"
      ? "$(check)"
      : state === "starting"
        ? "$(sync~spin)"
        : state === "failed"
          ? "$(error)"
          : "$(circle-slash)";
  const why: Record<State, string> = {
    stopped: "Groovy language server: stopped",
    starting: "Groovy language server: starting",
    running: "Groovy language server: running",
    failed:
      "Groovy language server failed to start — Groovy files keep their syntax colouring (see the log)",
    "no-jdk": "Groovy language server: no JDK resolved by BatleHub Java",
    untrusted: "Groovy language server: not started in an untrusted workspace",
  };
  return { text: `${glyph} Groovy`, tooltip: why[state] };
}

/** The contract major this satellite was written against (RFC 0001 §5.2). */
export const CONTRACT_MAJOR = 1;

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
  jdk?: string;
  classpath: number;
  jar: string;
}): string {
  return `<section aria-labelledby="h-groovy"><h2 id="h-groovy">Groovy language server</h2>
<p>State: <b>${esc(statusText(p.state).tooltip)}</b></p>
<ul><li>JDK: ${esc(p.jdk ?? "none resolved")}</li><li>Classpath entries handed by the core: ${p.classpath}</li><li>Server: ${esc(p.jar)}</li></ul>
<p class="muted">Gradle DSL (*.gradle) and Jenkinsfile open as Groovy; the same server answers all three.</p>
<div class="row"><button data-cmd="batlehub.java.groovy.restart">Restart</button> <button data-cmd="batlehub.java.groovy.showLog">Show the log</button></div>
</section>`;
}

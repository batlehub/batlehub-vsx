// The pure half of the Quarkus satellite (RFC 0011 §6.1): detection from a
// build file, the dev port from application.properties, the bridge's rule,
// the `quarkus-dev` run step kind and the run template. Nothing here imports
// `vscode`; `extension.ts` reads the files and the settings and hands them in.
import type {
  GracefulStop,
  KindGoal,
  Probe,
  RunLaunch,
  ServerStep,
} from "../../java-core/api";

export const CONTRACT_MAJOR = 1;
export const KIND = "quarkus-dev";
export const TEMPLATE_NAME = "Quarkus dev mode";

export interface Detected {
  tool: "maven" | "gradle";
  /** The BOM's or the plugin's version, when the build file names one. */
  version?: string;
  /** The BOM's group: `io.quarkus.platform` or `io.quarkus` — where its descriptor lives. */
  group?: string;
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];

/**
 * §4.2: a `quarkus-bom` import (platform or core) or the `quarkus-maven-plugin`.
 * `${property}` versions are resolved from the POM's own `<properties>`.
 */
export function detectPom(xml: string): Detected | undefined {
  const props = /<properties>([\s\S]*?)<\/properties>/.exec(xml)?.[1] ?? "";
  const resolve = (v: string | undefined) => {
    const m = v && /^\$\{([^}]+)\}$/.exec(v);
    return m ? tag(props, m[1]!.replace(/\./g, "\\.")) : v;
  };
  for (const block of xml.match(/<(dependency|plugin)>[\s\S]*?<\/\1>/g) ?? []) {
    // `quarkus create app` names the BOM through properties, not literally.
    const g = resolve(tag(block, "groupId"));
    const a = resolve(tag(block, "artifactId"));
    const bom =
      a === "quarkus-bom" &&
      (g === "io.quarkus.platform" || g === "io.quarkus");
    const plugin = a === "quarkus-maven-plugin";
    if (bom || plugin)
      return {
        tool: "maven",
        version: resolve(tag(block, "version")),
        group: bom ? g : "io.quarkus.platform",
      };
  }
  return undefined;
}

/** §4.2: `id 'io.quarkus'` in `plugins {}`, or `enforcedPlatform("…:quarkus-bom:…")`. */
export function detectGradle(script: string): Detected | undefined {
  const platform =
    /enforcedPlatform\(\s*["']io\.quarkus(?:\.platform)?:quarkus-bom:([^"']+)["']/.exec(
      script,
    );
  if (platform)
    return {
      tool: "gradle",
      version: platform[1]!.includes("$") ? undefined : platform[1],
    };
  if (/\bid\s*\(?\s*["']io\.quarkus["']/.test(script))
    return { tool: "gradle" };
  return undefined;
}

/** `quarkus create app --gradle` keeps the platform in `gradle.properties`. */
export function gradlePlatform(properties: string | undefined): {
  version?: string;
  group?: string;
} {
  const p = parseProperties(properties ?? "");
  return {
    version: p.get("quarkusPlatformVersion"),
    group: p.get("quarkusPlatformGroupId"),
  };
}

/** `application.properties` → key/value, `#`/`!` comments and `key: value` included. */
export function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

/** §4.1 `devPort: 0`: `%dev.quarkus.http.port`, then `quarkus.http.port`, then 8080. */
export function devPort(
  properties: string | undefined,
  setting: number,
): number {
  if (setting > 0) return setting;
  const p = parseProperties(properties ?? "");
  const v = Number(
    p.get("%dev.quarkus.http.port") ?? p.get("quarkus.http.port"),
  );
  return Number.isInteger(v) && v > 0 ? v : 8080;
}

/** `JAVA_VERSION="21.0.11"` of a JDK's `release` file → 21; `1.8.0` → 8. */
export function releaseMajor(release: string | undefined): number | undefined {
  const v = /^JAVA_VERSION="([^"]+)"/m.exec(release ?? "")?.[1];
  if (!v) return undefined;
  const [a, b] = v.split(".").map(Number);
  return a === 1 ? b : a;
}

/**
 * What `redhat.vscode-microprofile` 0.18.0 reads for its server's JDK:
 * `java.home` (redhat.java still registers it, deprecated in favour of
 * `java.jdt.ls.java.home`, which wins for JDT.LS — so writing it does not move
 * the language server), then `JDK_HOME`, `JAVA_HOME`, `PATH`. The RFC's
 * `microprofile.tools.server.java.home` does not exist.
 */
export const BRIDGE_KEY = "java.home";
/** The MicroProfile server refuses anything older ("Java 21 or more recent is required"). */
export const BRIDGE_MIN_MAJOR = 21;

/**
 * §4.1 `bridge: auto`: write the key only when the MicroProfile extension is
 * installed, the key is unset, and neither `JDK_HOME`/`JAVA_HOME` nor the
 * first `java` on `PATH` is a JDK ≥ 21.
 */
export function needsBridge(f: {
  bridge: string;
  installed: boolean;
  keySet: boolean;
  javaHomeMajor?: number;
  pathJavaMajor?: number;
}): boolean {
  if (f.bridge === "never" || !f.installed || f.keySet) return false;
  return !(
    (f.javaHomeMajor ?? 0) >= BRIDGE_MIN_MAJOR ||
    (f.pathJavaMajor ?? 0) >= BRIDGE_MIN_MAJOR
  );
}

export interface KindSettings {
  devMemoryMiB: number;
  devPort: number;
  debugPort: number;
  readiness: string;
  tool: "maven" | "gradle";
  /** The project's `application.properties`, read when asked. */
  properties(): string | undefined;
}

/**
 * The `quarkus-dev` kind (§4.2): the core runs `quarkus:dev` as any
 * `batlehub-java` task, with a declared cap; ready on the health path, or on
 * `Listening on:` when it is "" — dev mode's first start compiles, so the
 * probe waits five minutes; stopped by dev mode's own `q`, then the core's
 * SIGTERM to the group.
 */
export function makeKind(s: () => KindSettings) {
  return {
    id: KIND,
    get defaultMemoryMiB() {
      return s().devMemoryMiB;
    },
    defaultProbe(step: ServerStep): Probe {
      const k = s();
      const port = step.port ?? devPort(k.properties(), k.devPort);
      return k.readiness
        ? { http: `http://localhost:${port}${k.readiness}`, timeoutMs: 300_000 }
        : { log: "Listening on:", timeoutMs: 300_000 };
    },
    goal(step: ServerStep): KindGoal {
      const k = s();
      // Dev mode opens 5005 unless told not to: an agent nobody attaches to is
      // an open port. Gradle's quarkusDev takes the same system property
      // (decision 11, measured in phase 3).
      const debug = step.debug
        ? `-Ddebug=${step.debugPort ?? k.debugPort}`
        : "-Ddebug=false";
      return {
        tool: k.tool,
        goal: k.tool === "maven" ? "quarkus:dev" : "quarkusDev",
        args: [debug],
      };
    },
    stop(): GracefulStop {
      return { stdin: "q\n" };
    },
  };
}

/**
 * The template's entry, and the tab's `Start`: a `batlehub-run` of one
 * `quarkus-dev` step. `Debug` is the same step with `debug: true` — the kind
 * opens JDWP on `debugPort` and the core attaches on localhost (§4.2).
 */
export function devLaunch(port: number, debugPort?: number): RunLaunch {
  return {
    type: "batlehub-run",
    request: "launch",
    name: debugPort ? `${TEMPLATE_NAME} (debug)` : TEMPLATE_NAME,
    stopGraceMs: 5000,
    steps: [
      debugPort
        ? { server: KIND, port, debug: true, debugPort }
        : { server: KIND, port },
    ],
    batlehub: { template: KIND },
  };
}

export interface Extension {
  id: string;
  name: string;
}

/** The project's `io.quarkus*` extensions, from the POM or the Gradle script (§4.2). */
export function installedExtensions(
  build: string,
  tool: "maven" | "gradle",
): string[] {
  if (tool === "gradle")
    return [
      ...build.matchAll(
        /["']io\.quarkus(?:\.[\w-]+)?:(quarkus-[\w-]+)(?::[^"']*)?["']/g,
      ),
    ]
      .map((m) => m[1]!)
      .filter((a) => a !== "quarkus-bom");
  const deps = /<dependencies>([\s\S]*?)<\/dependencies>/.exec(
    build.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, ""),
  )?.[1];
  return (deps?.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? [])
    .filter((d) => /^io\.quarkus/.test(tag(d, "groupId") ?? ""))
    .map((d) => tag(d, "artifactId")!)
    .filter(Boolean);
}

/**
 * §5.3, offline: the platform's extensions, from its descriptor in the local
 * repository (names, unlisted ones left out), else from the BOM — an
 * `io.quarkus` artifact with a `-deployment` twin is an extension. Installed
 * ones are left out. Undefined when neither is there: "run a build first".
 */
export function catalogue(
  descriptor: string | undefined,
  bom: string | undefined,
  installed: string[],
): Extension[] | undefined {
  const out = new Map<string, string>();
  if (descriptor) {
    const d = JSON.parse(descriptor) as {
      extensions?: {
        artifact: string;
        name?: string;
        metadata?: { unlisted?: unknown };
      }[];
    };
    for (const e of d.extensions ?? []) {
      if (e.metadata?.unlisted) continue;
      const id = e.artifact.split(":")[1];
      if (id) out.set(id, e.name ?? id);
    }
  } else if (bom) {
    const ids = new Set(
      (bom.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? [])
        .filter((d) => /^io\.quarkus/.test(tag(d, "groupId") ?? ""))
        .map((d) => tag(d, "artifactId")!),
    );
    for (const id of ids)
      if (!id.endsWith("-deployment") && ids.has(`${id}-deployment`))
        out.set(id, id);
  } else return undefined;
  for (const id of installed) out.delete(id);
  return [...out]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `quarkus:add-extension` / Gradle's `addExtension` (and remove), with the
 * registry client off: the tool reads the platform's descriptor through the
 * build's own repositories — the registry link — and never
 * `registry.quarkus.io` (§7; measured in phase 3, both tools).
 */
export function extensionGoal(
  tool: "maven" | "gradle",
  op: "add" | "remove",
  id: string,
): KindGoal {
  return tool === "maven"
    ? {
        tool,
        goal: `quarkus:${op}-extension`,
        args: [`-Dextensions=${id}`, "-DquarkusRegistryClient=false"],
      }
    : {
        tool,
        goal: `${op}Extension`,
        args: [`--extensions=${id}`, "-DquarkusRegistryClient=false"],
      };
}

export type DevState =
  { state: "stopped" } | { state: "running"; pid: number; port: number };

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

/** The Quarkus tab's body (§4.2): `--vscode-*` tokens only, buttons are commands. */
export function tabHtml(p: {
  detected: Detected & { module: string };
  dev: DevState;
  probe: Probe;
  bridged?: string;
  missing: string[];
  trusted: boolean;
  installed: string[];
  /** The Java debugger is installed and `debugPort` is not 0. */
  debug: { ok: boolean; reason?: string };
}): string {
  const d = p.dev;
  const url =
    d.state === "stopped" ? undefined : `http://localhost:${d.port}/q/dev-ui/`;
  const state =
    d.state === "stopped"
      ? "stopped"
      : `${d.state} · pid ${d.pid} · port ${d.port}`;
  const probe = p.probe.http
    ? `GET ${p.probe.http}`
    : `the log line /${p.probe.log}/`;
  return `<section aria-labelledby="h-quarkus"><h2 id="h-quarkus">Quarkus</h2>
<p>Quarkus ${esc(p.detected.version ?? "(version not named)")} · ${p.detected.tool} · module ${esc(p.detected.module)}</p>
<p>Dev mode: <b data-state="${d.state}">${esc(state)}</b>${url ? ` · <a href="${url}">${url}</a>` : ""}</p>
<p class="muted">Ready when: ${esc(probe)}</p>
${p.trusted ? "" : `<p class="muted">The workspace is not trusted: dev mode does not start.</p>`}
${p.bridged ? `<p class="muted">Wrote <code>${BRIDGE_KEY}</code> (for the MicroProfile server) = ${esc(p.bridged)} — <i>Java: Remove BatleHub settings</i> restores it.</p>` : ""}
${p.debug.reason ? `<p class="muted">Debug: ${esc(p.debug.reason)}</p>` : ""}
<h3>Extensions</h3>
<p>${p.installed.length ? p.installed.map(esc).join(" · ") : "none"}</p>
<div class="row"><button data-cmd="batlehub.java.quarkus.addExtension"${p.trusted ? "" : " disabled"}>Add…</button> <button data-cmd="batlehub.java.quarkus.removeExtension"${p.trusted && p.installed.length ? "" : " disabled"}>Remove…</button></div>
${p.missing.length ? `<p class="muted">Not installed: ${p.missing.map(esc).join(", ")} — no application.properties completion.</p>` : ""}
<div class="row"><button data-cmd="batlehub.java.quarkus.start"${d.state === "stopped" && p.trusted ? "" : " disabled"}>Start</button> <button data-cmd="batlehub.java.quarkus.debug"${d.state === "stopped" && p.trusted && p.debug.ok ? "" : " disabled"}${p.debug.reason ? ` title="${esc(p.debug.reason)}"` : ""}>Debug</button> <button data-cmd="batlehub.java.quarkus.stop"${d.state === "stopped" ? " disabled" : ""}>Stop</button> <button data-cmd="batlehub.java.quarkus.openDevUi"${url ? "" : " disabled"}>Open Dev UI</button> <button data-cmd="batlehub.java.quarkus.showLog">Show the log</button></div>
</section>`;
}

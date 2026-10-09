// The pure half of the Spring Boot satellite (RFC 0010 §6.1): detection
// through the parent chain, profiles and ports from the config files, the
// `@SpringBootApplication` scan, the bridge's rule, the template's entry and
// the tab. Nothing here imports `vscode` or reads a file: `extension.ts` reads
// and hands the text in.
import type {
  KindGoal,
  Probe,
  RunLaunch,
  ServerStep,
} from "../../java-core/api";

export const CONTRACT_MAJOR = 1;
export const TEMPLATE_ID = "spring-boot";
/** The RFC 0003 run step kind (§4.2): `{ "server": "spring-boot" }` in a `batlehub-run`. */
export const KIND = "spring-boot";
export const BOOT_GROUP = "org.springframework.boot";

/**
 * What `vmware.vscode-spring-boot` 2.4.0 reads for its server's JDK, in
 * order: this key, redhat.java's embedded JRE, `java.home`, `JAVA_HOME`,
 * `PATH` — and it refuses below 21 ("Spring Tools Language Server requires
 * Java 21 or higher"), not the 17 the RFC said (measured, phase 2).
 */
export const BRIDGE_KEY = "spring-boot.ls.java.home";
export const BRIDGE_MIN_MAJOR = 21;
/** The server's default heap (`jvmHeap: "1024m"` in 2.4.0) when no setting names one. */
export const SPRING_LS_DEFAULT_HEAP_MIB = 1024;

export interface Detected {
  tool: "maven" | "gradle";
  version?: string;
  /** The parent that ended the walk, `g:a:v`, when the version could not be read (§4.2). */
  unknownParent?: string;
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];
const props = (pom: string) =>
  /<properties>([\s\S]*?)<\/properties>/.exec(pom)?.[1] ?? "";

export interface Parent {
  group: string;
  artifact: string;
  version: string;
  /** Undefined: `../pom.xml`; "": `<relativePath/>`, look in the repository only. */
  relativePath?: string;
}

export function parentOf(pom: string): Parent | undefined {
  const p = /<parent>([\s\S]*?)<\/parent>/.exec(pom)?.[1];
  if (!p) return undefined;
  const group = tag(p, "groupId");
  const artifact = tag(p, "artifactId");
  const version = tag(p, "version");
  if (!group || !artifact || !version) return undefined;
  const rel = /<relativePath\s*\/>/.test(p) ? "" : tag(p, "relativePath");
  return { group, artifact, version, relativePath: rel };
}

/**
 * §4.2: Boot when the parent chain reaches `spring-boot-starter-parent` (or
 * `spring-boot-dependencies`), when a dependency's group is
 * `org.springframework.boot`, or when that BOM is imported. The chain is
 * walked through `read(parent)` — on disk by `relativePath`, then `~/.m2` —
 * and nothing is run. A parent it cannot read ends the walk and is named.
 */
export function detectPom(
  pom: string,
  read: (p: Parent) => string | undefined,
): Detected | undefined {
  const deps = (pom.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? []).map(
    (d) => ({
      group: tag(d, "groupId"),
      artifact: tag(d, "artifactId"),
      version: tag(d, "version"),
    }),
  );
  const bom = deps.find(
    (d) => d.group === BOOT_GROUP && d.artifact === "spring-boot-dependencies",
  );
  let version = bom?.version;
  let unknownParent: string | undefined;
  let p = parentOf(pom);
  let viaParent = false;
  for (let depth = 0; p && depth < 10; depth++) {
    if (
      p.group === BOOT_GROUP &&
      /^spring-boot-(starter-parent|dependencies)$/.test(p.artifact)
    ) {
      version ??= p.version;
      viaParent = true;
      break;
    }
    const text = read(p);
    if (!text) {
      unknownParent = `${p.group}:${p.artifact}:${p.version}`;
      break;
    }
    p = parentOf(text);
  }
  const direct = deps.some((d) => d.group === BOOT_GROUP);
  if (!viaParent && !bom && !direct) return undefined;
  const v = version && /^\$\{([^}]+)\}$/.exec(version);
  if (v) version = tag(props(pom), v[1]!.replace(/\./g, "\\.")) ?? version;
  return {
    tool: "maven",
    version,
    ...(version ? {} : unknownParent ? { unknownParent } : {}),
  };
}

/** Decision 13, script-only: `id 'org.springframework.boot'` or `apply plugin`. */
export function detectGradle(script: string): Detected | undefined {
  const m =
    /\bid\s*\(?\s*["']org\.springframework\.boot["'](?:\s*\))?(?:\s*version\s*\(?\s*["']([^"']+)["'])?/.exec(
      script,
    ) ??
    /apply\s*\(?\s*plugin\s*[:=]\s*["']org\.springframework\.boot["']/.exec(
      script,
    );
  if (!m) return undefined;
  return { tool: "gradle", version: m[1] };
}

/** One YAML document → dotted keys. Enough for the keys read here; not a YAML parser. */
export function flattenYaml(doc: string): Map<string, string> {
  const out = new Map<string, string>();
  const stack: { indent: number; key: string }[] = [];
  for (const raw of doc.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const m = /^(\s*)([^:#\s][^:#]*?)\s*:(?:\s+(.*))?$/.exec(raw);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const key = [...stack.map((s) => s.key), m[2]!.trim()].join(".");
    const value = (m[3] ?? "").replace(/\s+#.*$/, "").trim();
    if (!value) stack.push({ indent, key: m[2]!.trim() });
    else out.set(key, value.replace(/^["']|["']$/g, ""));
  }
  return out;
}

function flattenProperties(doc: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of doc.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

export interface Profiles {
  /** Declared profile names, sorted: file suffixes and `on-profile` documents. */
  names: string[];
  /** `server.port` per profile; `""` is the default document. */
  ports: Record<string, number>;
  /** `management.endpoints.web.exposure.include` of the default document (Boot's default: health). */
  exposure: string[];
  /** `spring.devtools.restart.trigger-file`, when set. */
  triggerFile?: string;
}

/**
 * §4.1: the profiles of `application*.{yml,yaml,properties}` — the file
 * suffix (`application-dev.yml`) and each document's
 * `spring.config.activate.on-profile` (or Boot 2's `spring.profiles`) — and
 * the `server.port` each sets.
 */
export function readProfiles(
  files: { name: string; text: string }[],
): Profiles {
  const names = new Set<string>();
  const ports: Record<string, number> = {};
  let exposure = ["health"];
  let triggerFile: string | undefined;
  for (const f of files) {
    const m = /^application(?:-([\w.-]+))?\.(ya?ml|properties)$/.exec(f.name);
    if (!m) continue;
    const yaml = m[2] !== "properties";
    const suffix = m[1];
    if (suffix) names.add(suffix);
    const docs = f.text.split(yaml ? /^---\s*$/m : /^#---\s*$/m);
    for (const doc of docs) {
      const flat = yaml ? flattenYaml(doc) : flattenProperties(doc);
      const on =
        flat.get("spring.config.activate.on-profile") ??
        flat.get("spring.profiles");
      // An expression (`dev & !cloud`) names its profiles; `!` ones are not ticked.
      const docProfiles = on
        ? (on.match(/!?[\w.-]+/g) ?? []).filter((w) => !w.startsWith("!"))
        : [];
      for (const p of docProfiles) names.add(p);
      if (!docProfiles.length && !suffix) {
        const ex = flat.get("management.endpoints.web.exposure.include");
        if (ex)
          exposure = ex
            .split(",")
            .map((e) => e.trim())
            .filter(Boolean);
        triggerFile =
          flat.get("spring.devtools.restart.trigger-file") ?? triggerFile;
      }
      const port = Number(flat.get("server.port"));
      if (!Number.isInteger(port) || port < 0) continue;
      const owner = docProfiles[0] ?? suffix ?? "";
      ports[owner] = port;
    }
  }
  return {
    names: [...names].sort(),
    ports,
    exposure,
    ...(triggerFile ? { triggerFile } : {}),
  };
}

/** The build file declares a dependency on this Boot artifact (POM or Gradle script). */
export function hasBootArtifact(build: string, artifact: string): boolean {
  return new RegExp(
    `<artifactId>${artifact}</artifactId>|["']org\\.springframework\\.boot:${artifact}(?::[^"']*)?["']`,
  ).test(build);
}

/** The ports the dashboard polls (§4.2): the setting, else every non-random port the config sets, else 8080. */
export function dashboardPorts(p: Profiles, setting: number[]): number[] {
  if (setting.length) return [...new Set(setting)];
  const set = [...new Set(Object.values(p.ports).filter((x) => x > 0))];
  return set.length ? set.sort((a, b) => a - b) : [8080];
}

/** An actuator answer, defensively: a `status` string, or undefined. */
export function healthStatus(body: string): string | undefined {
  try {
    const s = (JSON.parse(body) as { status?: unknown }).status;
    return typeof s === "string" ? s.slice(0, 32) : undefined;
  } catch {
    return undefined;
  }
}

/** `/actuator/metrics/<name>`'s first measurement, or undefined. */
export function metricValue(body: string): number | undefined {
  try {
    const v = (JSON.parse(body) as { measurements?: { value?: unknown }[] })
      .measurements?.[0]?.value;
    return typeof v === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The application context's uptime. A devtools restart keeps the JVM, so
 * `process.uptime` does not reset (measured on Boot 4.1.1); the context's
 * `application.ready.time` is re-registered with a new value at every
 * start. First sight: the JVM's uptime; a changed ready time: a restart,
 * counted from that poll.
 */
export class Uptimes {
  private readonly seen = new Map<
    number,
    { ready?: number; since: number; restarts: number }
  >();
  observe(
    port: number,
    now: number,
    processUptimeS?: number,
    readyTime?: number,
  ) {
    let e = this.seen.get(port);
    if (!e) {
      e = {
        ready: readyTime,
        since: now - (processUptimeS ?? 0) * 1000,
        restarts: 0,
      };
      this.seen.set(port, e);
    } else if (
      readyTime !== undefined &&
      e.ready !== undefined &&
      readyTime !== e.ready
    ) {
      e.ready = readyTime;
      e.since = now;
      e.restarts++;
    } else e.ready ??= readyTime;
    return {
      uptimeS: Math.max(0, Math.round((now - e.since) / 1000)),
      restarts: e.restarts,
    };
  }
  forget(port: number): void {
    this.seen.delete(port);
  }
}

export function formatUptime(s: number): string {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/**
 * §4.2 dev tools, as Boot 4 has them: an exposed `restart` endpoint (Spring
 * Cloud's — plain Boot 4 answers 404), else devtools' trigger file when the
 * config names one, else disabled with the reason. Saving a class restarts
 * a devtools app by itself either way.
 */
export function restartAction(f: {
  devtools: boolean;
  exposure: string[];
  triggerFile?: string;
}):
  | { kind: "endpoint" }
  | { kind: "trigger"; file: string }
  | { kind: "disabled"; reason: string } {
  if (!f.devtools)
    return {
      kind: "disabled",
      reason: "spring-boot-devtools is not on the classpath",
    };
  if (f.exposure.includes("restart") || f.exposure.includes("*"))
    return { kind: "endpoint" };
  if (f.triggerFile) return { kind: "trigger", file: f.triggerFile };
  return {
    kind: "disabled",
    reason:
      "no restart endpoint and no spring.devtools.restart.trigger-file — saving a class restarts it",
  };
}

export interface Instance {
  port: number;
  status: string;
  uptimeS?: number;
  restarts: number;
  profiles?: string[];
  /** Started by the editor (the template's session): Stop is enabled (decision 14). */
  mine: boolean;
}

/** The port an instance runs on with these profiles: the last active one that sets it, else the default, else 8080. */
export function portFor(p: Profiles, active: string[]): number {
  for (const a of [...active].reverse())
    if (p.ports[a] !== undefined) return p.ports[a]!;
  return p.ports[""] ?? 8080;
}

/** Decision 6: a file scan for `@SpringBootApplication`, comments ignored. */
export function mainClasses(sources: { text: string }[]): string[] {
  const out: string[] = [];
  for (const s of sources) {
    const code = s.text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const at = code.search(/@SpringBootApplication\b/);
    if (at < 0) continue;
    const cls = /\bclass\s+(\w+)/.exec(code.slice(at))?.[1];
    if (!cls) continue;
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(code)?.[1];
    out.push(pkg ? `${pkg}.${cls}` : cls);
  }
  return out.sort();
}

/** `JAVA_VERSION="21.0.11"` of a JDK's `release` file → 21; `1.8.0` → 8. */
export function releaseMajor(release: string | undefined): number | undefined {
  const v = /^JAVA_VERSION="([^"]+)"/m.exec(release ?? "")?.[1];
  if (!v) return undefined;
  const [a, b] = v.split(".").map(Number);
  return a === 1 ? b : a;
}

/**
 * §4.1 `bridge: auto`, against the server's real lookup: write only when
 * the VMware extension is installed, the key is unset, redhat.java carries
 * no JRE of its own, and neither `java.home`, `JAVA_HOME` nor the first
 * `java` on `PATH` is a JDK ≥ 21.
 */
export function needsBridge(f: {
  bridge: string;
  installed: boolean;
  keySet: boolean;
  redhatJre: boolean;
  javaHomeSettingMajor?: number;
  javaHomeMajor?: number;
  pathJavaMajor?: number;
}): boolean {
  if (f.bridge === "never" || !f.installed || f.keySet || f.redhatJre)
    return false;
  return ![f.javaHomeSettingMajor, f.javaHomeMajor, f.pathJavaMajor].some(
    (m) => (m ?? 0) >= BRIDGE_MIN_MAJOR,
  );
}

/** `"1024m"`, `"2g"`, `-Xmx768m` → MiB; undefined when it names none. */
export function heapMiB(
  heap: string | undefined,
  vmargs: string[] | undefined,
): number | undefined {
  const s = heap ?? (vmargs ?? []).find((a) => a.startsWith("-Xmx"))?.slice(4);
  const m = /^(\d+)([kmg])?$/i.exec(s ?? "");
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  return unit === "g"
    ? n * 1024
    : unit === "k"
      ? Math.ceil(n / 1024)
      : unit === "m"
        ? n
        : Math.ceil(n / 2 ** 20);
}

/** RFC 0003 §4.2's heap-to-resident margin: a JVM at -Xmx512m declares about 768. */
export const residentFor = (heap: number) => Math.round(heap * 1.5);

/** §4.2 the template: a `java` launch the stock debugger runs, the active profiles as a system property. */
export function launchFor(p: {
  mainClass: string;
  module: string;
  profiles: string[];
}): RunLaunch {
  const simple = p.mainClass.split(".").pop() ?? p.mainClass;
  return {
    type: "java",
    request: "launch",
    name: `Spring Boot: ${simple}`,
    mainClass: p.mainClass,
    projectName: p.module,
    // In the integrated terminal (the debugger's default) ending the session
    // left the JVM running and holding its port (measured, phase 2); in the
    // debug console the debugger owns the process and Stop ends it.
    console: "internalConsole",
    ...(p.profiles.length
      ? { vmArgs: `-Dspring.profiles.active=${p.profiles.join(",")}` }
      : {}),
    batlehub: { template: TEMPLATE_ID, springProfiles: p.profiles },
  };
}

const esc = (s: string) =>
  s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

/** The Spring tab (§4.2): `--vscode-*` tokens only, every button a command. */
export function tabHtml(p: {
  detected: Detected & { module: string };
  profiles: Profiles;
  active: string[];
  mavenProfiles: string[];
  mainClasses: string[];
  bridged?: string;
  vmwareMissing: boolean;
  trusted: boolean;
  instances?: Instance[];
  actuator?: boolean;
  restart?: ReturnType<typeof restartAction>;
}): string {
  const d = p.detected;
  const version = d.version
    ? `Spring Boot ${esc(d.version)}`
    : d.unknownParent
      ? `Spring Boot (version unknown — parent ${esc(d.unknownParent)} is not in ~/.m2; build once and press Detect)`
      : "Spring Boot (version not named)";
  const toggles = p.profiles.names.length
    ? p.profiles.names
        .map((n) => {
          const on = p.active.includes(n);
          return `<button data-cmd="batlehub.java.spring.toggleProfile" data-arg="${esc(n)}" aria-pressed="${on}"${p.trusted ? "" : " disabled"}>${on ? "☑" : "☐"} ${esc(n)}</button>`;
        })
        .join(" ")
    : `<span class="muted">none declared</span>`;
  const ports = Object.entries(p.profiles.ports)
    .map(([k, v]) => `${k || "default"} ${v === 0 ? "random" : v}`)
    .join(" · ");
  return `<section aria-labelledby="h-spring"><h2 id="h-spring">Spring Boot</h2>
<p>${version} · ${d.tool} · module ${esc(d.module)}</p>
<p>Main class: ${p.mainClasses.length ? p.mainClasses.map(esc).join(", ") : `<span class="muted">no @SpringBootApplication found</span>`}</p>
<h3>Profiles</h3>
<p>Maven profiles: ${p.mavenProfiles.length ? p.mavenProfiles.map(esc).join(", ") : "none"} <span class="muted">(read-only — the Profiles tab)</span></p>
<p>Spring profiles: ${toggles}</p>
<div class="row"><button data-cmd="batlehub.java.spring.pairProfiles"${p.trusted && p.mavenProfiles.length ? "" : " disabled"}>Pair with the Maven profiles of the same name</button></div>
<p class="muted">Ports: ${esc(ports || "default 8080")} · the template passes -Dspring.profiles.active=${esc(p.active.join(",") || "(none)")}</p>
<h3>Instances</h3>
${instancesHtml(p)}
${p.bridged ? `<p class="muted">Wrote <code>${BRIDGE_KEY}</code> = ${esc(p.bridged)} — <i>Java: Remove BatleHub settings</i> restores it.</p>` : ""}
${p.vmwareMissing ? `<p class="muted">Spring Boot Tools (vmware.vscode-spring-boot) is not installed: no properties completion, no bean navigation.</p>` : ""}
<div class="row"><button data-cmd="batlehub.java.run.new"${p.trusted ? "" : " disabled"}>New run configuration…</button> <button data-cmd="batlehub.java.spring.showLog">Show the log</button></div>
</section>`;
}

function instancesHtml(p: {
  instances?: Instance[];
  actuator?: boolean;
  restart?: ReturnType<typeof restartAction>;
  trusted: boolean;
}): string {
  if (!p.trusted)
    return `<p class="muted">Not polled in an untrusted workspace.</p>`;
  if (p.actuator === false)
    return `<p class="muted">no actuator: add spring-boot-starter-actuator to see health</p>`;
  const list = p.instances ?? [];
  if (!list.length) return `<p class="muted">None running.</p>`;
  const r = p.restart ?? { kind: "disabled" as const, reason: "" };
  const rows = list
    .map((i) => {
      const cells = [
        `localhost:${i.port}`,
        esc(i.status),
        i.uptimeS === undefined
          ? ""
          : formatUptime(i.uptimeS) +
            (i.restarts ? ` (restarted ${i.restarts}×)` : ""),
        esc((i.profiles ?? []).join(", ")),
      ];
      const open = `<button data-cmd="batlehub.java.spring.openInstance" data-arg="${i.port}">Open</button>`;
      const stop = i.mine
        ? `<button data-cmd="batlehub.java.spring.stopInstance" data-arg="${i.port}">Stop</button>`
        : `<button disabled title="started outside the editor">Stop</button>`;
      const restart =
        r.kind === "disabled"
          ? `<button disabled title="${esc(r.reason)}">Restart</button>`
          : `<button data-cmd="batlehub.java.spring.restart" data-arg="${i.port}">Restart</button>`;
      return `<tr data-port="${i.port}">${cells.map((c) => `<td>${c}</td>`).join("")}<td>${open} ${stop} ${restart}</td></tr>`;
    })
    .join("");
  const why =
    r.kind === "disabled"
      ? `<p class="muted">Restart: ${esc(r.reason)}</p>`
      : "";
  return `<table aria-label="Spring Boot instances"><thead><tr><th scope="col">Instance</th><th scope="col">Health</th><th scope="col">Uptime</th><th scope="col">Profiles</th><th scope="col"></th></tr></thead><tbody>${rows}</tbody></table>${why}`;
}

export interface KindSettings {
  tool: "maven" | "gradle";
  memoryMiB: number;
  profiles: Profiles;
  active: string[];
}

/**
 * The `spring-boot` kind (§4.2, phase 4): the core runs `spring-boot:run`
 * (Gradle: `bootRun`) as any `batlehub-java` task, with the active Spring
 * profiles; ready when `/actuator/health` answers 2xx — 503 while it is
 * DOWN at startup — within 120 s; stopped by the core's SIGTERM to the
 * group, which Boot answers with its graceful shutdown (measured on 4.1.1:
 * `Commencing graceful shutdown`, the group gone in 2 s). No graceful
 * command: `POST /actuator/shutdown` is rarely exposed (decision 14).
 */
export function makeKind(s: () => KindSettings) {
  const port = (step: ServerStep) =>
    step.port ?? portFor(s().profiles, s().active);
  return {
    id: KIND,
    get defaultMemoryMiB() {
      return s().memoryMiB;
    },
    defaultProbe(step: ServerStep): Probe {
      return {
        http: `http://localhost:${port(step)}/actuator/health`,
        timeoutMs: 120_000,
      };
    },
    goal(step: ServerStep): KindGoal {
      const k = s();
      if (k.tool === "gradle") {
        const args = [
          ...(k.active.length
            ? [`--spring.profiles.active=${k.active.join(",")}`]
            : []),
          ...(step.port ? [`--server.port=${step.port}`] : []),
        ];
        // ponytail: bootRun's --debug-jvm suspends on 5005 and takes no port; Gradle debug waits for a fixture.
        return {
          tool: "gradle",
          goal: "bootRun",
          args: args.length ? [`--args=${args.join(" ")}`] : [],
        };
      }
      return {
        tool: "maven",
        goal: "spring-boot:run",
        args: [
          ...(k.active.length
            ? [`-Dspring-boot.run.profiles=${k.active.join(",")}`]
            : []),
          ...(step.port
            ? [`-Dspring-boot.run.arguments=--server.port=${step.port}`]
            : []),
          // JDWP on localhost only (RFC 0003 decision 10), and only when the run asks.
          ...(step.debug
            ? [
                `-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=localhost:${step.debugPort ?? 5005}`,
              ]
            : []),
        ],
      };
    },
  };
}

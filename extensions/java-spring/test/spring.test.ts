import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  makeKind,
  dashboardPorts,
  formatUptime,
  hasBootArtifact,
  healthStatus,
  metricValue,
  restartAction,
  Uptimes,
  detectGradle,
  detectPom,
  flattenYaml,
  heapMiB,
  launchFor,
  mainClasses,
  needsBridge,
  type Parent,
  portFor,
  readProfiles,
  residentFor,
  tabHtml,
} from "../src/spring";

const FIXTURE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "tests",
  "heavy",
  "fixtures",
  "spring-boot",
);
const none = () => undefined;
const parentPom = (g: string, a: string, v: string, extra = "") =>
  `<project><parent><groupId>${g}</groupId><artifactId>${a}</artifactId><version>${v}</version>${extra}</parent>
  <dependencies><dependency><groupId>com.acme</groupId><artifactId>x</artifactId></dependency></dependencies></project>`;

describe("detection (RFC 0010 §4.2)", () => {
  it("reads the heavy fixture: the starter parent, its empty relativePath", () => {
    expect(
      detectPom(fs.readFileSync(path.join(FIXTURE, "pom.xml"), "utf8"), none),
    ).toEqual({ tool: "maven", version: "4.1.1" });
  });
  it("walks a corporate parent to the starter parent, and names the parent that ends the walk", () => {
    const corp = parentPom(
      "org.springframework.boot",
      "spring-boot-starter-parent",
      "3.5.4",
    );
    const asked: Parent[] = [];
    const read = (p: Parent) => (
      asked.push(p),
      p.artifact === "corp-parent" ? corp : undefined
    );
    expect(
      detectPom(
        parentPom("com.acme", "corp-parent", "7", "<relativePath/>"),
        read,
      ),
    ).toEqual({ tool: "maven", version: "3.5.4" });
    expect(asked[0]).toMatchObject({
      artifact: "corp-parent",
      relativePath: "",
    });
    // Only the parent links it to Boot, and the parent is not there: not detected.
    expect(
      detectPom(parentPom("com.acme", "corp-parent", "7"), none),
    ).toBeUndefined();
    // A direct Boot dependency is still Boot, with the parent named.
    const direct = `<project><parent><groupId>com.acme</groupId><artifactId>corp-parent</artifactId><version>7</version></parent><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-webmvc</artifactId></dependency></dependencies></project>`;
    expect(detectPom(direct, none)).toEqual({
      tool: "maven",
      version: undefined,
      unknownParent: "com.acme:corp-parent:7",
    });
  });
  it("the BOM import, its version through a property; a plain Java project is not Boot", () => {
    const bom = `<project><properties><boot.version>4.0.8</boot.version></properties><dependencyManagement><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-dependencies</artifactId><version>\${boot.version}</version><type>pom</type><scope>import</scope></dependency></dependencies></dependencyManagement></project>`;
    expect(detectPom(bom, none)).toEqual({ tool: "maven", version: "4.0.8" });
    expect(
      detectPom(
        "<project><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId></dependency></dependencies></project>",
        none,
      ),
    ).toBeUndefined();
  });
  it("Gradle, script-only (decision 13)", () => {
    expect(
      detectGradle(
        `plugins {\n  id 'java'\n  id 'org.springframework.boot' version '4.1.1'\n}`,
      ),
    ).toEqual({ tool: "gradle", version: "4.1.1" });
    expect(
      detectGradle(
        `plugins { id("org.springframework.boot") version "4.1.1" }`,
      ),
    ).toEqual({ tool: "gradle", version: "4.1.1" });
    expect(detectGradle(`apply plugin: 'org.springframework.boot'`)).toEqual({
      tool: "gradle",
      version: undefined,
    });
    expect(detectGradle(`plugins { id 'io.quarkus' }`)).toBeUndefined();
  });
});

describe("profiles and ports (§4.1)", () => {
  it("reads the fixture's two documents: default on 8080, dev on 8081", () => {
    const p = readProfiles([
      {
        name: "application.yml",
        text: fs.readFileSync(
          path.join(FIXTURE, "src/main/resources/application.yml"),
          "utf8",
        ),
      },
    ]);
    expect(p).toEqual({
      names: ["dev"],
      ports: { "": 8080, dev: 8081 },
      exposure: ["health", "info", "env", "metrics"],
    });
    expect(portFor(p, [])).toBe(8080);
    expect(portFor(p, ["dev"])).toBe(8081);
  });
  it("file suffixes, properties documents, Boot 2's key, an expression, a random port", () => {
    const p = readProfiles([
      { name: "application-ci.properties", text: "server.port=9090\n" },
      {
        name: "application.properties",
        text: "server.port=0\n#---\nspring.config.activate.on-profile=local & !cloud\nserver.port=7070\n",
      },
      { name: "application-old.yaml", text: "spring:\n  profiles: legacy\n" },
      { name: "logback.xml", text: "<x/>" },
    ]);
    expect(p.names).toEqual(["ci", "legacy", "local", "old"]);
    expect(p.ports).toEqual({ ci: 9090, "": 0, local: 7070 });
    expect(portFor(p, ["local", "ci"])).toBe(9090);
  });
  it("flattens nested YAML, comments and quotes aside", () => {
    expect(
      Object.fromEntries(
        flattenYaml(
          "server:\n  port: 8081 # dev\nspring:\n  application:\n    name: 'demo'\n",
        ),
      ),
    ).toEqual({ "server.port": "8081", "spring.application.name": "demo" });
  });
});

describe("the main class (decision 6)", () => {
  it("finds the fixture's, ignores a commented annotation, lists several", () => {
    const fixture = fs.readFileSync(
      path.join(FIXTURE, "src/main/java/com/acme/demo/DemoApplication.java"),
      "utf8",
    );
    expect(mainClasses([{ text: fixture }])).toEqual([
      "com.acme.demo.DemoApplication",
    ]);
    expect(
      mainClasses([
        { text: "package a;\n// @SpringBootApplication\nclass X {}" },
        { text: "package a;\n/* @SpringBootApplication */ class Y {}" },
      ]),
    ).toEqual([]);
    expect(
      mainClasses([
        { text: fixture },
        {
          text: 'package b;\n@SpringBootApplication(scanBasePackages = "b")\npublic final class Other {}',
        },
      ]),
    ).toEqual(["b.Other", "com.acme.demo.DemoApplication"]);
  });
});

describe("the bridge's rule, against VMware's real lookup (measured)", () => {
  const base = {
    bridge: "auto",
    installed: true,
    keySet: false,
    redhatJre: false,
  };
  it("writes only when nothing it looks at is a JDK ≥ 21", () => {
    expect(needsBridge(base)).toBe(true);
    expect(needsBridge({ ...base, pathJavaMajor: 17 })).toBe(true);
    expect(needsBridge({ ...base, javaHomeMajor: 21 })).toBe(false);
    expect(needsBridge({ ...base, javaHomeSettingMajor: 25 })).toBe(false);
    expect(needsBridge({ ...base, redhatJre: true })).toBe(false);
    expect(needsBridge({ ...base, keySet: true })).toBe(false);
    expect(needsBridge({ ...base, installed: false })).toBe(false);
    expect(needsBridge({ ...base, bridge: "never" })).toBe(false);
  });
  it("estimates the server from its heap setting, its vmargs, else 1024 MiB", () => {
    expect(heapMiB("2g", undefined)).toBe(2048);
    expect(heapMiB(undefined, ["-XX:+UseG1GC", "-Xmx768m"])).toBe(768);
    expect(heapMiB(undefined, undefined)).toBeUndefined();
    expect(residentFor(1024)).toBe(1536);
  });
});

describe("the template (§4.2)", () => {
  it("a java launch with the profiles as a system property and BatleHub's block", () => {
    expect(
      launchFor({
        mainClass: "com.acme.demo.DemoApplication",
        module: "spring-boot-fixture",
        profiles: ["dev"],
      }),
    ).toEqual({
      type: "java",
      request: "launch",
      name: "Spring Boot: DemoApplication",
      mainClass: "com.acme.demo.DemoApplication",
      projectName: "spring-boot-fixture",
      console: "internalConsole",
      vmArgs: "-Dspring.profiles.active=dev",
      batlehub: { template: "spring-boot", springProfiles: ["dev"] },
    });
    expect(
      launchFor({ mainClass: "a.B", module: "m", profiles: [] }),
    ).not.toHaveProperty("vmArgs");
  });
  it("the tab shows both profile systems and escapes what it reads", () => {
    const html = tabHtml({
      detected: { tool: "maven", version: "4.1.1", module: "<m>" },
      profiles: {
        names: ["dev"],
        ports: { "": 8080, dev: 8081 },
        exposure: ["health"],
      },
      active: ["dev"],
      mavenProfiles: ["dev"],
      mainClasses: ["com.acme.demo.DemoApplication"],
      vmwareMissing: true,
      trusted: true,
    });
    expect(html).toContain("module &lt;m&gt;");
    expect(html).toContain('data-arg="dev" aria-pressed="true"');
    expect(html).toContain("Maven profiles: dev");
    expect(html).toContain("default 8080 · dev 8081");
    expect(html).toContain("vmware.vscode-spring-boot) is not installed");
  });
});

describe("the dashboard (§4.2, phase 3)", () => {
  const fixturePom = fs.readFileSync(path.join(FIXTURE, "pom.xml"), "utf8");
  it("reads the fixture's dependencies, and a Gradle script's", () => {
    expect(hasBootArtifact(fixturePom, "spring-boot-starter-actuator")).toBe(
      true,
    );
    expect(hasBootArtifact(fixturePom, "spring-boot-devtools")).toBe(true);
    expect(hasBootArtifact(fixturePom, "spring-boot-starter-webflux")).toBe(
      false,
    );
    expect(
      hasBootArtifact(
        `developmentOnly 'org.springframework.boot:spring-boot-devtools'`,
        "spring-boot-devtools",
      ),
    ).toBe(true);
  });
  it("polls the declared ports, a random one left out, the setting first", () => {
    expect(
      dashboardPorts(
        { names: [], ports: { "": 8080, dev: 8081, ci: 0 }, exposure: [] },
        [],
      ),
    ).toEqual([8080, 8081]);
    expect(dashboardPorts({ names: [], ports: {}, exposure: [] }, [])).toEqual([
      8080,
    ]);
    expect(
      dashboardPorts(
        { names: [], ports: { "": 8080 }, exposure: [] },
        [9000, 9000],
      ),
    ).toEqual([9000]);
  });
  it("parses actuator answers defensively", () => {
    expect(
      healthStatus('{"groups":["liveness","readiness"],"status":"UP"}'),
    ).toBe("UP");
    expect(healthStatus("<html>")).toBeUndefined();
    expect(healthStatus('{"status":42}')).toBeUndefined();
    expect(
      metricValue(
        '{"name":"process.uptime","measurements":[{"statistic":"VALUE","value":14.436}]}',
      ),
    ).toBe(14.436);
    expect(metricValue("{}")).toBeUndefined();
  });
  it("counts the context's uptime: the JVM's at first, reset when application.ready.time changes (measured)", () => {
    const u = new Uptimes();
    // First sight: the JVM has run 3.4 s, the context became ready in 2.262 s.
    expect(u.observe(8080, 100_000, 3.4, 2.262)).toEqual({
      uptimeS: 3,
      restarts: 0,
    });
    // Same context, 11 s later — process.uptime keeps counting through a devtools restart…
    expect(u.observe(8080, 111_000, 14.4, 2.262)).toEqual({
      uptimeS: 14,
      restarts: 0,
    });
    // …but the restarted context re-registers its ready time.
    expect(u.observe(8080, 116_000, 19.4, 0.426)).toEqual({
      uptimeS: 0,
      restarts: 1,
    });
    expect(u.observe(8080, 121_000, 24.4, 0.426)).toEqual({
      uptimeS: 5,
      restarts: 1,
    });
    u.forget(8080);
    expect(u.observe(8080, 130_000, 1, 1.5).restarts).toBe(0);
    expect(formatUptime(42)).toBe("42 s");
    expect(formatUptime(3725)).toBe("1 h 2 min");
  });
  it("Restart: Boot 4 has no endpoint (404, measured) — the trigger file, else disabled with the reason", () => {
    expect(restartAction({ devtools: false, exposure: ["*"] })).toEqual({
      kind: "disabled",
      reason: "spring-boot-devtools is not on the classpath",
    });
    expect(
      restartAction({ devtools: true, exposure: ["health", "restart"] }),
    ).toEqual({ kind: "endpoint" });
    expect(
      restartAction({
        devtools: true,
        exposure: ["health"],
        triggerFile: ".reloadtrigger",
      }),
    ).toEqual({ kind: "trigger", file: ".reloadtrigger" });
    expect(
      restartAction({ devtools: true, exposure: ["health"] }),
    ).toMatchObject({ kind: "disabled" });
  });
  it("the tab's rows: Stop only for what the editor started, Restart with its reason", () => {
    const html = tabHtml({
      detected: { tool: "maven", version: "4.1.1", module: "m" },
      profiles: {
        names: ["dev"],
        ports: { "": 8080, dev: 8081 },
        exposure: ["health"],
      },
      active: [],
      mavenProfiles: [],
      mainClasses: [],
      vmwareMissing: false,
      trusted: true,
      actuator: true,
      instances: [
        { port: 8080, status: "UP", uptimeS: 12, restarts: 0, mine: false },
        {
          port: 8081,
          status: "UP",
          uptimeS: 3,
          restarts: 1,
          profiles: ["dev"],
          mine: true,
        },
      ],
      restart: {
        kind: "disabled",
        reason: "spring-boot-devtools is not on the classpath",
      },
    });
    expect(html).toContain(
      '<tr data-port="8080"><td>localhost:8080</td><td>UP</td><td>12 s</td>',
    );
    expect(html).toContain(
      '<button disabled title="started outside the editor">Stop</button>',
    );
    expect(html).toContain(
      'data-cmd="batlehub.java.spring.stopInstance" data-arg="8081"',
    );
    expect(html).toContain("3 s (restarted 1×)");
    expect(html).toContain(
      '<button disabled title="spring-boot-devtools is not on the classpath">Restart</button>',
    );
    expect(
      tabHtml({
        detected: { tool: "maven", module: "m" },
        profiles: { names: [], ports: {}, exposure: [] },
        active: [],
        mavenProfiles: [],
        mainClasses: [],
        vmwareMissing: false,
        trusted: true,
        actuator: false,
      }),
    ).toContain("no actuator: add spring-boot-starter-actuator");
  });
});

describe("the spring-boot run step kind (§4.2, phase 4)", () => {
  const profiles = {
    names: ["dev"],
    ports: { "": 8080, dev: 8081 },
    exposure: ["health"],
  };
  it("runs spring-boot:run with the active profiles, probes health on their port (measured)", () => {
    const k = makeKind(() => ({
      tool: "maven",
      memoryMiB: 768,
      profiles,
      active: ["dev"],
    }));
    expect(k.defaultMemoryMiB).toBe(768);
    expect(k.goal({ server: "spring-boot" })).toEqual({
      tool: "maven",
      goal: "spring-boot:run",
      args: ["-Dspring-boot.run.profiles=dev"],
    });
    expect(k.defaultProbe({ server: "spring-boot" })).toEqual({
      http: "http://localhost:8081/actuator/health",
      timeoutMs: 120000,
    });
    expect(k.defaultProbe({ server: "spring-boot", port: 9000 }).http).toBe(
      "http://localhost:9000/actuator/health",
    );
    expect(
      k.goal({ server: "spring-boot", port: 9000, debug: true }).args,
    ).toEqual([
      "-Dspring-boot.run.profiles=dev",
      "-Dspring-boot.run.arguments=--server.port=9000",
      "-Dspring-boot.run.jvmArguments=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=localhost:5005",
    ]);
  });
  it("Gradle: bootRun with the profiles and the port as one --args", () => {
    const k = makeKind(() => ({
      tool: "gradle",
      memoryMiB: 768,
      profiles,
      active: ["dev"],
    }));
    expect(k.goal({ server: "spring-boot", port: 9000 })).toEqual({
      tool: "gradle",
      goal: "bootRun",
      args: ["--args=--spring.profiles.active=dev --server.port=9000"],
    });
    expect(
      makeKind(() => ({
        tool: "gradle",
        memoryMiB: 768,
        profiles,
        active: [],
      })).goal({ server: "spring-boot" }).args,
    ).toEqual([]);
  });
});

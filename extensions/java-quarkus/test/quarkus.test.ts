import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalogue,
  detectGradle,
  extensionGoal,
  gradlePlatform,
  installedExtensions,
  detectPom,
  devLaunch,
  devPort,
  makeKind,
  needsBridge,
  releaseMajor,
  tabHtml,
} from "../src/quarkus";

const FIXTURE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "tests",
  "heavy",
  "fixtures",
  "quarkus",
);
const GRADLE = path.join(FIXTURE, "..", "quarkus-gradle");

describe("detection (RFC 0011 §4.2)", () => {
  it("reads the heavy fixture's POM, where the BOM is named through properties", () => {
    expect(
      detectPom(fs.readFileSync(path.join(FIXTURE, "pom.xml"), "utf8")),
    ).toEqual({
      tool: "maven",
      version: "3.40.1",
      group: "io.quarkus.platform",
    });
  });
  it("the core BOM, the plugin alone, and a Boot project", () => {
    const dep = (g: string, a: string, v = "3.2.1") =>
      `<project><dependencyManagement><dependencies><dependency><groupId>${g}</groupId><artifactId>${a}</artifactId><version>${v}</version></dependency></dependencies></dependencyManagement></project>`;
    expect(detectPom(dep("io.quarkus", "quarkus-bom"))).toEqual({
      tool: "maven",
      version: "3.2.1",
      group: "io.quarkus",
    });
    expect(
      detectPom(
        "<project><build><plugins><plugin><groupId>io.quarkus</groupId><artifactId>quarkus-maven-plugin</artifactId><version>3.9.0</version></plugin></plugins></build></project>",
      ),
    ).toEqual({
      tool: "maven",
      version: "3.9.0",
      group: "io.quarkus.platform",
    });
    expect(
      detectPom(dep("org.springframework.boot", "spring-boot-dependencies")),
    ).toBeUndefined();
  });
  it("Gradle: the plugin id, and the enforced platform with a version", () => {
    expect(
      detectGradle(`plugins {\n  id 'java'\n  id 'io.quarkus'\n}`),
    ).toEqual({ tool: "gradle" });
    expect(detectGradle(`plugins { id("io.quarkus") }`)).toEqual({
      tool: "gradle",
    });
    expect(
      detectGradle(
        `implementation(enforcedPlatform("io.quarkus.platform:quarkus-bom:3.40.1"))`,
      ),
    ).toEqual({ tool: "gradle", version: "3.40.1" });
    expect(
      detectGradle(
        `implementation enforcedPlatform("\${quarkusPlatformGroupId}:quarkus-bom:\${v}")`,
      ),
    ).toBeUndefined();
    expect(
      detectGradle(`plugins { id 'org.springframework.boot' }`),
    ).toBeUndefined();
  });
});

describe("the dev port (§4.1)", () => {
  it("%dev wins, then the plain key, then 8080; the setting wins over all", () => {
    expect(
      devPort(
        fs.readFileSync(
          path.join(FIXTURE, "src/main/resources/application.properties"),
          "utf8",
        ),
        0,
      ),
    ).toBe(8081);
    expect(devPort("# c\nquarkus.http.port: 9000\n", 0)).toBe(9000);
    expect(devPort(undefined, 0)).toBe(8080);
    expect(devPort("%dev.quarkus.http.port=8081", 7000)).toBe(7000);
  });
});

describe("the bridge's rule (§4.1)", () => {
  const base = { bridge: "auto", installed: true, keySet: false };
  it("writes only when the MicroProfile server has no JDK ≥ 21", () => {
    expect(needsBridge(base)).toBe(true);
    expect(needsBridge({ ...base, pathJavaMajor: 17 })).toBe(true);
    expect(needsBridge({ ...base, javaHomeMajor: 21 })).toBe(false);
    expect(needsBridge({ ...base, pathJavaMajor: 25 })).toBe(false);
    expect(needsBridge({ ...base, keySet: true })).toBe(false);
    expect(needsBridge({ ...base, installed: false })).toBe(false);
    expect(needsBridge({ ...base, bridge: "never" })).toBe(false);
  });
  it("reads a JDK's release file", () => {
    expect(
      releaseMajor('IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="21.0.11"\n'),
    ).toBe(21);
    expect(releaseMajor('JAVA_VERSION="1.8.0_402"')).toBe(8);
    expect(releaseMajor(undefined)).toBeUndefined();
  });
});

describe("the quarkus-dev kind (§4.2)", () => {
  const settings = {
    devMemoryMiB: 1024,
    devPort: 0,
    debugPort: 5005,
    readiness: "/q/health/ready",
    tool: "maven" as const,
    properties: () => "%dev.quarkus.http.port=8081",
  };
  it("Gradle: the heavy fixture, its platform in gradle.properties, quarkusDev with the same flag (decision 11, measured)", () => {
    expect(
      detectGradle(fs.readFileSync(path.join(GRADLE, "build.gradle"), "utf8")),
    ).toEqual({ tool: "gradle", version: undefined });
    expect(
      gradlePlatform(
        fs.readFileSync(path.join(GRADLE, "gradle.properties"), "utf8"),
      ),
    ).toEqual({ version: "3.40.1", group: "io.quarkus.platform" });
    const k = makeKind(() => ({ ...settings, tool: "gradle" }));
    expect(k.goal({ server: "quarkus-dev" })).toEqual({
      tool: "gradle",
      goal: "quarkusDev",
      args: ["-Ddebug=false"],
    });
    expect(k.goal({ server: "quarkus-dev", debug: true })).toEqual({
      tool: "gradle",
      goal: "quarkusDev",
      args: ["-Ddebug=5005"],
    });
  });
  it("runs quarkus:dev with no JDWP port unless the run asks, probes health, quits on q", () => {
    const k = makeKind(() => settings);
    expect(k.defaultMemoryMiB).toBe(1024);
    expect(k.goal({ server: "quarkus-dev" })).toEqual({
      tool: "maven",
      goal: "quarkus:dev",
      args: ["-Ddebug=false"],
    });
    expect(k.goal({ server: "quarkus-dev", debug: true })).toEqual({
      tool: "maven",
      goal: "quarkus:dev",
      args: ["-Ddebug=5005"],
    });
    expect(
      k.goal({ server: "quarkus-dev", debug: true, debugPort: 5006 }).args,
    ).toEqual(["-Ddebug=5006"]);
    expect(k.defaultProbe({ server: "quarkus-dev" })).toEqual({
      http: "http://localhost:8081/q/health/ready",
      timeoutMs: 300000,
    });
    expect(k.stop()).toEqual({ stdin: "q\n" });
  });
  it("falls back to the log line without a health path, and to quarkusDev on Gradle", () => {
    const k = makeKind(() => ({ ...settings, readiness: "", tool: "gradle" }));
    expect(k.defaultProbe({ server: "quarkus-dev", port: 9000 })).toEqual({
      log: "Listening on:",
      timeoutMs: 300000,
    });
    expect(k.goal({ server: "quarkus-dev" }).goal).toBe("quarkusDev");
  });
  it("Debug is the same step with debug: true", () => {
    expect(devLaunch(8081, 5005)).toMatchObject({
      name: "Quarkus dev mode (debug)",
      steps: [
        { server: "quarkus-dev", port: 8081, debug: true, debugPort: 5005 },
      ],
    });
  });
  it("the template is a batlehub-run of one quarkus-dev step", () => {
    expect(devLaunch(8081)).toEqual({
      type: "batlehub-run",
      request: "launch",
      name: "Quarkus dev mode",
      stopGraceMs: 5000,
      steps: [{ server: "quarkus-dev", port: 8081 }],
      batlehub: { template: "quarkus-dev" },
    });
  });
});

describe("the tab", () => {
  it("states dev mode, the probe in use, and escapes what it shows", () => {
    const html = tabHtml({
      detected: { tool: "maven", version: "3.40.1", module: "<m>" },
      dev: { state: "running", pid: 42, port: 8081 },
      probe: { http: "http://localhost:8081/q/health/ready" },
      missing: [],
      trusted: true,
      installed: ["quarkus-rest"],
      debug: { ok: false, reason: "needs the Java debugger" },
    });
    expect(html).toContain("running · pid 42 · port 8081");
    expect(html).toContain("http://localhost:8081/q/dev-ui/");
    expect(html).toContain("module &lt;m&gt;");
    expect(html).toMatch(/data-cmd="batlehub.java.quarkus.start" disabled/);
    expect(html).toMatch(
      /data-cmd="batlehub.java.quarkus.debug" disabled title="needs the Java debugger"/,
    );
    expect(html).toContain("quarkus-rest");
  });
});

describe("extensions (§4.2, §5.3)", () => {
  it("lists what the build file installs, Maven and Gradle", () => {
    expect(
      installedExtensions(
        fs.readFileSync(path.join(FIXTURE, "pom.xml"), "utf8"),
        "maven",
      ),
    ).toEqual(["quarkus-rest", "quarkus-smallrye-health", "quarkus-arc"]);
    expect(
      installedExtensions(
        fs.readFileSync(path.join(GRADLE, "build.gradle"), "utf8"),
        "gradle",
      ),
    ).toEqual(["quarkus-rest", "quarkus-smallrye-health", "quarkus-arc"]);
  });
  it("reads the catalogue from the platform descriptor, names kept, unlisted and installed left out", () => {
    const descriptor = JSON.stringify({
      extensions: [
        { artifact: "io.quarkus:quarkus-jackson::jar:3.40.1", name: "Jackson" },
        { artifact: "io.quarkus:quarkus-rest::jar:3.40.1", name: "REST" },
        {
          artifact: "io.quarkus:quarkus-internal::jar:3.40.1",
          name: "Internal",
          metadata: { unlisted: true },
        },
        { artifact: "io.quarkiverse:quarkus-x::jar:1.0", name: "X" },
      ],
    });
    expect(catalogue(descriptor, undefined, ["quarkus-rest"])).toEqual([
      { id: "quarkus-jackson", name: "Jackson" },
      { id: "quarkus-x", name: "X" },
    ]);
  });
  it("falls back to the BOM — an artifact with a -deployment twin — and says when neither is there", () => {
    const d = (a: string) =>
      `<dependency><groupId>io.quarkus</groupId><artifactId>${a}</artifactId><version>3.40.1</version></dependency>`;
    const bom = `<project><dependencyManagement><dependencies>${["quarkus-jackson", "quarkus-jackson-deployment", "quarkus-core", "quarkus-bootstrap-core", "quarkus-rest", "quarkus-rest-deployment"].map(d).join("")}</dependencies></dependencyManagement></project>`;
    expect(catalogue(undefined, bom, ["quarkus-rest"])).toEqual([
      { id: "quarkus-jackson", name: "quarkus-jackson" },
    ]);
    expect(catalogue(undefined, undefined, [])).toBeUndefined();
  });
  it("adds and removes through the build tool with the registry client off (measured offline on both)", () => {
    expect(extensionGoal("maven", "add", "quarkus-jackson")).toEqual({
      tool: "maven",
      goal: "quarkus:add-extension",
      args: ["-Dextensions=quarkus-jackson", "-DquarkusRegistryClient=false"],
    });
    expect(extensionGoal("gradle", "remove", "quarkus-jackson")).toEqual({
      tool: "gradle",
      goal: "removeExtension",
      args: ["--extensions=quarkus-jackson", "-DquarkusRegistryClient=false"],
    });
  });
});

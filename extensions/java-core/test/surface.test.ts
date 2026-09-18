import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { commandFor, type JavaTaskDefinition } from "../src/build/tasks";
import { codeActionParams } from "../src/generate/menu";
import { configurationsOf, convert, plan } from "../src/idea/import";
import { issueUrl } from "../src/report/report";
import { crc32, zip } from "../src/report/zip";

const folder = {
  folder: "/w",
  tool: "maven" as const,
  buildFile: "/w/pom.xml",
  wrapper: undefined,
  resolution: { reason: "none" as const },
  mavenProfiles: [],
};

describe("the batlehub-java task command line (§4.2 Running build commands)", () => {
  it("uses the wrapper, the configuration's settings and toolchains, and the active profiles, as an argument array", () => {
    const def: JavaTaskDefinition = {
      type: "batlehub-java",
      tool: "maven",
      goal: "clean package",
      args: ["-DskipTests"],
    };
    expect(
      commandFor(
        def,
        { ...folder, wrapper: "/w/mvnw" },
        {
          name: "corp",
          settingsFile: "/h/.m2/settings-corp.xml",
          toolchainsFile: "/h/.m2/t.xml",
        },
        ["dev"],
      ),
    ).toEqual({
      cmd: "/w/mvnw",
      args: [
        "-B",
        "-s",
        "/h/.m2/settings-corp.xml",
        "-t",
        "/h/.m2/t.xml",
        "-P",
        "dev",
        "clean",
        "package",
        "-DskipTests",
      ],
    });
    expect(
      commandFor(
        {
          type: "batlehub-java",
          tool: "maven",
          goal: "test",
          profiles: ["ci"],
        },
        folder,
        { name: "d", profiles: ["dev"] },
        ["dev"],
      ),
    ).toEqual({ cmd: "mvn", args: ["-B", "-P", "ci", "test"] });
    expect(
      commandFor(
        { type: "batlehub-java", tool: "maven", goal: "test" },
        folder,
        { name: "d", mavenHome: "/opt/mvn", profiles: ["dev"] },
        undefined,
      ),
    ).toEqual({ cmd: "/opt/mvn/bin/mvn", args: ["-B", "-P", "dev", "test"] });
    expect(
      commandFor(
        { type: "batlehub-java", tool: "gradle", goal: "build -x test" },
        { ...folder, tool: "gradle", wrapper: "/w/gradlew" },
        undefined,
        undefined,
      ),
    ).toEqual({ cmd: "/w/gradlew", args: ["build", "-x", "test"] });
  });
});

describe("the generators' argument (spike b)", () => {
  it("is one CodeActionParams, with kind only for accessors", () => {
    const sel = {
      start: { line: 3, character: 0 },
      end: { line: 3, character: 5 },
    };
    expect(codeActionParams("file:///A.java", sel, 1)).toEqual({
      textDocument: { uri: "file:///A.java" },
      range: sel,
      context: { diagnostics: [] },
      kind: 1,
    });
    expect(codeActionParams("file:///A.java", sel)).not.toHaveProperty("kind");
  });
});

describe("Report a problem", () => {
  it("prefills the issue form, or the report.url override", () => {
    const u = new URL(issueUrl("", "Java: x", "body"));
    expect(u.origin + u.pathname).toBe(
      "https://github.com/batleforc/batlehub-vsx/issues/new",
    );
    expect(u.searchParams.get("template")).toBe("java-problem.yml");
    expect(u.searchParams.get("body")).toBe("body");
    const o = new URL(
      issueUrl("https://forge.example/x/-/issues/new", "t", "b"),
    );
    expect(o.host).toBe("forge.example");
    expect(o.searchParams.get("template")).toBeNull();
  });
  it("writes a zip a reader can walk: local headers, deflate where it pays, a central directory", () => {
    const small = "hi";
    const big = "x".repeat(2000) + "y".repeat(2000);
    const z = zip(
      [
        { name: "a.txt", data: small },
        { name: "dir/b.txt", data: big },
      ],
      new Date(2026, 8, 17, 12, 0, 0),
    );
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    expect(z.readUInt16LE(8)).toBe(0); // stored: deflating "hi" does not pay
    const nameLen = z.readUInt16LE(26);
    expect(z.subarray(30, 30 + nameLen).toString()).toBe("a.txt");
    const second = 30 + nameLen + z.readUInt32LE(18);
    expect(z.readUInt32LE(second)).toBe(0x04034b50);
    expect(z.readUInt16LE(second + 8)).toBe(8); // deflated
    const n2 = z.readUInt16LE(second + 26);
    const len2 = z.readUInt32LE(second + 18);
    const body = z.subarray(second + 30 + n2, second + 30 + n2 + len2);
    expect(inflateRawSync(body).toString()).toBe(big);
    expect(z.readUInt32LE(second + 14)).toBe(crc32(Buffer.from(big)));
    const eocd = z.length - 22;
    expect(z.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(z.readUInt16LE(eocd + 10)).toBe(2);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("IntelliJ run configurations → launch.json (decision 33)", () => {
  const app = `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Run App" type="Application" factoryName="Application">
    <option name="MAIN_CLASS_NAME" value="com.acme.app.Main" />
    <module name="app" />
    <option name="PROGRAM_PARAMETERS" value="--fast &quot;two words&quot;" />
    <option name="VM_PARAMETERS" value="-Xmx1g" />
    <option name="WORKING_DIRECTORY" value="$PROJECT_DIR$/app" />
    <envs><env name="MODE" value="dev" /></envs>
  </configuration>
</component>`;
  const ws = `<component name="RunManager" selected="Application.Run App">
  <configuration default="true" type="Application"><option name="MAIN_CLASS_NAME" value="" /></configuration>
  <configuration name="Attach" type="Remote"><option name="HOST" value="127.0.0.1" /><option name="PORT" value="5006" /></configuration>
  <configuration name="All in package" type="JUnit"><option name="PACKAGE_NAME" value="com.acme" /><option name="TEST_OBJECT" value="package" /></configuration>
  <configuration name="One class" type="JUnit"><option name="MAIN_CLASS_NAME" value="com.acme.app.MainTest" /><module name="app" /></configuration>
  <configuration name="Gradle build" type="GradleRunConfiguration" />
</component>`;
  it("converts Application, Remote and class-scoped JUnit; reports the rest; skips defaults", () => {
    expect(configurationsOf(ws)).toHaveLength(4);
    const p = plan([
      { path: "a.xml", xml: app },
      { path: "workspace.xml", xml: ws },
    ]);
    expect(p.configs.map((c) => [c.name, c.request])).toEqual([
      ["Run App", "launch"],
      ["Attach", "attach"],
      ["One class", "launch"],
    ]);
    expect(p.configs[0]).toMatchObject({
      mainClass: "com.acme.app.Main",
      projectName: "app",
      args: '--fast "two words"',
      vmArgs: "-Xmx1g",
      cwd: "${workspaceFolder}/app",
      env: { MODE: "dev" },
      batlehub: { template: "idea:Application" },
    });
    expect(p.configs[1]).toMatchObject({ hostName: "127.0.0.1", port: 5006 });
    expect(p.configs[2]).toMatchObject({
      mainClass: "org.junit.platform.console.ConsoleLauncher",
      args: "--select-class com.acme.app.MainTest",
    });
    expect(p.skipped.map((s) => s.type)).toEqual([
      "JUnit",
      "GradleRunConfiguration",
    ]);
    expect(
      convert('<configuration name="x" type="Application"></configuration>')
        .skipped?.reason,
    ).toContain("MAIN_CLASS_NAME");
  });
});

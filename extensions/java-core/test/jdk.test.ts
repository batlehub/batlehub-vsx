import { describe, expect, it } from "vitest";
import {
  discover,
  type Io,
  majorOf,
  parseMiseLs,
  parseRelease,
  runtimeName,
} from "../src/jdk/discover";
import {
  availableManagers,
  chooseManager,
  installCommand,
  parseMiseRemote,
  parseSdkList,
} from "../src/jdk/install";
import { resolve, toSettingsRuntimes } from "../src/jdk/resolve";
import { homeWithBin, miseHome } from "../src/detect";

const release = (v: string, vendor = "Eclipse Adoptium") =>
  `IMPLEMENTOR="${vendor}"\nJAVA_VERSION="${v}"\n`;

function fakeIo(
  fs: Record<string, string>,
  dirs: Record<string, string[]>,
  exec: Record<string, string> = {},
  env: NodeJS.ProcessEnv = {},
): Io {
  return {
    readFile: (p) => fs[p],
    readDir: (p) => dirs[p] ?? [],
    isDir: (p) => p in dirs,
    exec: async (cmd, args) => exec[`${cmd} ${args.join(" ")}`],
    env,
    home: "/home/u",
    platform: "linux",
  };
}

describe("the release file and versions", () => {
  it("parses release, majors and runtime names", () => {
    expect(parseRelease(release("21.0.11"))).toEqual({
      version: "21.0.11",
      vendor: "Eclipse Adoptium",
    });
    expect(parseRelease("nothing")).toBeUndefined();
    expect(majorOf("21.0.11")).toBe(21);
    expect(majorOf("1.8.0_392")).toBe(8);
    expect(majorOf("17")).toBe(17);
    expect(runtimeName(8)).toBe("JavaSE-1.8");
    expect(runtimeName(21)).toBe("JavaSE-21");
  });
  it("reads mise's json and skips what is not installed", () => {
    expect(
      parseMiseLs(
        JSON.stringify([
          { version: "temurin-21", install_path: "/m/21", installed: true },
          { version: "temurin-17", install_path: "/m/17", installed: false },
        ]),
      ),
    ).toEqual(["/m/21"]);
    expect(parseMiseLs("not json")).toEqual([]);
  });
});

describe("discovery", () => {
  const fs = {
    "/m/21/release": release("21.0.11"),
    "/home/u/.sdkman/candidates/java/17.0.9-tem/release": release("17.0.9"),
    "/usr/lib/jvm/java-11/release": release("11.0.2", "Debian"),
    "/env/jdk/release": release("25.0.4"),
  };
  const dirs = {
    "/home/u/.sdkman/candidates/java": ["17.0.9-tem", "current"],
    "/usr/lib/jvm": ["java-11", "not-a-jdk"],
  };
  const exec = {
    "mise ls java --json": JSON.stringify([
      { install_path: "/m/21", installed: true },
    ]),
  };
  it("walks the sources in order, newest first, deduplicated by path", async () => {
    const rt = await discover(
      fakeIo(fs, dirs, exec, { JAVA_HOME: "/env/jdk/" }),
      ["mise", "sdkman", "env", "wellKnown"],
    );
    expect(rt.map((r) => [r.major, r.source])).toEqual([
      [25, "env"],
      [21, "mise"],
      [17, "sdkman"],
      [11, "wellKnown"],
    ]);
  });
  it("respects the source list and merges settings entries", async () => {
    const rt = await discover(
      fakeIo(fs, dirs, exec),
      ["sdkman"],
      [
        { name: "JavaSE-21", path: "/m/21" },
        { name: "JavaSE-8", path: "/gone" },
      ],
    );
    expect(rt.map((r) => [r.major, r.source, r.version])).toEqual([
      [21, "settings", "21.0.11"],
      [17, "sdkman", "17.0.9"],
      [8, "settings", "8"],
    ]);
    expect(await discover(fakeIo(fs, dirs, exec), [])).toEqual([]);
  });
  it("runs nothing when exec is disabled (untrusted)", async () => {
    const rt = await discover(fakeIo(fs, dirs, {}), ["mise", "sdkman"]);
    expect(rt.map((r) => r.source)).toEqual(["sdkman"]);
  });
});

describe("the resolution table of §4.2", () => {
  const rt = [
    {
      name: "JavaSE-25",
      path: "/25",
      version: "25",
      major: 25,
      source: "mise" as const,
    },
    {
      name: "JavaSE-17",
      path: "/17",
      version: "17",
      major: 17,
      source: "mise" as const,
    },
    {
      name: "JavaSE-21",
      path: "/21",
      version: "21",
      major: 21,
      source: "mise" as const,
    },
  ];
  it("prefers the exact requirement, then the lowest in range, then the newest, then none", () => {
    expect(resolve(rt, { min: 17, origin: "x" })).toMatchObject({
      runtime: { major: 17 },
      reason: "matches",
    });
    expect(resolve(rt, { min: 19, origin: "x" })).toMatchObject({
      runtime: { major: 21 },
      reason: "matches",
    });
    expect(resolve(rt, { min: 30, origin: "x" })).toMatchObject({
      runtime: { major: 25 },
      reason: "newest",
    });
    expect(resolve(rt)).toMatchObject({
      runtime: { major: 25 },
      reason: "newest",
    });
    expect(resolve(rt, { min: 17, origin: "x" }, false)).toMatchObject({
      runtime: { major: 25 },
      reason: "newest",
    });
    expect(resolve([], { min: 17, origin: "x" })).toEqual({
      required: { min: 17, origin: "x" },
      reason: "none",
    });
  });
  it("writes one entry per name with the resolved one default", () => {
    const two21 = [
      ...rt,
      {
        name: "JavaSE-21",
        path: "/21b",
        version: "21.0.3",
        major: 21,
        source: "sdkman" as const,
      },
    ];
    expect(toSettingsRuntimes(two21, rt[2])).toEqual([
      { name: "JavaSE-25", path: "/25" },
      { name: "JavaSE-17", path: "/17" },
      { name: "JavaSE-21", path: "/21", default: true },
    ]);
  });
});

describe("install by manager (decision 10)", () => {
  it("finds managers, picks in order, lists offers, builds argument arrays", async () => {
    const io = fakeIo(
      {},
      { "/home/u/.sdkman/bin": [] },
      {
        "mise --version": "mise 2026",
        "mise ls-remote java":
          "temurin-17.0.1\ntemurin-21.0.1\ntemurin-21.0.11+10.0.LTS\nzulu-21.0.1\ntemurin-25.0.4+101.0.LTS\n",
      },
    );
    expect(await availableManagers(io)).toEqual(["mise", "sdkman"]);
    expect(await chooseManager(io, "auto")).toBe("mise");
    expect(await chooseManager(io, "sdkman")).toBe("sdkman");
    expect(await chooseManager(io, "none")).toBeUndefined();
    expect(await chooseManager(fakeIo({}, {}), "auto")).toBeUndefined();
    expect(
      parseMiseRemote((await io.exec("mise", ["ls-remote", "java"])) ?? ""),
    ).toEqual([
      { id: "temurin-25.0.4+101.0.LTS", major: 25 },
      { id: "temurin-21.0.11+10.0.LTS", major: 21 },
      { id: "temurin-17.0.1", major: 17 },
    ]);
    expect(
      parseSdkList(
        "| Temurin | >>> | 21.0.5 | tem | installed | 21.0.5-tem\n|         |     | 17.0.13 | tem |  | 17.0.13-tem\n",
      ),
    ).toEqual([
      { id: "21.0.5-tem", major: 21 },
      { id: "17.0.13-tem", major: 17 },
    ]);
    expect(installCommand("mise", "temurin-21.0.11+10.0.LTS")).toEqual([
      "mise",
      "use",
      "-g",
      "java@temurin-21.0.11+10.0.LTS",
    ]);
    expect(installCommand("sdkman", "21.0.5-tem")).toEqual([
      "sdk",
      "install",
      "java",
      "21.0.5-tem",
    ]);
  });
});

describe("a build tool's home from mise (feedback 22)", () => {
  it("accepts the install itself or the one nested distribution directory", async () => {
    const fs = {
      "/m/gradle/8.14.5/bin/gradle": "#!",
      "/m/maven/3.9.16/apache-maven-3.9.16/bin/mvn": "#!",
    };
    const dirs = {
      "/m/maven/3.9.16": ["apache-maven-3.9.16", "LICENSE"],
      "/m/gradle/8.14.5": ["bin", "lib"],
    };
    const io = fakeIo(fs, dirs, {
      "mise ls maven --json": JSON.stringify([
        { install_path: "/m/maven/3.9.16", installed: true },
      ]),
      "mise ls gradle --json": JSON.stringify([
        { install_path: "/m/gradle/8.14.5", installed: true },
      ]),
    });
    expect(homeWithBin(io, "/m/gradle/8.14.5", "gradle")).toBe(
      "/m/gradle/8.14.5",
    );
    expect(await miseHome(io, "maven", "mvn")).toBe(
      "/m/maven/3.9.16/apache-maven-3.9.16",
    );
    expect(await miseHome(io, "gradle", "gradle")).toBe("/m/gradle/8.14.5");
    expect(await miseHome(fakeIo({}, {}), "maven", "mvn")).toBeUndefined();
  });
});

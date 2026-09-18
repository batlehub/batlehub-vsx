import { describe, expect, it } from "vitest";
import {
  initScript,
  parseDependencies,
  parseTasks,
} from "../src/build/gradle/tasks";
import { conflicts, flatten, parseTree } from "../src/build/maven/deptree";
import { activeProfilesOf, setActiveProfiles } from "../src/build/maven/m2e";
import { overlayOf } from "../src/build/maven/overlay";
import {
  hasLink,
  setLink,
  settingsProfiles,
  unsetLink,
} from "../src/build/maven/settings";
import {
  parseVerdict,
  splitRegistryUrl,
  verdictOf,
  verdictUrl,
} from "../src/registry/verdicts";

const SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<settings>
  <!-- my own comment -->
  <mirrors>
    <mirror><id>corp</id><url>https://corp/maven</url><mirrorOf>central</mirrorOf></mirror>
  </mirrors>
  <profiles>
    <profile><id>corp</id></profile>
  </profiles>
  <activeProfiles><activeProfile>corp</activeProfile></activeProfiles>
</settings>
`;

describe("the settings.xml block (§4.2 registry link, §7)", () => {
  it("set · set · unset leaves the fixture byte-identical", () => {
    const once = setLink(SETTINGS, {
      url: "https://hub/proxy/maven",
      token: "bh_pat_x",
    });
    expect(hasLink(once)).toBe(true);
    expect(once).toContain("<!-- batlehub:mirror -->");
    expect(once).toContain("<value>Bearer bh_pat_x</value>");
    expect(once).not.toContain("<password>");
    expect(once).toContain("<id>corp</id>"); // the user's own mirror stays
    const twice = setLink(once, {
      url: "https://hub/proxy/maven2",
      token: null,
    });
    expect(twice).toContain("maven2");
    expect(twice).not.toContain("bh_pat_x");
    expect(twice).not.toContain("<servers>");
    expect(unsetLink(twice)).toBe(SETTINGS);
    expect(unsetLink(once)).toBe(SETTINGS);
  });
  it("creates the skeleton and the sections when absent, and removes what it created", () => {
    const fresh = setLink(undefined, {
      url: "https://hub/proxy/maven",
      token: "t",
    });
    expect(fresh).toContain("<mirrors>");
    expect(fresh).toContain("<servers>");
    const gone = unsetLink(fresh);
    expect(gone).not.toContain("<mirrors>");
    expect(gone).not.toContain("batlehub");
    expect(unsetLink("")).toBe("");
  });
  it("reads declared and active profiles of a settings file", () => {
    expect(settingsProfiles(SETTINGS)).toEqual({
      declared: ["corp"],
      active: ["corp"],
    });
  });
});

describe("m2e preference and the overlay (decision 14)", () => {
  it("writes activeProfiles= keeping other keys, sorted, and reads it back", () => {
    const p = setActiveProfiles(
      "eclipse.preferences.version=1\nactiveProfiles=old\nlifecycleMappingId=x\n",
      ["dev", "ci"],
    );
    expect(p).toBe(
      "activeProfiles=dev,ci\neclipse.preferences.version=1\nlifecycleMappingId=x\nresolveWorkspaceProjects=true\nversion=1\n",
    );
    expect(activeProfilesOf(p)).toEqual(["dev", "ci"]);
    expect(activeProfilesOf(undefined)).toEqual([]);
  });
  it("keeps only what the import needs and adds the profiles", () => {
    const o = overlayOf(
      `<settings><servers><server><id>s</id><password>p</password></server></servers><proxies><proxy/></proxies>${SETTINGS.slice(SETTINGS.indexOf("<mirrors>"), SETTINGS.indexOf("</settings>"))}</settings>`,
      ["dev"],
    );
    expect(o).toContain("<servers>");
    expect(o).toContain("<mirrors>");
    expect(o).toContain("<profiles>");
    expect(o).not.toContain("<proxies>");
    expect(o).toContain("<activeProfile>corp</activeProfile>");
    expect(o).toContain("<activeProfile>dev</activeProfile>");
    expect(o).toContain("gitignored, 0600");
  });
});

const TREE = `com.acme:app:jar:1.0.0-SNAPSHOT
+- com.acme:core:jar:1.0.0-SNAPSHOT:compile
|  \\- org.slf4j:slf4j-api:jar:2.0.9:compile
+- org.junit.jupiter:junit-jupiter:jar:5.11.4:test
|  +- org.junit.jupiter:junit-jupiter-api:jar:5.11.4:test
|  |  \\- org.opentest4j:opentest4j:jar:1.3.0:test
|  \\- org.slf4j:slf4j-api:jar:1.7.36:test (version managed from 1.7.36; omitted for conflict with 2.0.9)
\\- org.apache.commons:commons-lang3:jar:3.17.0:compile
`;

describe("dependency:tree parsing", () => {
  it("builds the tree with scopes, depths and conflicts", () => {
    const t = parseTree(TREE)!;
    expect(t.id).toBe("com.acme:app:1.0.0-SNAPSHOT");
    expect(t.children.map((c) => c.artifactId)).toEqual([
      "core",
      "junit-jupiter",
      "commons-lang3",
    ]);
    expect(t.children[0]!.children[0]).toMatchObject({
      artifactId: "slf4j-api",
      version: "2.0.9",
      scope: "compile",
    });
    expect(t.children[1]!.children[0]!.children[0]).toMatchObject({
      artifactId: "opentest4j",
    });
    const lost = t.children[1]!.children[1]!;
    expect(lost).toMatchObject({
      artifactId: "slf4j-api",
      version: "1.7.36",
      omitted: "conflict",
      conflict: "2.0.9",
    });
    expect(conflicts(t)).toEqual({
      "org.slf4j:slf4j-api": { won: "2.0.9", lost: ["1.7.36"] },
    });
    expect(flatten(t)).toHaveLength(8);
    expect(
      parseTree("[INFO] " + TREE.split("\n").join("\n[INFO] "))?.children,
    ).toHaveLength(3);
  });
});

describe("gradle output parsing and the init script", () => {
  it("reads tasks --all and dependencies", () => {
    const tasks = parseTasks(
      "\nBuild tasks\n-----------\nassemble - Assembles the outputs of this project.\nbuild - Assembles and tests this project.\n\nOther tasks\n-----------\ncompileJava\n",
    );
    expect(tasks).toEqual([
      {
        name: "assemble",
        group: "build",
        description: "Assembles the outputs of this project.",
      },
      {
        name: "build",
        group: "build",
        description: "Assembles and tests this project.",
      },
      { name: "compileJava", group: "other", description: undefined },
    ]);
    const deps = parseDependencies(
      "runtimeClasspath - Runtime classpath of source set 'main'.\n+--- project :core\n+--- org.slf4j:slf4j-api:1.7.36 -> 2.0.9\n\\--- com.google.guava:guava:33.0.0-jre\n     \\--- org.slf4j:slf4j-api:2.0.9 (*)\n\n(*) - Indicates repeated occurrences\n",
    )!;
    expect(deps.children.map((c) => c.artifactId)).toEqual([
      ":core",
      "slf4j-api",
      "guava",
    ]);
    expect(deps.children[1]).toMatchObject({
      version: "1.7.36",
      omitted: "conflict",
      conflict: "2.0.9",
    });
    expect(deps.children[2]!.children[0]).toMatchObject({
      artifactId: "slf4j-api",
      omitted: "duplicate",
    });
  });
  it("writes the mirror and the bearer header into init.gradle", () => {
    const s = initScript("https://hub/proxy/maven", "tok");
    expect(s).toContain('url = "https://hub/proxy/maven"');
    expect(s).toContain('value = "Bearer tok"');
    expect(initScript("https://hub/proxy/maven", null)).not.toContain("Bearer");
  });
});

describe("verdicts (BatleHub RFC 0018)", () => {
  it("builds the URL from the registry link and maps the state", async () => {
    expect(splitRegistryUrl("https://hub.example/proxy/maven/")).toEqual({
      hub: "https://hub.example",
      registry: "maven",
    });
    expect(splitRegistryUrl("https://hub.example/")).toBeUndefined();
    expect(splitRegistryUrl("https://hub.example/proxy/mvn-1/maven2")).toEqual({
      hub: "https://hub.example",
      registry: "mvn-1",
    });
    expect(
      verdictUrl(
        "https://hub.example/proxy/maven",
        "org.slf4j",
        "slf4j-api",
        "2.0.9",
      ),
    ).toBe(
      "https://hub.example/api/v1/verdicts/maven/org.slf4j%3Aslf4j-api/2.0.9",
    );
    expect(
      parseVerdict({ state: "Warned", reason_codes: ["SCAN_PENDING"] }),
    ).toEqual({ state: "warned", reasons: ["SCAN_PENDING"] });
    expect(parseVerdict({})).toEqual({ state: "unknown", reasons: [] });
    const calls: string[] = [];
    const fetchImpl = async (url: string, h: Record<string, string>) => {
      calls.push(`${url} ${h.Authorization ?? ""}`);
      return {
        status: url.includes("guava") ? 404 : 200,
        json: async () => ({ state: "allowed", reason_codes: [] }),
      };
    };
    expect(
      await verdictOf(
        "https://hub.example/proxy/maven",
        "t",
        { groupId: "org.slf4j", artifactId: "slf4j-api", version: "2.0.9" },
        fetchImpl,
      ),
    ).toEqual({ state: "allowed", reasons: [] });
    expect(
      await verdictOf(
        "https://hub.example/proxy/maven",
        "t",
        { groupId: "com.google.guava", artifactId: "guava", version: "33" },
        fetchImpl,
      ),
    ).toBeUndefined();
    expect(
      await verdictOf(
        "https://hub.example/proxy/maven",
        "t",
        { groupId: "org.slf4j", artifactId: "slf4j-api", version: "2.0.9" },
        fetchImpl,
      ),
    ).toEqual({ state: "allowed", reasons: [] });
    expect(calls).toHaveLength(2); // the second slf4j read came from the cache
    expect(calls[0]).toContain("Bearer t");
  });
});

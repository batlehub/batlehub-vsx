import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Io } from "@batlehub/java-rules/discover";
import { applyEdits, plan, Refused, write } from "../apply.ts";
import { main, parseTarget, summary, usage } from "../cli.ts";
import { toolSchemas, VERBS } from "@batlehub/java-rules/verbs";
import { capCheck, EXIT, javaFiles, serverJdk, workspaceRoot } from "../ops.ts";
import {
  failed,
  json,
  sarif,
  text,
  unifiedDiff,
  type Finding,
} from "../render.ts";
import { escapes, PIN, serverIn } from "../server.ts";

const row = (
  code: string,
  line: number,
  severity: Finding["severity"],
  fix = false,
): Finding => ({
  path: "core/Greeter.java",
  ruleId: code.split("/")[1]!,
  area: code.split("/")[0]!,
  code,
  message: `${code} message`,
  severity,
  range: {
    start: { line: line - 1, character: 2 },
    end: { line: line - 1, character: 8 },
  },
  ...(fix ? { fixTitle: "fix it" } : {}),
});
const rows = [
  row("unused/privateField", 8, "warning", true),
  row("collections/sizeIsZero", 23, "info", true),
];

/** A machine with exactly these JDKs (home → JAVA_VERSION), found by mise. */
const fakeIo = (
  jdks: Record<string, string>,
  env: NodeJS.ProcessEnv = {},
): Io => ({
  readFile: (p) => {
    const home = p.replace(/\/release$/, "");
    return jdks[home]
      ? `JAVA_VERSION="${jdks[home]}"\nIMPLEMENTOR="Eclipse Adoptium"`
      : undefined;
  },
  readDir: () => [],
  isDir: () => false,
  exec: async (cmd) =>
    cmd === "mise"
      ? JSON.stringify(
          Object.keys(jdks).map((install_path) => ({
            install_path,
            installed: true,
          })),
        )
      : undefined,
  env,
  home: "/home/u",
  platform: "linux",
});

describe("the server pin (§9 version coupling)", () => {
  it("is java-core's MIN_REDHAT_JAVA", () => {
    const mode = readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "extensions/java-core/src/server/mode.ts",
      ),
      "utf8",
    );
    expect(/MIN_REDHAT_JAVA = "([^"]+)"/.exec(mode)?.[1]).toBe(PIN.version);
    expect(PIN.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("refuses a VSIX entry that would leave its directory (§7)", () => {
    for (const bad of [
      "../x",
      "a/../../x",
      "/etc/passwd",
      "C:\\x",
      "a\\..\\..\\x",
    ])
      expect(escapes(bad)).toBe(true);
    for (const ok of [
      "extension/server/plugins/a.jar",
      "extension.vsixmanifest",
      "a..b/c",
    ])
      expect(escapes(ok)).toBe(false);
  });
  it("finds the server in either layout BATLEHUB_JDTLS_HOME may name", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "engine-"));
    mkdirSync(path.join(d, "extension", "server", "plugins"), {
      recursive: true,
    });
    expect(serverIn(d)).toBe(path.join(d, "extension", "server"));
    expect(serverIn(path.join(d, "extension", "server"))).toBe(
      path.join(d, "extension", "server"),
    );
    expect(serverIn(path.join(d, "extension"))).toBeUndefined();
  });
});

describe("the workspace (§4.2, §4.3)", () => {
  const exists = (have: string[]) => (p: string) => have.includes(p);
  it("is the nearest ancestor holding a build file or .git", () => {
    expect(
      workspaceRoot("core/src", {
        cwd: "/home/u/repo",
        home: "/home/u",
        exists: exists(["/home/u/repo/pom.xml", "/home/u/repo/core/pom.xml"]),
      }),
    ).toBe("/home/u/repo/core");
    expect(
      workspaceRoot(".", {
        cwd: "/projects/app/core",
        home: "/home/u",
        exists: exists(["/projects/app/.git"]),
      }),
    ).toBe("/projects/app");
  });
  it("is refused at / and outside what the caller stands in or owns", () => {
    expect(() =>
      workspaceRoot(".", { cwd: "/", home: "/home/u", exists: exists([]) }),
    ).toThrow(/neither/);
    expect(() =>
      workspaceRoot(".", {
        cwd: "/home/u",
        home: "/home/u",
        explicit: "/srv/other",
        exists: exists([]),
      }),
    ).toThrow(/neither/);
    expect(
      workspaceRoot(".", {
        cwd: "/projects",
        home: "/home/u",
        explicit: "app",
        exists: exists([]),
      }),
    ).toBe("/projects/app");
  });
});

describe("the server's JDK (use case 5)", () => {
  it("picks the lowest JDK ≥ 21, as the server needs", async () => {
    const r = await serverJdk(
      fakeIo({ "/m/17": "17.0.20", "/m/21": "21.0.11", "/m/25": "25.0.4" }),
    );
    expect([r.name, r.version, r.source]).toEqual([
      "JavaSE-21",
      "21.0.11",
      "mise",
    ]);
  });
  it("is exit 2 and the one install line when there is none, or only an older one", async () => {
    for (const jdks of [{}, { "/m/17": "17.0.20" }] as Record<
      string,
      string
    >[]) {
      const e = await serverJdk(fakeIo(jdks)).catch((x) => x);
      expect([e.code, e.message]).toEqual([
        EXIT.unusable,
        "no JDK ≥ 21: install one with 'mise use java@temurin-21'",
      ]);
    }
  });
  it("takes BATLEHUB_JAVA_HOME over discovery, and refuses a wrong one", async () => {
    expect(
      (
        await serverJdk(
          fakeIo(
            { "/f/21": "21.0.2", "/m/25": "25" },
            { BATLEHUB_JAVA_HOME: "/f/21/" },
          ),
        )
      ).path,
    ).toBe("/f/21");
    await expect(
      serverJdk(fakeIo({}, { BATLEHUB_JAVA_HOME: "/nope" })),
    ).rejects.toThrow("BATLEHUB_JAVA_HOME=/nope is not a JDK ≥ 21");
  });
});

describe("the declared cap (§4.2, §4.3)", () => {
  const cgroup = (v?: string) => (p: string) =>
    p === "/sys/fs/cgroup/memory.max" ? v : undefined;
  it("fits under the limit, or is exit 2 naming both and the live editor", () => {
    expect(capCheck("1G", cgroup(String(2 * 2 ** 30)))).toEqual({
      cap: 2 ** 30,
      limit: 2 * 2 ** 30,
    });
    expect(capCheck("1G", cgroup("max")).limit).toBeUndefined();
    const e = (() => {
      try {
        capCheck("2G", cgroup(String(2 ** 30)));
      } catch (x) {
        return x as { code: number; message: string };
      }
    })();
    expect(e?.code).toBe(EXIT.unusable);
    expect(e?.message).toMatch(/2 GiB .* 1 GiB.*live editor/);
    expect(() => capCheck("lots", cgroup())).toThrow(/not a size/);
  });
});

describe("rendering (§4.2 output formats)", () => {
  it("fails at or above --fail-on", () => {
    expect(failed(rows, "hint")).toBe(true);
    expect(failed(rows, "warning")).toBe(true);
    expect(failed(rows, "error")).toBe(false);
    expect(failed([], "hint")).toBe(false);
  });
  it("prints path:line:col code message, 1-based, [fix] when there is one", () => {
    expect(text(rows).split("\n")).toEqual([
      "core/Greeter.java:8:3 unused/privateField unused/privateField message [fix]",
      "core/Greeter.java:23:3 collections/sizeIsZero collections/sizeIsZero message [fix]",
    ]);
  });
  it("keeps the bundle's rows verbatim in JSON, with the exit", () => {
    const d = JSON.parse(json(rows, 1));
    expect(d.exit).toBe(1);
    expect(Object.keys(d.findings[0]).sort()).toEqual([
      "area",
      "code",
      "fixTitle",
      "message",
      "path",
      "range",
      "ruleId",
      "severity",
    ]);
  });
  it("renders SARIF 2.1.0 with one rule per code and info as a note", () => {
    const d = JSON.parse(sarif(rows, "1.56.0"));
    expect(d.version).toBe("2.1.0");
    expect(
      d.runs[0].tool.driver.rules.map((r: { id: string }) => r.id),
    ).toEqual(["collections/sizeIsZero", "unused/privateField"]);
    expect(d.runs[0].results.map((r: { level: string }) => r.level)).toEqual([
      "warning",
      "note",
    ]);
    expect(d.runs[0].results[1].locations[0].physicalLocation.region).toEqual({
      startLine: 23,
      startColumn: 3,
      endLine: 23,
      endColumn: 9,
    });
  });
});

describe("files and arguments", () => {
  it("walks only the server's source roots, under the paths asked for", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "engine-"));
    for (const f of [
      "core/src/main/java/a/A.java",
      "core/src/main/java/a/B.txt",
      "app/src/main/java/b/C.java",
      "core/target/gen/D.java",
    ]) {
      mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      writeFileSync(path.join(d, f), "");
    }
    const roots = [
      path.join(d, "core/src/main/java"),
      path.join(d, "app/src/main/java"),
    ];
    expect(javaFiles(roots, [d]).map((f) => path.relative(d, f))).toEqual([
      "app/src/main/java/b/C.java",
      "core/src/main/java/a/A.java",
    ]);
    expect(
      javaFiles(roots, [path.join(d, "core")]).map((f) => path.relative(d, f)),
    ).toEqual(["core/src/main/java/a/A.java"]);
  });
  it("refuses a bad flag or verb with exit 2 before starting anything", async () => {
    const out: string[] = [];
    const say = (l: string) => out.push(l);
    expect(await main(["inspect", "--format", "xml"], say, say)).toBe(
      EXIT.unusable,
    );
    expect(await main(["inspect", "--fail-on", "fatal"], say, say)).toBe(
      EXIT.unusable,
    );
    expect(await main(["java", "teleport"], say, say)).toBe(EXIT.unusable);
    expect(await main(["rename", "a.B#c"], say, say)).toBe(EXIT.unusable);
    expect(await main(["rename", "a..b", "x"], say, say)).toBe(EXIT.unusable);
    expect(await main(["fix", "--format", "sarif"], say, say)).toBe(
      EXIT.unusable,
    );
    expect(await main(["--help"], say, say)).toBe(EXIT.ok);
    expect(out.join("\n")).toMatch(
      /--format must be one of text, json, sarif[\s\S]*--fail-on must be one of[\s\S]*unknown verb teleport[\s\S]*rename takes two arguments[\s\S]*symbol a\.\.b: expected[\s\S]*sarif is for inspect only/,
    );
  });
});

describe("apply (§4.2 dry run by default, §4.3 refusals)", () => {
  const edit = (line: number, from: number, to: number, newText: string) => ({
    range: { start: { line, character: from }, end: { line, character: to } },
    newText,
  });
  const ws = () => {
    const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), "engine-")));
    writeFileSync(
      path.join(d, "A.java"),
      "class A {\n  boolean e() { return l.size() == 0; }\n}\n",
    );
    return d;
  };
  it("applies LSP edits by line and UTF-16 character, last first", () => {
    const t = "ab\ncdé\nf\n";
    expect(
      applyEdits(t, [
        edit(0, 0, 1, "X"),
        edit(1, 2, 3, "E"),
        edit(2, 1, 1, "!"),
      ]),
    ).toBe("Xb\ncdE\nf!\n");
    expect(() =>
      applyEdits(t, [edit(0, 0, 2, "x"), edit(0, 1, 2, "y")]),
    ).toThrow("overlapping");
  });
  it("plans without writing, and writes only what was planned", () => {
    const d = ws();
    const f = path.join(d, "A.java");
    const before = readFileSync(f, "utf8");
    const p = plan({
      changes: { [pathToFileURL(f).href]: [edit(1, 23, 36, "l.isEmpty()")] },
    });
    expect(p.map((x) => [path.basename(x.file), x.edits])).toEqual([
      ["A.java", 1],
    ]);
    expect(readFileSync(f, "utf8")).toBe(before);
    write(p, d, new Map([[f, statSync(f).mtimeMs]]));
    expect(readFileSync(f, "utf8")).toContain("return l.isEmpty();");
    expect(summary(p)).toBe("1 file, 1 edit");
    expect(summary([])).toBe("0 files");
  });
  it("refuses a file changed since the server read it, and writes nothing", () => {
    const d = ws();
    const f = path.join(d, "A.java");
    const p = plan({
      changes: { [pathToFileURL(f).href]: [edit(1, 23, 36, "l.isEmpty()")] },
    });
    const seen = new Map([[f, statSync(f).mtimeMs]]);
    writeFileSync(f, "class A {}\n");
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(() => write(p, d, seen)).toThrow(Refused);
    expect(readFileSync(f, "utf8")).toBe("class A {}\n");
  });
  it("refuses a symlink that leads out of the workspace", () => {
    const d = ws();
    const outside = ws();
    const link = path.join(d, "B.java");
    symlinkSync(path.join(outside, "A.java"), link);
    const p = plan({
      changes: { [pathToFileURL(link).href]: [edit(0, 0, 5, "final class")] },
    });
    const real = realpathSync(link);
    expect(() =>
      write(p, d, new Map([[real, statSync(real).mtimeMs]])),
    ).toThrow(/outside the workspace/);
    expect(readFileSync(real, "utf8")).toMatch(/^class A/);
  });
});

describe("the dry run's diff (checked against GNU diff -u)", () => {
  it("is the same hunks GNU diff prints", () => {
    expect(
      unifiedDiff(
        "f",
        "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\n",
        "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL\nm\nn\n",
      ),
    ).toBe(
      [
        "--- a/f",
        "+++ b/f",
        "@@ -1,5 +1,5 @@",
        " a",
        "-b",
        "+B",
        " c",
        " d",
        " e",
        "@@ -9,5 +9,6 @@",
        " i",
        " j",
        " k",
        "-l",
        "+L",
        " m",
        "+n",
      ].join("\n"),
    );
    expect(
      unifiedDiff(
        "f",
        "1\n2\n3\n4\n5\n6\n7\n8\n9\n",
        "1\n2\nX\n4\n5\n6\n7\nY\n9\n",
      ),
    ).toBe(
      [
        "--- a/f",
        "+++ b/f",
        "@@ -1,9 +1,9 @@",
        " 1",
        " 2",
        "-3",
        "+X",
        " 4",
        " 5",
        " 6",
        " 7",
        "-8",
        "+Y",
        " 9",
      ].join("\n"),
    );
    expect(unifiedDiff("f", "same\n", "same\n")).toBe("");
  });
  it("reads a generate target as <file>:<line>, 1-based", () => {
    expect(parseTarget("core/Person.java:5")).toEqual({
      file: "core/Person.java",
      line: 5,
    });
    for (const bad of ["Person.java", "Person.java:0", "Person.java:x"])
      expect(() => parseTarget(bad)).toThrow(/<file>:<line>/);
  });
});

describe("one table, two renderers (RFC 0002 §6.5)", () => {
  // Each tool argument's form on the command line: a flag or a positional.
  const CLI: Record<string, Record<string, string>> = {
    java_status: {},
    java_inspect: { paths: "inspect [paths…]" },
    java_fix: { paths: "fix [paths…]", rule: "--rule", dryRun: "--write" },
    java_generate: {
      what: "accessors|getters|setters",
      file: "<file>:<line>",
      line: "<file>:<line>",
      getterPrefix: "--getter-prefix",
      booleanPrefix: "--boolean-prefix",
      fluentSetters: "--fluent",
      dryRun: "--write",
    },
    java_rename: {
      symbol: "<Type#member|file:line:col>",
      newName: "<newName>",
      dryRun: "--write",
    },
  };
  it("gives every tool argument a form the CLI documents, and nothing more", () => {
    const help = usage();
    expect(Object.keys(CLI).sort()).toEqual(VERBS.map((v) => v.name).sort());
    for (const v of VERBS) {
      expect(Object.keys(CLI[v.name]!).sort(), v.name).toEqual(
        Object.keys(v.args).sort(),
      );
      for (const form of Object.values(CLI[v.name]!))
        expect(help, `${v.name}: ${form}`).toContain(form);
    }
  });
  it("makes stdio's required arguments the CLI's positionals, and its dryRun true", () => {
    for (const t of toolSchemas("stdio")) {
      const positional = Object.entries(CLI[t.name]!)
        .filter(([k, f]) => !f.startsWith("--") && k !== "paths")
        .map(([k]) => k);
      expect(t.inputSchema.required.sort(), t.name).toEqual(positional.sort());
      if ("dryRun" in t.inputSchema.properties)
        expect(t.inputSchema.properties.dryRun!.default).toBe(true);
    }
  });
});

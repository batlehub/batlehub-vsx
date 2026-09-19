import { describe, expect, it } from "vitest";
import {
  addGitignoreLine,
  describe as describeManifest,
  GITIGNORE_LINE,
  parseManifest,
  record,
  removeGitignoreLine,
  replay,
} from "../src/written";

describe("the manifest of §4.2 (decision 24)", () => {
  it("keeps the value before the first write, not the family's own", () => {
    let m = parseManifest(undefined);
    m = record(m, {
      kind: "setting",
      key: "java.configuration.runtimes",
      scope: "workspace",
      before: undefined,
    });
    m = record(m, {
      kind: "setting",
      key: "java.configuration.runtimes",
      scope: "workspace",
      before: [{ name: "JavaSE-21", path: "/x" }],
    });
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]).toMatchObject({ before: undefined });
  });
  it("replays newest first, restores rather than deletes, and collects errors", async () => {
    let m = parseManifest(undefined);
    m = record(m, {
      kind: "setting",
      key: "java.configuration.runtimes",
      scope: "workspace",
      before: ["old"],
    });
    m = record(m, {
      kind: "gitignore",
      path: "/w/.gitignore",
      line: GITIGNORE_LINE,
    });
    m = record(m, {
      kind: "file",
      path: "/w/.batlehub/java/settings-corp.xml",
      before: null,
      mode: null,
    });
    // Red line 1: the mode is a write. `~/.m2/settings.xml` was 0644 before
    // the core set it 0600 to carry the token, and removal puts 0644 back.
    m = record(m, {
      kind: "block",
      path: "/home/u/.m2/settings.xml",
      marker: "batlehub",
      mode: 0o644,
    });
    const calls: string[] = [];
    const errors = await replay(m, {
      setting: async (k, b) =>
        void calls.push(`setting ${k}=${JSON.stringify(b)}`),
      extSetting: async () => {},
      file: async (p, b, mode) =>
        void calls.push(
          `file ${p} ${b === null ? "delete" : "restore"} ${mode ?? "-"}`,
        ),
      block: async (p, _marker, mode) => {
        calls.push(`block ${p} ${(mode ?? 0).toString(8)}`);
        throw new Error("locked");
      },
      gitignore: async (p) => void calls.push(`gitignore ${p}`),
    });
    expect(calls).toEqual([
      "block /home/u/.m2/settings.xml 644",
      "file /w/.batlehub/java/settings-corp.xml delete -",
      "gitignore /w/.gitignore",
      'setting java.configuration.runtimes=["old"]',
    ]);
    expect(errors).toEqual(["block:/home/u/.m2/settings.xml:batlehub: locked"]);
    expect(describeManifest(m)[0]).toContain(
      "remove the batlehub block from /home/u/.m2/settings.xml and put its mode back to 0644",
    );
    expect(describeManifest(m).at(-1)).toContain(
      'restore workspace setting java.configuration.runtimes to ["old"]',
    );
  });
  it("survives a corrupt file", () => {
    expect(parseManifest("{").entries).toEqual([]);
    expect(parseManifest('{"version":2}').entries).toEqual([]);
  });
  it("owns exactly one .gitignore line", () => {
    const once = addGitignoreLine("node_modules/");
    expect(once).toBe(`node_modules/\n${GITIGNORE_LINE}\n`);
    expect(addGitignoreLine(once)).toBe(once);
    expect(addGitignoreLine(undefined)).toBe(`${GITIGNORE_LINE}\n`);
    expect(removeGitignoreLine(once)).toBe("node_modules/\n");
  });
});

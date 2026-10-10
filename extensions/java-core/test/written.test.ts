import { describe, expect, it } from "vitest";
import {
  addGitignoreLine,
  describe as describeManifest,
  GITIGNORE_LINE,
  narrowGitignore,
  parseManifest,
  record,
  relocate,
  removeGitignoreLine,
  replay,
  V1_GITIGNORE_LINE,
  wouldExpose,
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
      profile: async () => {},
      moved: async () => {},
      project: async () => {},
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

describe("the profile entry (RFC 0005 §6.6)", () => {
  it("merges writes to one file: the first previous kept, new keys added, created as first found", () => {
    let m = parseManifest(undefined);
    m = record(m, {
      kind: "profile",
      path: "/w/.batlehub/java/inspections.json",
      created: true,
      entries: {
        "a/x": { written: { severity: "off", why: "i" }, previous: null },
      },
    });
    m = record(m, {
      kind: "profile",
      path: "/w/.batlehub/java/inspections.json",
      created: false,
      entries: {
        "a/x": {
          written: { severity: "warning" },
          previous: { severity: "off", why: "i" },
        },
        "a/y": {
          written: { severity: "error" },
          previous: { severity: "info" },
        },
      },
    });
    expect(m.entries).toHaveLength(1);
    const e = m.entries[0] as Extract<
      (typeof m.entries)[number],
      { kind: "profile" }
    >;
    expect(e.created).toBe(true);
    expect(e.entries).toEqual({
      "a/x": { written: { severity: "warning" }, previous: null },
      "a/y": { written: { severity: "error" }, previous: { severity: "info" } },
    });
    expect(describeManifest(m)).toEqual([
      "take back 2 rules written into /w/.batlehub/java/inspections.json (a/x, a/y), keeping any edited since, and delete it if none is left",
    ]);
  });
});

describe("the local/ layout (RFC 0006 §5.2, §5.3)", () => {
  it("ignores local/ only, so the team's files under .batlehub/java/ can be committed", () => {
    expect(GITIGNORE_LINE.startsWith("/.batlehub/java/local/ ")).toBe(true);
    const v1 = `node_modules/\n${V1_GITIGNORE_LINE}\n`;
    expect(narrowGitignore(v1)).toBe(`node_modules/\n${GITIGNORE_LINE}\n`);
    expect(narrowGitignore(narrowGitignore(v1))).toBe(narrowGitignore(v1));
  });

  it("names what narrowing the line would expose — not the team's files, the core's own, or local/ (use case 7)", () => {
    expect(
      wouldExpose([
        "written.json",
        "settings-overlay.xml",
        "project.json",
        "inspections.json",
        "local",
        "local/written.json",
        "settings-corp.xml",
        "notes/todo.txt",
      ]),
    ).toEqual(["notes/todo.txt", "settings-corp.xml"]);
    expect(wouldExpose(["written.json", "project.json"])).toEqual([]);
  });

  it("moves the overlay's entries with it, and a moved file goes back on removal", async () => {
    let m = parseManifest(undefined);
    m = record(m, {
      kind: "file",
      path: "/w/.batlehub/java/settings-overlay.xml",
      before: null,
      mode: null,
    });
    m = relocate(
      m,
      "/w/.batlehub/java/settings-overlay.xml",
      "/w/.batlehub/java/local/settings-overlay.xml",
    );
    m = record(m, {
      kind: "moved",
      from: "/w/.batlehub/java/notes.txt",
      to: "/w/.batlehub/java/local/notes.txt",
    });
    expect(m.entries[0]).toMatchObject({
      path: "/w/.batlehub/java/local/settings-overlay.xml",
    });
    const calls: string[] = [];
    await replay(m, {
      setting: async () => {},
      extSetting: async () => {},
      file: async (p) => void calls.push(`file ${p}`),
      block: async () => {},
      gitignore: async () => {},
      profile: async () => {},
      moved: async (from, to) => void calls.push(`moved ${to} -> ${from}`),
      project: async () => {},
    });
    expect(calls).toEqual([
      "moved /w/.batlehub/java/local/notes.txt -> /w/.batlehub/java/notes.txt",
      "file /w/.batlehub/java/local/settings-overlay.xml",
    ]);
  });
});

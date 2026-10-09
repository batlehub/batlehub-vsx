import { describe, expect, it } from "vitest";
import { addWord, spellingState, toRows } from "../src/inspections/spelling";

const r = (line: number, a: number, b: number) => ({
  start: { line, character: a },
  end: { line, character: b },
});

describe("spelling: the cspell bridge (RFC 0013 phase 1)", () => {
  it("maps cspell's diagnostics to the view's rows, at cspell's own level; other sources are left alone", () => {
    expect(
      toRows([
        { source: "cSpell", severity: 2, word: "recieve", range: r(5, 18, 25) },
        { source: "batlehub", severity: 1, word: "x", range: r(1, 0, 1) },
        { source: "cSpell", severity: 3, word: "retuns", range: r(4, 7, 13) },
      ]),
    ).toEqual([
      {
        ruleId: "unknownWord",
        area: "spelling",
        code: "spelling/unknownWord",
        message: 'Unknown word "recieve"',
        severity: "info",
        range: r(5, 18, 25),
      },
      {
        ruleId: "unknownWord",
        area: "spelling",
        code: "spelling/unknownWord",
        message: 'Unknown word "retuns"',
        severity: "hint",
        range: r(4, 7, 13),
      },
    ]);
  });
  it("creates cspell.json with the word and the build directories ignored — the only time those are written", () => {
    expect(JSON.parse(addWord(undefined, "Mesage"))).toEqual({
      version: "0.2",
      language: "en",
      words: ["Mesage"],
      ignorePaths: ["target/**", "build/**"],
    });
  });
  it("appends to an existing file, comments and other keys kept, nothing else added", () => {
    const team = `{\n  // the team's words\n  "version": "0.2",\n  "words": ["batlehub"]\n}\n`;
    const out = addWord(team, "Mesage");
    expect(out).toContain("// the team's words");
    expect(out).not.toContain("ignorePaths");
    expect(JSON.parse(out.replace(/^\s*\/\/.*$/m, ""))).toEqual({
      version: "0.2",
      words: ["batlehub", "Mesage"],
    });
    expect(addWord(out, "Mesage")).toBe(out);
    expect(JSON.parse(addWord(`{ "language": "en" }`, "jdtls"))).toEqual({
      language: "en",
      words: ["jdtls"],
    });
  });
  it("refuses a file that does not parse: the fix is not offered", () => {
    expect(() => addWord(`{ "words": [ `, "x")).toThrow(/not valid/);
  });
  it("states: bridged, not available, disabled by you", () => {
    expect(
      spellingState({
        installed: true,
        enabled: undefined,
        fileTypes: { "*": true, markdown: true },
      }),
    ).toBe("bridged");
    expect(
      spellingState({
        installed: false,
        enabled: undefined,
        fileTypes: undefined,
      }),
    ).toBe("not available");
    expect(
      spellingState({ installed: true, enabled: false, fileTypes: undefined }),
    ).toBe("disabled by you");
    expect(
      spellingState({
        installed: true,
        enabled: true,
        fileTypes: { java: false },
      }),
    ).toBe("disabled by you");
  });
});

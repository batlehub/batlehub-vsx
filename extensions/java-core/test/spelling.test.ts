import { describe, expect, it } from "vitest";
import {
  addWord,
  correctedIdentifier,
  levelNote,
  severityToCspell,
  spellingLevel,
  spellingState,
  suggestionOf,
  toRows,
} from "../src/inspections/spelling";

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
  it("a java: false the core wrote for the profile is not 'disabled by you'", () => {
    expect(
      spellingState({
        installed: true,
        enabled: undefined,
        fileTypes: { java: false, groovy: false },
        ours: true,
      }),
    ).toBe("bridged");
  });
});

describe("spelling: the profile reaches cspell (RFC 0013 phase 2)", () => {
  it("off, and only off, becomes enabledFileTypes — merged into the keys already there", () => {
    expect(severityToCspell("off", undefined)).toEqual({
      java: false,
      groovy: false,
    });
    expect(severityToCspell("off", { markdown: false, "*": true })).toEqual({
      markdown: false,
      "*": true,
      java: false,
      groovy: false,
    });
    for (const level of ["error", "warning", "info", "hint", undefined])
      expect(severityToCspell(level, { markdown: false })).toBeUndefined();
  });
  it("the developer's override, by full or bare id, wins over the profile", () => {
    const team = { "spelling/unknownWord": "off" };
    expect(spellingLevel(team, {})).toBe("off");
    expect(spellingLevel(team, { unknownWord: "info" })).toBe("info");
    expect(spellingLevel({}, { "spelling/unknownWord": "off" })).toBe("off");
    expect(spellingLevel({ "style/x": "off" }, {})).toBeUndefined();
  });
  it("a level that is not off says it is cspell's", () => {
    expect(levelNote(undefined)).toBe(
      "level is cspell's (info) — a per-language level does not exist yet",
    );
    expect(levelNote("Warning")).toMatch(/\(warning\)/);
  });
});

describe("spelling: the rename fix (RFC 0013 phase 3)", () => {
  it("re-joins the corrections in each part's case", () => {
    const parts = [
      { word: "recieve", suggestion: "receive" },
      { word: "Mesage", suggestion: "Message" },
    ];
    expect(correctedIdentifier("recieveMesage", parts)).toBe("receiveMessage");
    expect(
      correctedIdentifier("RecieveMesageDto", [
        { word: "Recieve", suggestion: "receive" },
        { word: "Mesage", suggestion: "message" },
      ]),
    ).toBe("ReceiveMessageDto");
    expect(
      correctedIdentifier("RECIEVE_MESAGE", [
        { word: "RECIEVE", suggestion: "receive" },
        { word: "MESAGE", suggestion: "Message" },
      ]),
    ).toBe("RECEIVE_MESSAGE");
    expect(
      correctedIdentifier("recieve", [
        { word: "recieve", suggestion: "receive" },
      ]),
    ).toBe("receive");
  });
  it("offers nothing when a part has no correction, or is not where it should be", () => {
    expect(
      correctedIdentifier("recieveMesage", [
        { word: "recieve", suggestion: "receive" },
        { word: "Mesage", suggestion: undefined },
      ]),
    ).toBeUndefined();
    expect(
      correctedIdentifier("sendX", [
        { word: "recieve", suggestion: "receive" },
      ]),
    ).toBeUndefined();
  });
  it("reads the suggestions cspell attaches to its diagnostic: the preferred one, else the first", () => {
    // cspell 4.9.3's `data` on "Mesage", as its server publishes it.
    expect(
      suggestionOf({
        strict: true,
        suggestions: [{ word: "Message", isPreferred: true }, { word: "Mesa" }],
      }),
    ).toBe("Message");
    expect(
      suggestionOf({ suggestions: [{ word: "receive" }, { word: "relieve" }] }),
    ).toBe("receive");
  });
  it("a changed shape yields no suggestion, and does not throw", () => {
    expect(suggestionOf(undefined)).toBeUndefined();
    expect(suggestionOf({ suggestions: "Message" })).toBeUndefined();
    expect(
      suggestionOf({ suggestions: [{ text: "Message" }] }),
    ).toBeUndefined();
    expect(suggestionOf({ suggestions: [] })).toBeUndefined();
  });
});

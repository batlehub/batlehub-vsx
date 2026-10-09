// RFC 0019 §10. No `vscode` import.
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/calendar";
import { COLOR_KEYS, DEFAULT_TITLE, patch, withGlyph } from "../src/overlay";

describe("patch", () => {
  it("writes exactly the eight keys and no others", () => {
    expect(Object.keys(patch(DEFAULTS[0]!)).sort()).toEqual([...COLOR_KEYS].sort());
  });

  // The invariant of RFC 0019 §5.3: nothing the overlay writes affects a
  // surface RFC 0014's contrast test makes a promise about.
  it("never touches the editor surface", () => {
    for (const key of COLOR_KEYS) expect(key.startsWith("editor")).toBe(false);
    expect(COLOR_KEYS).not.toContain("editor.background");
    expect(COLOR_KEYS).not.toContain("editor.foreground");
  });

  it("uses the season's own pair and nothing else", () => {
    const values = new Set(Object.values(patch(DEFAULTS[1]!)));
    expect([...values].sort()).toEqual([DEFAULTS[1]!.background, DEFAULTS[1]!.foreground].sort());
  });
});

describe("withGlyph", () => {
  it("prefixes the glyph", () => {
    expect(withGlyph("Greeter.java", "🎃")).toBe("🎃 Greeter.java");
  });

  it("is idempotent, so a double activation cannot stack glyphs", () => {
    const once = withGlyph(DEFAULT_TITLE, "🎃");
    expect(withGlyph(once, "🎃")).toBe(once);
    expect(withGlyph(withGlyph(once, "🎃"), "🎃")).toBe(once);
  });

  it("leaves the title's own variables untouched", () => {
    const out = withGlyph(DEFAULT_TITLE, "🎄");
    expect(out).toContain("${activeEditorShort}");
    expect(out).toContain("${separator}");
    expect(out.endsWith(DEFAULT_TITLE)).toBe(true);
  });

  it("concatenates rather than interpolates, so a glyph is never a variable", () => {
    // RFC 0019 §7: `${...}` in a glyph is text, not a title variable.
    expect(withGlyph("x", "${rootName}")).toBe("${rootName} x");
  });
});

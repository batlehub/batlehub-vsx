// RFC 0019 §10. The gate on taste being wrong in a way that hurts: the six
// shipped pairs have to be legible, whatever they look like.
//
// The relative-luminance helper is copied here rather than imported from
// batlehub-theme/scripts/color.mjs: that package has no `main`, and a
// workspace dependency on a theme in order to run a test is a worse trade
// than fifteen duplicated lines of WCAG 2.1.
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/calendar";

const channel = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe("the shipped palettes", () => {
  it.each(DEFAULTS.map((s) => [s.key, s] as const))("%s clears 4.5:1", (_key, s) => {
    expect(ratio(s.foreground, s.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("is checked against a known-good pair, so the formula itself is right", () => {
    expect(ratio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(ratio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // WCAG's own worked example: #777777 on white is 4.48:1 — just under.
    expect(ratio("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  it("uses six-digit hex, which is what the helper above can read", () => {
    for (const s of DEFAULTS) {
      expect(s.background, s.key).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.foreground, s.key).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

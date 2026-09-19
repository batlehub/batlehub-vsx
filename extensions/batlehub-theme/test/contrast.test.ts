// RFC 0014 §10, the unit layer: the theme's only promise is its ratios, and
// this is where they are held. No editor is needed — the three theme files are
// data, and so is the colour registry they inherit from.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composite, contrast, deltaE, parseHex } from "../scripts/color.mjs";
import {
  baseDefaults,
  colorsOf,
  derive,
  ERROR_KEYS,
  FLOORS,
  HC_ONLY,
  listedColorsOf,
  MIN_ACCENT_ERROR_DELTA_E,
  PARTNER_TOKENS,
  palette,
  inheritedPairs,
  ROLES,
  serialise,
  tokens,
  VARIANTS,
  VOICES,
} from "../scripts/derive.mjs";

type Theme = {
  semanticHighlighting: boolean;
  colors: Record<string, string>;
  semanticTokenColors: Record<string, string | { foreground: string }>;
  tokenColors: {
    name: string;
    scope: string[];
    settings: { foreground: string };
  }[];
};
const themeOf = (variant: string) =>
  (derive() as Record<string, Theme>)[
    VARIANTS[variant as keyof typeof VARIANTS].file
  ];
const roles = ROLES as Record<string, string[]>;

const here = import.meta.dirname;
const themes = path.join(here, "..", "themes");
const variants = Object.keys(VARIANTS) as (keyof typeof VARIANTS)[];
const on = (fg: string, bg: string) => contrast(parseHex(fg), parseHex(bg));
const ratio = (r: number) => `${r.toFixed(2)}:1`;

describe("the committed files are the derivation", () => {
  it.each(Object.entries(derive()))(
    "themes/%s is what derive() writes",
    (file, value) => {
      expect(fs.readFileSync(path.join(themes, file), "utf8")).toBe(
        serialise(value),
      );
    },
  );
});

describe("tokens.json", () => {
  it("names the DESIGN.md commit it was copied from", () => {
    expect(tokens.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(tokens.source.path).toBe("DESIGN.md");
  });

  // The In-Gamut Rule: sRGB as written, never an oklch() the browser clamps
  // differently from the test. The authored triples stay as provenance.
  it.each(["dark", "light"])(
    "%s is sRGB hex, in gamut, as written",
    (rendition) => {
      for (const [token, value] of Object.entries(
        tokens[rendition] as Record<string, string>,
      )) {
        expect(value, token).toMatch(/^#[0-9a-f]{6}$/);
        const c = parseHex(value);
        for (const channel of [c.r, c.g, c.b])
          expect(channel, token).toBeGreaterThanOrEqual(0);
        for (const channel of [c.r, c.g, c.b])
          expect(channel, token).toBeLessThanOrEqual(255);
        expect(c.a, token).toBe(1);
      }
    },
  );
});

describe("base-defaults.json", () => {
  it("records the VS Code the heavy suite pins", () => {
    const view = fs.readFileSync(
      path.join(here, "..", "..", "..", "tests", "heavy", "view.sh"),
      "utf8",
    );
    const pinned = /VSCODE_VERSION="\$\{VSCODE_VERSION:-([\d.]+)\}"/.exec(
      view,
    )?.[1];
    expect(
      pinned,
      "no VSCODE_VERSION default in tests/heavy/view.sh",
    ).toBeTruthy();
    expect(baseDefaults.vscode).toBe(pinned);
  });

  it("carries a map per uiTheme", () => {
    for (const v of Object.values(VARIANTS))
      expect(Object.keys(baseDefaults[v.uiTheme]).length).toBeGreaterThan(900);
  });
});

describe.each(variants)("%s", (variant) => {
  const p = palette(variant);
  const listed = listedColorsOf(variant) as Record<string, string>;
  const colors = colorsOf(variant) as Record<string, string>;
  const floors = FLOORS[variant];
  const ground = p.ground;
  const raised = p["ground-raised"];

  it("holds the floors DESIGN.md states for the pairs that land in the editor", () => {
    expect(on(p.ink, ground), "ink on ground").toBeGreaterThanOrEqual(
      floors.ink,
    );
    expect(
      on(p["ink-dim"], ground),
      "dim ink on ground",
    ).toBeGreaterThanOrEqual(floors["ink-dim"]);
    expect(
      on(p["ink-dim"], raised),
      "dim ink on raised",
    ).toBeGreaterThanOrEqual(floors["ink-dim-raised"]);
    expect(on(p.accent, ground), "crimson on ground").toBeGreaterThanOrEqual(
      floors.accent,
    );
    expect(on(p.error, ground), "error on ground").toBeGreaterThanOrEqual(
      floors.error,
    );
    expect(on(p.focus, ground), "amber on ground").toBeGreaterThanOrEqual(
      floors.focus,
    );
    expect(
      on(p["rule-strong"], ground),
      "strong rule on ground",
    ).toBeGreaterThanOrEqual(floors["rule-strong"]);
  });

  // One hue, one meaning (§11 decision 7): crimson says "do this" and the
  // error red says "this is broken", and the eye has to tell them apart.
  it("keeps crimson off every error key, and far enough from the error red", () => {
    expect(ERROR_KEYS.filter((k) => ROLES.accent.includes(k))).toEqual([]);
    for (const key of ERROR_KEYS) expect(colors[key], key).toBe(p.error);
    expect(
      deltaE(parseHex(p.accent), parseHex(p.error)),
    ).toBeGreaterThanOrEqual(MIN_ACCENT_ERROR_DELTA_E);
  });

  // The One Synthetic Rule: crimson is load-bearing on its own keys and
  // nowhere else — not in a syntax voice, not on a key the sweep promoted.
  it("paints crimson only where the rule table puts it", () => {
    const theme = themeOf(variant);
    for (const [key, value] of Object.entries(theme.colors)) {
      if (ROLES.accent.includes(key)) continue;
      expect(value, key).not.toBe(p.accent);
    }
    for (const [token, style] of Object.entries(theme.semanticTokenColors)) {
      const fg =
        typeof style === "string"
          ? style
          : (style as { foreground: string }).foreground;
      expect(fg, token).not.toBe(p.accent);
    }
    for (const rule of theme.tokenColors) {
      expect(rule.settings.foreground, rule.scope.join(",")).not.toBe(p.accent);
    }
  });

  // The Counter-Ink Rule: a crimson fill always takes --accent-ink, and the
  // pair is measured, never assumed.
  it("gives every crimson fill its counter-ink", () => {
    const fills = ROLES.accent.filter((k) => k.endsWith(".background"));
    expect(fills.length).toBeGreaterThan(0);
    for (const fill of fills) {
      const fg = fill.replace(/\.background$/, ".foreground");
      expect(ROLES["accent-ink"], `${fill} has no counter-ink`).toContain(fg);
      expect(
        on(colors[fg], colors[fill]),
        `${fg} on ${fill}`,
      ).toBeGreaterThanOrEqual(floors.counterInk);
    }
  });

  // The Undependable Fill Rule: a fill step is never the only cue, so every
  // raised or sunk surface has a rule or an ink in the same component.
  it("never leaves a fill to carry a state on its own", () => {
    for (const token of ["ground-raised", "ground-sunk"] as const) {
      for (const key of roles[token]) {
        const component = key.split(".")[0];
        const partner = PARTNER_TOKENS.flatMap((t: string) => roles[t]).find(
          (k: string) => k.split(".")[0] === component,
        );
        expect(
          partner,
          `${key} has no rule or ink in ${component}`,
        ).toBeTruthy();
      }
    }
  });

  // §4.3: the base theme chose an inherited colour for another ground, and the
  // theme owns the pair the moment it changes the ground. Every key of the
  // registry is walked — a colour the editor adds tomorrow is measured the day
  // it appears, not when someone remembers to list it.
  it("holds the floor for every colour it inherits", () => {
    const failures: string[] = [];
    let measured = 0;
    for (const { key, value, surfaces, floor } of inheritedPairs(
      variant,
      listed,
      colors,
    )) {
      for (const surface of surfaces) {
        measured++;
        const r = contrast(parseHex(value), surface);
        if (r < floor - 1e-9)
          failures.push(`${key} ${value}: ${ratio(r)} < ${floor.toFixed(2)}:1`);
      }
    }
    expect(measured).toBeGreaterThan(500);
    expect(failures).toEqual([]);
  });

  it("gives every listed key a value", () => {
    for (const [token, keys] of Object.entries(ROLES)) {
      for (const key of keys as string[]) {
        if (HC_ONLY.has(key) && variant !== "hc") {
          expect(
            colors[key],
            `${key} is high contrast's alone`,
          ).toBeUndefined();
          continue;
        }
        expect(colors[key], `${key} (${token})`).toBe(p[token]);
      }
    }
  });
});

// §5.2: high contrast keeps the hues and the ground, lifts every text pair to
// AAA, and sets the two keys the editor outlines every widget with.
describe("high contrast", () => {
  const p = palette("hc");
  const colors = colorsOf("hc") as Record<string, string>;

  it("keeps the BatleHub ground", () => {
    expect(p.ground).toBe(tokens.dark.ground);
  });

  it("sets contrastBorder and contrastActiveBorder", () => {
    expect(colors["contrastBorder"]).toBe(p["rule-strong"]);
    expect(colors["contrastActiveBorder"]).toBe(p.focus);
    for (const variant of ["dark", "light"] as const) {
      for (const key of HC_ONLY)
        expect(colorsOf(variant)[key], key).toBeUndefined();
    }
  });

  it("has no soft rule left", () => {
    expect(p["rule-soft"]).toBe(p["rule-strong"]);
  });

  it("lifts every text pair to 7:1", () => {
    for (const token of [
      "ink",
      "ink-dim",
      "accent",
      "copper",
      "error",
    ] as const) {
      expect(
        on(p[token], p.ground),
        `${token} on ground`,
      ).toBeGreaterThanOrEqual(7);
    }
    expect(
      on(p["accent-ink"], p.accent),
      "counter-ink on crimson",
    ).toBeGreaterThanOrEqual(7);
  });
});

describe("the four voices", () => {
  it.each(variants)(
    "%s colours Java by the same voices as the chrome",
    (variant) => {
      const theme = themeOf(variant);
      const p = palette(variant);
      expect(theme.semanticHighlighting).toBe(true);
      for (const row of VOICES) {
        for (const token of row.semantic as string[]) {
          const style = (theme.semanticTokenColors as Record<string, unknown>)[
            token
          ];
          const fg =
            typeof style === "string"
              ? style
              : (style as { foreground: string }).foreground;
          expect(fg, token).toBe(p[row.voice]);
        }
      }
      // Every syntax colour is a text pair on the editor's own ground.
      for (const row of VOICES) {
        expect(on(p[row.voice], p.ground), row.voice).toBeGreaterThanOrEqual(
          variant === "hc" ? 7 : 4.5,
        );
      }
    },
  );

  it("gives the invalid scopes the error red and nothing else", () => {
    const invalid = VOICES.find((v: { voice: string }) => v.voice === "error")!;
    expect(invalid.scopes).toEqual(["invalid", "invalid.illegal"]);
    expect(invalid.semantic).toEqual([]);
  });
});

// RFC 0019 §10, the unit layer. No `vscode` import anywhere below.
import { describe, expect, it } from "vitest";
import {
  activeSeason,
  clipGlyph,
  dayKey,
  DEFAULTS,
  inWindow,
  parse,
  parseAll,
  type Season,
} from "../src/calendar";

const season = (over: Partial<Season> = {}): Season => ({
  key: "t",
  name: "Test",
  from: "01-01",
  to: "01-31",
  glyph: "🧪",
  background: "#000000",
  foreground: "#ffffff",
  ...over,
});

describe("inWindow", () => {
  it("includes both bounds", () => {
    expect(inWindow("10-24", "10-24", "11-01")).toBe(true);
    expect(inWindow("11-01", "10-24", "11-01")).toBe(true);
  });

  it("excludes the days either side", () => {
    expect(inWindow("10-23", "10-24", "11-01")).toBe(false);
    expect(inWindow("11-02", "10-24", "11-01")).toBe(false);
  });

  it("handles a single-day window", () => {
    expect(inWindow("04-01", "04-01", "04-01")).toBe(true);
    expect(inWindow("03-31", "04-01", "04-01")).toBe(false);
    expect(inWindow("04-02", "04-01", "04-01")).toBe(false);
  });

  // decision 9: the general case is smaller than the special case.
  it("crosses the year when to < from", () => {
    expect(inWindow("12-30", "12-28", "01-02")).toBe(true);
    expect(inWindow("12-28", "12-28", "01-02")).toBe(true);
    expect(inWindow("01-01", "12-28", "01-02")).toBe(true);
    expect(inWindow("01-02", "12-28", "01-02")).toBe(true);
    expect(inWindow("01-03", "12-28", "01-02")).toBe(false);
    expect(inWindow("11-15", "12-28", "01-02")).toBe(false);
    expect(inWindow("06-01", "12-28", "01-02")).toBe(false);
  });
});

describe("dayKey", () => {
  it("is MM-DD in local time, with the year discarded", () => {
    expect(dayKey(new Date(2026, 9, 31, 23, 59))).toBe("10-31");
    expect(dayKey(new Date(2031, 0, 2, 0, 0))).toBe("01-02");
  });
});

describe("the shipped defaults", () => {
  it("are the six of RFC 0019 §4.2", () => {
    expect(DEFAULTS.map((s) => s.key)).toEqual([
      "season.halloween",
      "season.christmas",
      "season.newyear",
      "season.aprilfools",
      "season.musique",
      "season.nationale",
    ]);
  });

  it("all parse as real MM-DD days", () => {
    for (const s of DEFAULTS) {
      const r = parse({ ...s }, 0);
      expect(r, `${s.key}`).toHaveProperty("season");
    }
  });

  it("cover their own days and not the day before", () => {
    expect(activeSeason("10-31")?.key).toBe("season.halloween");
    expect(activeSeason("12-25")?.key).toBe("season.christmas");
    expect(activeSeason("12-31")?.key).toBe("season.newyear");
    expect(activeSeason("01-01")?.key).toBe("season.newyear");
    expect(activeSeason("04-01")?.key).toBe("season.aprilfools");
    expect(activeSeason("06-21")?.key).toBe("season.musique");
    expect(activeSeason("07-14")?.key).toBe("season.nationale");
    expect(activeSeason("07-13")).toBeUndefined();
  });

  it("do not overlap each other", () => {
    const hits = (day: string) => DEFAULTS.filter((s) => inWindow(day, s.from, s.to));
    for (let m = 1; m <= 12; m += 1)
      for (let d = 1; d <= 31; d += 1) {
        const day = `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        expect(hits(day).length, day).toBeLessThanOrEqual(1);
      }
  });

  it("leave most of the year alone", () => {
    expect(activeSeason("02-03")).toBeUndefined();
    expect(activeSeason("08-20")).toBeUndefined();
  });
});

describe("activeSeason", () => {
  // decision 10: mine overrides yours, then array order.
  it("prefers a user entry over a default it overlaps", () => {
    const mine = season({ key: "user.0", name: "Birthday", from: "12-25", to: "12-25" });
    expect(activeSeason("12-25", [mine])?.key).toBe("user.0");
    expect(activeSeason("12-24", [mine])?.key).toBe("season.christmas");
  });

  it("takes the first of two overlapping user entries", () => {
    const a = season({ key: "user.0", from: "03-01", to: "03-31" });
    const b = season({ key: "user.1", from: "03-10", to: "03-12" });
    expect(activeSeason("03-11", [a, b])?.key).toBe("user.0");
    expect(activeSeason("03-11", [b, a])?.key).toBe("user.1");
  });

  it("is undefined when nothing covers today", () => {
    expect(activeSeason("05-05", [], [])).toBeUndefined();
  });
});

describe("parse", () => {
  const ok = { name: "Release week", from: "03-10", to: "03-14" };

  it("accepts a minimal entry and fills the rest", () => {
    const r = parse(ok, 0);
    expect(r).toHaveProperty("season");
    if (!("season" in r)) return;
    expect(r.season.key).toBe("user.0");
    expect(r.season.glyph).toBe("🎉");
    expect(r.season.background).toMatch(/^#/);
  });

  it.each([
    ["not an object", 42],
    ["an array", []],
    ["null", null],
    ["no name", { from: "01-01", to: "01-02" }],
    ["an empty name", { name: "  ", from: "01-01", to: "01-02" }],
    ["a bad from", { ...ok, from: "3-10" }],
    ["a bad to", { ...ok, to: "2026-03-14" }],
    ["month 13", { ...ok, from: "13-01" }],
    ["day 00", { ...ok, from: "03-00" }],
    ["February 31st", { ...ok, from: "02-31" }],
    ["April 31st", { ...ok, from: "04-31" }],
    ["a background that is not hex", { ...ok, background: "orange" }],
    ["a foreground that is not hex", { ...ok, foreground: "#gggggg" }],
  ])("skips %s", (_why, entry) => {
    expect(parse(entry, 0)).toHaveProperty("error");
  });

  // No year is involved, so the 29th of February is a day that exists.
  it("accepts February 29th", () => {
    expect(parse({ ...ok, from: "02-29", to: "02-29" }, 0)).toHaveProperty("season");
  });

  it("accepts every hex form the editor accepts", () => {
    for (const c of ["#abc", "#abcd", "#aabbcc", "#aabbccdd"])
      expect(parse({ ...ok, background: c }, 0), c).toHaveProperty("season");
  });
});

describe("parseAll", () => {
  it("keeps the good entries and reports the bad ones", () => {
    const r = parseAll([
      { name: "a", from: "01-01", to: "01-02" },
      { name: "b", from: "99-99", to: "01-02" },
      { name: "c", from: "02-01", to: "02-02" },
    ]);
    expect(r.seasons.map((s) => s.name)).toEqual(["a", "c"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("(b)");
  });

  it("indexes the keys by position, so the message points at the entry", () => {
    const r = parseAll([{ name: "a", from: "01-01", to: "01-02" }]);
    expect(r.seasons[0]!.key).toBe("user.0");
  });

  it("treats a non-array as no entries at all", () => {
    expect(parseAll(undefined).seasons).toEqual([]);
    expect(parseAll("nope").errors).toEqual([]);
  });
});

describe("clipGlyph", () => {
  it("keeps a flag whole", () => {
    // 🇫🇷 is one cluster, two code points, four UTF-16 units: `.length` is 4
    // and slicing by it would leave a lone regional indicator.
    expect("🇫🇷".length).toBe(4);
    expect(clipGlyph("🇫🇷")).toBe("🇫🇷");
  });

  it("keeps two clusters and drops the rest", () => {
    expect(clipGlyph("🎃🎄🎆")).toBe("🎃🎄");
    expect(clipGlyph("abcdef")).toBe("ab");
  });

  it("leaves one cluster alone", () => {
    expect(clipGlyph("🎃")).toBe("🎃");
    expect(clipGlyph("")).toBe("");
  });

  it("clips a long user glyph, so it cannot run away with the title", () => {
    expect(clipGlyph("x".repeat(500))).toHaveLength(2);
  });
});

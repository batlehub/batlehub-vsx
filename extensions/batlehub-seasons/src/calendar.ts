// RFC 0019 §5.1, §6.1. Which window is today in?
//
// This module imports nothing from `vscode` on purpose
// (docs/contributing/testing.md): it is the only arithmetic in the extension
// and so the only place a bug is likely to live, and it costs nothing to test
// as plain Node.

export type Season = {
  /** Stable id. The six shipped ones are `season.*` and have a translated label. */
  key: string;
  /** What the status bar shows when there is no translation for `key`. */
  name: string;
  /** `MM-DD`, inclusive. */
  from: string;
  /** `MM-DD`, inclusive. Earlier than `from` means the window crosses the year. */
  to: string;
  glyph: string;
  background: string;
  foreground: string;
};

/**
 * The six shipped windows (RFC 0019 §4.2). The palettes are self-contained —
 * background *and* foreground are replaced together — which is why one palette
 * per season is enough rather than a dark and a light one (decision 15). Each
 * pair clears 4.5:1; `test/contrast.test.ts` is the gate.
 */
export const DEFAULTS: readonly Season[] = [
  {
    key: "season.halloween",
    name: "Halloween",
    from: "10-24",
    to: "11-01",
    glyph: "🎃",
    background: "#a8470a",
    foreground: "#fff6ec",
  },
  {
    key: "season.christmas",
    name: "Christmas",
    from: "12-15",
    to: "12-26",
    glyph: "🎄",
    background: "#14532d",
    foreground: "#f2fbf5",
  },
  {
    key: "season.newyear",
    name: "New Year",
    from: "12-28",
    to: "01-02",
    glyph: "🎆",
    background: "#1e2a5a",
    foreground: "#f5f3ff",
  },
  {
    key: "season.aprilfools",
    name: "April Fools",
    from: "04-01",
    to: "04-01",
    glyph: "🃏",
    background: "#a21068",
    foreground: "#fff0f8",
  },
  {
    key: "season.musique",
    name: "Fête de la Musique",
    from: "06-21",
    to: "06-21",
    glyph: "🎶",
    background: "#5b2d8e",
    foreground: "#f6f0ff",
  },
  {
    key: "season.nationale",
    name: "Fête Nationale",
    from: "07-14",
    to: "07-14",
    glyph: "🇫🇷",
    background: "#1b3a8f",
    foreground: "#f4f7ff",
  },
];

const MM_DD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// February has 29 because no year is involved: 02-29 is a day that exists.
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `MM-DD` for a date, in local time. The year is discarded (RFC 0019 §4.3). */
export const dayKey = (d: Date): string =>
  `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const isDay = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  const m = MM_DD.exec(v);
  if (!m) return false;
  return Number(m[2]) <= DAYS_IN_MONTH[Number(m[1]) - 1]!;
};

/**
 * Both bounds inclusive; `from > to` is a window that crosses the year
 * (RFC 0019 §5.1, decision 9). `MM-DD` strings compare correctly as strings,
 * which is the whole reason for that config shape: no date arithmetic.
 */
export const inWindow = (today: string, from: string, to: string): boolean =>
  from > to ? today >= from || today <= to : today >= from && today <= to;

/**
 * Two grapheme clusters at most, counted with `Intl.Segmenter` rather than
 * `.length`: 🇫🇷 is one cluster, two code points and four UTF-16 units, and
 * `.length` would cut it in half into a lone regional indicator.
 */
export const clipGlyph = (glyph: string, max = 2): string =>
  [...new Intl.Segmenter().segment(glyph)]
    .slice(0, max)
    .map((s) => s.segment)
    .join("");

export type Parsed = { season: Season } | { error: string };

/**
 * One `batlehub.seasons.events` entry. A malformed entry is an error returned,
 * never thrown: a decoration extension that refuses to start because a date is
 * misspelt is worse than no decoration (RFC 0019 §4.3).
 */
export const parse = (raw: unknown, index: number): Parsed => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { error: `events[${index}] is not an object` };
  const e = raw as Record<string, unknown>;
  if (typeof e.name !== "string" || e.name.trim() === "")
    return { error: `events[${index}] has no name` };
  if (!isDay(e.from)) return { error: `events[${index}] (${e.name}): from is not a real MM-DD` };
  if (!isDay(e.to)) return { error: `events[${index}] (${e.name}): to is not a real MM-DD` };
  const glyph = e.glyph === undefined ? "🎉" : e.glyph;
  if (typeof glyph !== "string")
    return { error: `events[${index}] (${e.name}): glyph not a string` };
  const background = e.background === undefined ? DEFAULTS[0]!.background : e.background;
  const foreground = e.foreground === undefined ? DEFAULTS[0]!.foreground : e.foreground;
  if (typeof background !== "string" || !HEX.test(background))
    return { error: `events[${index}] (${e.name}): background is not a hex colour` };
  if (typeof foreground !== "string" || !HEX.test(foreground))
    return { error: `events[${index}] (${e.name}): foreground is not a hex colour` };
  return {
    season: {
      key: `user.${index}`,
      name: e.name,
      from: e.from,
      to: e.to,
      glyph: clipGlyph(glyph),
      background,
      foreground,
    },
  };
};

/** Every valid entry, and one message per entry that was skipped. */
export const parseAll = (raw: unknown): { seasons: Season[]; errors: string[] } => {
  if (!Array.isArray(raw)) return { seasons: [], errors: [] };
  const seasons: Season[] = [];
  const errors: string[] = [];
  raw.forEach((entry, i) => {
    const r = parse(entry, i);
    if ("season" in r) seasons.push(r.season);
    else errors.push(r.error);
  });
  return { seasons, errors };
};

/**
 * The active window, or none. User entries come first, so an entry of yours
 * shadows a shipped one it overlaps; among equals, array order decides
 * (RFC 0019 §4.3, decision 10).
 */
export const activeSeason = (
  today: string,
  user: readonly Season[] = [],
  defaults: readonly Season[] = DEFAULTS,
): Season | undefined => [...user, ...defaults].find((s) => inWindow(today, s.from, s.to));

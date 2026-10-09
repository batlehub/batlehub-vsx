// RFC 0019 §5.3, §6.2. What a season looks like, as data.
//
// Imports nothing from `vscode`: this is a pure mapping from a Season to the
// keys that will be merged into `workbench.colorCustomizations`, and to the
// window title.

import type { Season } from "./calendar";

/**
 * The eight keys the overlay may write. Fixed here rather than configurable,
 * and all chrome.
 *
 * The invariant (RFC 0019 §5.3): no key in this list affects a surface RFC
 * 0014's contrast test makes a promise about. The theme guarantees ink on
 * ground where code is read; a ninth key on the editor surface would turn
 * those ratios into whatever the season felt like, and no test in either
 * extension would notice.
 */
export const COLOR_KEYS = [
  "titleBar.activeBackground",
  "titleBar.activeForeground",
  "titleBar.inactiveBackground",
  "titleBar.inactiveForeground",
  "activityBar.background",
  "activityBar.foreground",
  "statusBar.background",
  "statusBar.foreground",
] as const;

export type ColorKey = (typeof COLOR_KEYS)[number];

/**
 * The overlay for a season. Inactive and active take the same pair: dimming
 * the inactive one needs colour arithmetic, and the point of a self-contained
 * pair (decision 15) is that there is none.
 */
export const patch = (season: Season): Record<ColorKey, string> => ({
  "titleBar.activeBackground": season.background,
  "titleBar.activeForeground": season.foreground,
  "titleBar.inactiveBackground": season.background,
  "titleBar.inactiveForeground": season.foreground,
  "activityBar.background": season.background,
  "activityBar.foreground": season.foreground,
  "statusBar.background": season.background,
  "statusBar.foreground": season.foreground,
});

/**
 * The glyph in front of a `window.title`. Idempotent, so a double activation
 * cannot produce `🎃 🎃 `; the title is concatenated and never interpolated,
 * so a `${...}` in a glyph is two characters of text rather than a title
 * variable (RFC 0019 §7).
 */
export const withGlyph = (title: string, glyph: string): string =>
  title.startsWith(`${glyph} `) ? title : `${glyph} ${title}`;

/** VS Code's own default, used when the user has set no `window.title`. */
export const DEFAULT_TITLE =
  "${dirty}${activeEditorShort}${separator}${rootName}${separator}${profileName}${separator}${appName}";

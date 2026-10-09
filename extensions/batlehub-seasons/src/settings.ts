// RFC 0019 §5.2, §6.3. The only module that touches the editor's
// configuration, and the only one the `vscode` mock exists for.
//
// Every write is `ConfigurationTarget.Global` (decision 11). There is no code
// path here that passes `Workspace`, and `test/settings.test.ts` asserts the
// mock never sees one: `.vscode/settings.json` is tracked in the workspaces
// this repository targets, so a workspace-scope write would put an orange
// title bar in `git status`.

import * as vscode from "vscode";
import type { Season } from "./calendar";
import { COLOR_KEYS, DEFAULT_TITLE, patch, withGlyph } from "./overlay";

/**
 * This extension's manifest (RFC 0019 §5.2). RFC 0001's red line 1 is answered
 * by the core's one manifest, `.batlehub/java/written.json`; that file is
 * workspace-scoped and belongs to a family this extension has no dependency
 * on, so the rule is kept and the file is not: one key, in the same scope as
 * the writes it records, holding what was there before.
 *
 * `null` means "this key did not exist" and is restored by deletion; a string
 * is restored by being written back. Restoring everything by deletion would
 * remove a `statusBar.background` the user set themselves; restoring
 * everything by writing would invent a `titleBar.activeBackground` that never
 * existed.
 */
export type Saved = {
  season: string;
  colors: Record<string, string | null>;
  /** Absent: `window.title` was not touched. */
  title?: string | null;
};

export type SavedState = { none: true } | { bad: string } | { saved: Saved };

const GLOBAL = vscode.ConfigurationTarget.Global;

const seasons = () => vscode.workspace.getConfiguration("batlehub.seasons");
const workbench = () => vscode.workspace.getConfiguration("workbench");
const windowCfg = () => vscode.workspace.getConfiguration("window");

/**
 * The global value only, never the effective one: the overlay is written at
 * global scope, so what it replaces — and what it merges into — has to be read
 * at the same scope. Merging the effective value would promote a workspace
 * colour to global and leave it there.
 */
const globalColors = (): Record<string, string> =>
  workbench().inspect<Record<string, string>>("colorCustomizations")?.globalValue ?? {};

/** `_saved`, validated. Nothing is guessed: an unparseable record is `bad`. */
export const readSaved = (): SavedState => {
  const raw = seasons().get<unknown>("_saved");
  if (raw === null || raw === undefined) return { none: true };
  if (typeof raw !== "object" || Array.isArray(raw)) return { bad: "not an object" };
  const o = raw as Record<string, unknown>;
  if (typeof o.season !== "string") return { bad: "no season id" };
  if (typeof o.colors !== "object" || o.colors === null || Array.isArray(o.colors))
    return { bad: "no colours map" };
  for (const [k, v] of Object.entries(o.colors as Record<string, unknown>))
    if (v !== null && typeof v !== "string")
      return { bad: `colors[${k}] is neither text nor null` };
  if ("title" in o && o.title !== null && typeof o.title !== "string")
    return { bad: "title is neither text nor null" };
  return { saved: o as Saved };
};

/** What `Seasons: Remove BatleHub seasons settings` says it is about to do. */
export const describe = (saved: Saved): string[] => {
  const lines = Object.entries(saved.colors).map(([k, v]) =>
    v === null ? `remove workbench.colorCustomizations → ${k}` : `${k} → ${v}`,
  );
  if ("title" in saved)
    lines.push(saved.title === null ? "remove window.title" : `window.title → ${saved.title}`);
  return lines;
};

/**
 * Save first, then write. A crash between the two leaves a `_saved`
 * describing a state that is still current, which the next activation
 * restores harmlessly; the reverse order can leave an overlay with no record
 * of what it replaced.
 */
export const apply = async (season: Season, withTitle: boolean): Promise<void> => {
  const before = globalColors();
  const colors: Record<string, string | null> = {};
  for (const key of COLOR_KEYS) colors[key] = key in before ? (before[key] ?? null) : null;

  const saved: Saved = { season: season.key, colors };
  let nextTitle: string | undefined;
  if (withTitle) {
    saved.title = windowCfg().inspect<string>("title")?.globalValue ?? null;
    nextTitle = withGlyph(windowCfg().get<string>("title") ?? DEFAULT_TITLE, season.glyph);
  }

  await seasons().update("_saved", saved, GLOBAL);
  await workbench().update("colorCustomizations", { ...before, ...patch(season) }, GLOBAL);
  if (nextTitle !== undefined) await windowCfg().update("title", nextTitle, GLOBAL);
};

/** Replay `_saved` backwards, then clear it — the clear last, for the same reason. */
export const restore = async (saved: Saved): Promise<void> => {
  const next = { ...globalColors() };
  for (const [key, value] of Object.entries(saved.colors)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  await workbench().update(
    "colorCustomizations",
    Object.keys(next).length ? next : undefined,
    GLOBAL,
  );
  if ("title" in saved) await windowCfg().update("title", saved.title ?? undefined, GLOBAL);
  await seasons().update("_saved", undefined, GLOBAL);
};

// RFC 0019 §10, the layer the `vscode` mock exists for: what is written, in
// what order, at what scope, and what comes back out.
import { beforeEach, describe, expect, it } from "vitest";
import { ConfigurationTarget, reset, state } from "./vscode-mock";
import { DEFAULTS } from "../src/calendar";
import { COLOR_KEYS, patch } from "../src/overlay";
import { apply, describe as describeSaved, readSaved, restore, type Saved } from "../src/settings";

const halloween = DEFAULTS[0]!;
const christmas = DEFAULTS[1]!;

const saved = () => state.global["batlehub.seasons._saved"] as Saved | undefined;
const colors = () => state.global["workbench.colorCustomizations"] as Record<string, string>;

beforeEach(reset);

describe("apply", () => {
  it("writes _saved before the overlay it describes", async () => {
    await apply(halloween, true);
    const keys = state.updates.map((u) => u.key);
    expect(keys.indexOf("batlehub.seasons._saved")).toBeLessThan(
      keys.indexOf("workbench.colorCustomizations"),
    );
  });

  it("writes only at global scope", async () => {
    await apply(halloween, true);
    expect(state.updates).not.toHaveLength(0);
    for (const u of state.updates) expect(u.target).toBe(ConfigurationTarget.Global);
  });

  it("puts the season's eight keys into colorCustomizations", async () => {
    await apply(halloween, false);
    expect(colors()).toEqual(patch(halloween));
  });

  it("records an absent key as null, so restoring deletes it", async () => {
    await apply(halloween, false);
    for (const key of COLOR_KEYS) expect(saved()!.colors[key]).toBeNull();
  });

  it("records a key the user already set, so restoring writes it back", async () => {
    state.global["workbench.colorCustomizations"] = { "statusBar.background": "#007acc" };
    await apply(halloween, false);
    expect(saved()!.colors["statusBar.background"]).toBe("#007acc");
    for (const key of COLOR_KEYS)
      if (key !== "statusBar.background") expect(saved()!.colors[key]).toBeNull();
  });

  it("leaves the user's other colour keys alone", async () => {
    state.global["workbench.colorCustomizations"] = { "editor.background": "#101010" };
    await apply(halloween, false);
    expect(colors()["editor.background"]).toBe("#101010");
    expect(saved()!.colors).not.toHaveProperty("editor.background");
  });

  // The overlay is written at global scope, so it must merge into the global
  // value: merging the effective one would promote a workspace colour.
  it("never promotes a workspace colour to global", async () => {
    state.workspace["workbench.colorCustomizations"] = { "panel.border": "#ff0000" };
    await apply(halloween, false);
    expect(colors()).not.toHaveProperty("panel.border");
  });

  it("prefixes the glyph onto the user's own title and saves the old one", async () => {
    state.global["window.title"] = "${rootName}";
    await apply(halloween, true);
    expect(state.global["window.title"]).toBe("🎃 ${rootName}");
    expect(saved()!.title).toBe("${rootName}");
  });

  it("records a null title when the user had set none", async () => {
    await apply(halloween, true);
    expect(saved()!.title).toBeNull();
    expect(String(state.global["window.title"])).toMatch(/^🎃 \$\{dirty\}/);
  });

  it("does not touch the title at all when asked not to", async () => {
    await apply(halloween, false);
    expect(state.global).not.toHaveProperty("window.title");
    expect("title" in saved()!).toBe(false);
  });
});

describe("restore", () => {
  it("puts everything back exactly as it was", async () => {
    state.global["workbench.colorCustomizations"] = {
      "statusBar.background": "#007acc",
      "editor.background": "#101010",
    };
    state.global["window.title"] = "${rootName}";

    await apply(halloween, true);
    const current = readSaved();
    expect(current).toHaveProperty("saved");
    if (!("saved" in current)) return;
    await restore(current.saved);

    expect(colors()).toEqual({ "statusBar.background": "#007acc", "editor.background": "#101010" });
    expect(state.global["window.title"]).toBe("${rootName}");
    expect(state.global).not.toHaveProperty("batlehub.seasons._saved");
  });

  it("removes colorCustomizations entirely when it had nothing before", async () => {
    await apply(halloween, false);
    const current = readSaved();
    if (!("saved" in current)) throw new Error("expected a saved record");
    await restore(current.saved);
    expect(state.global).not.toHaveProperty("workbench.colorCustomizations");
  });

  it("removes window.title rather than inventing one", async () => {
    await apply(halloween, true);
    const current = readSaved();
    if (!("saved" in current)) throw new Error("expected a saved record");
    await restore(current.saved);
    expect(state.global).not.toHaveProperty("window.title");
  });

  it("clears _saved last", async () => {
    await apply(halloween, true);
    state.updates = [];
    const current = readSaved();
    if (!("saved" in current)) throw new Error("expected a saved record");
    await restore(current.saved);
    expect(state.updates.at(-1)).toMatchObject({
      key: "batlehub.seasons._saved",
      value: undefined,
    });
  });

  // The scenario the whole design is for: a window killed mid-season, and a
  // different season (or none) by the time one opens again.
  it("undoes a stale record from another season", async () => {
    state.global["window.title"] = "${rootName}";
    await apply(christmas, true);
    const stale = readSaved();
    if (!("saved" in stale)) throw new Error("expected a saved record");
    expect(stale.saved.season).toBe("season.christmas");

    await restore(stale.saved);
    await apply(halloween, true);

    expect(colors()).toEqual(patch(halloween));
    expect(state.global["window.title"]).toBe("🎃 ${rootName}");
    expect(saved()!.title).toBe("${rootName}");
  });

  it("does not stack glyphs if apply somehow runs twice", async () => {
    state.global["window.title"] = "${rootName}";
    await apply(halloween, true);
    await apply(halloween, true);
    expect(state.global["window.title"]).toBe("🎃 ${rootName}");
  });
});

describe("readSaved", () => {
  it("is none when the setting is absent or null", () => {
    expect(readSaved()).toEqual({ none: true });
    state.global["batlehub.seasons._saved"] = null;
    expect(readSaved()).toEqual({ none: true });
  });

  it.each([
    ["a number", 42],
    ["an array", []],
    ["a string", "halloween"],
    ["no season id", { colors: {} }],
    ["no colours map", { season: "x" }],
    ["a colours array", { season: "x", colors: [] }],
    ["a colour that is a number", { season: "x", colors: { a: 1 } }],
    ["a title that is a number", { season: "x", colors: {}, title: 7 }],
  ])("is bad for %s", (_why, value) => {
    state.global["batlehub.seasons._saved"] = value;
    expect(readSaved()).toHaveProperty("bad");
  });

  it("accepts a null title, which means the key was absent", () => {
    state.global["batlehub.seasons._saved"] = { season: "x", colors: {}, title: null };
    expect(readSaved()).toHaveProperty("saved");
  });
});

describe("describe", () => {
  it("says remove for an absent key and the value for a present one", async () => {
    state.global["workbench.colorCustomizations"] = { "statusBar.background": "#007acc" };
    await apply(halloween, true);
    const current = readSaved();
    if (!("saved" in current)) throw new Error("expected a saved record");
    const lines = describeSaved(current.saved);
    expect(lines).toContain("statusBar.background → #007acc");
    expect(lines.some((l) => l.includes("remove workbench.colorCustomizations"))).toBe(true);
    expect(lines).toContain("remove window.title");
  });
});

// RFC 0019 §10. The ordering of §5.1 is the extension's whole correctness
// argument — restore first, unconditionally, then work out what today is — so
// it is the thing most worth a test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireConfigChange, reset, state, type ExtensionContext } from "./vscode-mock";
import { activate } from "../src/extension";
import { DEFAULTS } from "../src/calendar";
import { patch } from "../src/overlay";

const halloween = DEFAULTS[0]!;
const context = (): ExtensionContext => ({ subscriptions: [] });
const colors = () => state.global["workbench.colorCustomizations"] as Record<string, string>;

/** Pin the clock, so "today" is a fact of the test rather than of the day it runs. */
const onDay = (month: number, day: number) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, month - 1, day, 12, 0, 0));
};

beforeEach(reset);
afterEach(() => vi.useRealTimers());

describe("in season", () => {
  beforeEach(() => onDay(10, 31));

  it("applies the overlay and shows the item", async () => {
    await activate(context());
    expect(colors()).toEqual(patch(halloween));
    expect(state.statusBar.visible).toBe(true);
    expect(state.statusBar.text).toBe("🎃 Halloween");
    expect(String(state.statusBar.tooltip)).toBe(
      "Halloween, until 11-01. Click to turn seasons off.",
    );
  });

  it("puts the glyph in the window title by default", async () => {
    await activate(context());
    expect(String(state.global["window.title"])).toMatch(/^🎃 /);
  });

  it("leaves the title alone when batlehub.seasons.title is false", async () => {
    state.global["batlehub.seasons.title"] = false;
    await activate(context());
    expect(state.global).not.toHaveProperty("window.title");
  });

  it("writes nothing at all when disabled", async () => {
    state.global["batlehub.seasons.enabled"] = false;
    await activate(context());
    expect(state.updates).toHaveLength(0);
    expect(state.statusBar.visible).toBe(false);
  });
});

describe("out of season", () => {
  beforeEach(() => onDay(2, 3));

  it("writes nothing and hides the item", async () => {
    await activate(context());
    expect(state.updates).toHaveLength(0);
    expect(state.statusBar.visible).toBe(false);
  });

  // The failure this design exists to prevent: the window closed on the 31st
  // of October and reopened in March, with an orange title bar and no clue.
  it("removes an overlay left behind by a killed window", async () => {
    state.global["workbench.colorCustomizations"] = patch(halloween);
    state.global["window.title"] = "🎃 ${rootName}";
    state.global["batlehub.seasons._saved"] = {
      season: "season.halloween",
      colors: Object.fromEntries(Object.keys(patch(halloween)).map((k) => [k, null])),
      title: "${rootName}",
    };

    await activate(context());

    expect(state.global).not.toHaveProperty("workbench.colorCustomizations");
    expect(state.global["window.title"]).toBe("${rootName}");
    expect(state.global).not.toHaveProperty("batlehub.seasons._saved");
    expect(state.statusBar.visible).toBe(false);
  });

  it("restores even when disabled, so turning it off is not a way to get stuck", async () => {
    state.global["batlehub.seasons.enabled"] = false;
    state.global["workbench.colorCustomizations"] = patch(halloween);
    state.global["batlehub.seasons._saved"] = {
      season: "season.halloween",
      colors: Object.fromEntries(Object.keys(patch(halloween)).map((k) => [k, null])),
    };
    await activate(context());
    expect(state.global).not.toHaveProperty("workbench.colorCustomizations");
  });
});

describe("a stale record from another season", () => {
  beforeEach(() => onDay(10, 31));

  it("is undone before today's is applied", async () => {
    state.global["window.title"] = "${rootName}";
    state.global["workbench.colorCustomizations"] = { ...patch(DEFAULTS[1]!) };
    state.global["batlehub.seasons._saved"] = {
      season: "season.christmas",
      colors: Object.fromEntries(Object.keys(patch(DEFAULTS[1]!)).map((k) => [k, null])),
      title: "${rootName}",
    };

    await activate(context());

    // Halloween's pair, not a merge of Christmas' and Halloween's.
    expect(colors()).toEqual(patch(halloween));
    expect(state.global["window.title"]).toBe("🎃 ${rootName}");
    expect((state.global["batlehub.seasons._saved"] as { season: string }).season).toBe(
      "season.halloween",
    );
  });

  it("restores before it resolves, in that order", async () => {
    state.global["batlehub.seasons._saved"] = {
      season: "season.christmas",
      colors: { "statusBar.background": "#007acc" },
    };
    await activate(context());
    const first = state.updates.findIndex((u) => u.key === "batlehub.seasons._saved");
    expect(state.updates[first]!.value).toBeUndefined(); // the clear, not a new record
  });
});

describe("an unusable _saved", () => {
  beforeEach(() => onDay(10, 31));

  it("stops the extension doing anything, and says so", async () => {
    state.global["batlehub.seasons._saved"] = "not a record";
    await activate(context());
    expect(state.updates).toHaveLength(0);
    expect(state.warnings.join(" ")).toContain("unusable");
    expect(state.statusBar.visible).toBe(false);
  });
});

describe("user entries", () => {
  beforeEach(() => onDay(3, 11));

  it("win against the defaults and drive the item", async () => {
    state.global["batlehub.seasons.events"] = [
      {
        name: "Release week",
        from: "03-10",
        to: "03-14",
        glyph: "🚢",
        background: "#1b3a8f",
        foreground: "#f4f7ff",
      },
    ];
    await activate(context());
    expect(state.statusBar.text).toBe("🚢 Release week");
    expect(colors()["titleBar.activeBackground"]).toBe("#1b3a8f");
  });

  it("are skipped one by one, with a warning, when malformed", async () => {
    state.global["batlehub.seasons.events"] = [
      { name: "Broken", from: "02-31", to: "03-14" },
      { name: "Release week", from: "03-10", to: "03-14", glyph: "🚢" },
    ];
    await activate(context());
    expect(state.statusBar.text).toBe("🚢 Release week");
    expect(state.warnings.join(" ")).toContain("skipped 1");
    expect(state.logs.join(" ")).toContain("Broken");
  });

  it("do not stop the editor when every one of them is broken", async () => {
    state.global["batlehub.seasons.events"] = [{ nope: true }];
    await activate(context());
    expect(state.statusBar.visible).toBe(false);
    expect(state.warnings).toHaveLength(1);
  });
});

describe("the commands", () => {
  beforeEach(() => onDay(10, 31));

  it("register both of them", async () => {
    await activate(context());
    expect(Object.keys(state.commands).sort()).toEqual([
      "batlehub.seasons.disable",
      "batlehub.seasons.remove",
    ]);
  });

  it("disable turns it off and puts everything back", async () => {
    state.global["window.title"] = "${rootName}";
    await activate(context());
    await state.commands["batlehub.seasons.disable"]!();
    expect(state.global["batlehub.seasons.enabled"]).toBe(false);
    expect(state.global).not.toHaveProperty("workbench.colorCustomizations");
    expect(state.global["window.title"]).toBe("${rootName}");
    expect(state.statusBar.visible).toBe(false);
  });

  it("remove asks first, and does nothing when the answer is no", async () => {
    await activate(context());
    state.answer = undefined;
    await state.commands["batlehub.seasons.remove"]!();
    expect(state.global["workbench.colorCustomizations"]).toEqual(patch(halloween));
  });

  it("remove restores when the answer is yes", async () => {
    await activate(context());
    state.answer = "Remove";
    await state.commands["batlehub.seasons.remove"]!();
    expect(state.global).not.toHaveProperty("workbench.colorCustomizations");
    expect(state.global).not.toHaveProperty("batlehub.seasons._saved");
  });

  it("remove says so when there is nothing written", async () => {
    onDay(2, 3);
    await activate(context());
    await state.commands["batlehub.seasons.remove"]!();
    expect(state.infos.join(" ")).toContain("nothing written");
  });
});

describe("batlehub.seasons.enabled changing", () => {
  beforeEach(() => onDay(10, 31));

  it("takes effect without a reload", async () => {
    await activate(context());
    expect(colors()).toEqual(patch(halloween));

    state.global["batlehub.seasons.enabled"] = false;
    await fireConfigChange("batlehub.seasons.enabled");
    expect(state.global).not.toHaveProperty("workbench.colorCustomizations");

    state.global["batlehub.seasons.enabled"] = true;
    await fireConfigChange("batlehub.seasons.enabled");
    expect(colors()).toEqual(patch(halloween));
  });

  it("ignores every other key, so the extension never reacts to its own writes", async () => {
    await activate(context());
    state.updates = [];
    await fireConfigChange("workbench.colorCustomizations");
    expect(state.updates).toHaveLength(0);
  });
});

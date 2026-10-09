import { describe, expect, it } from "vitest";
import {
  CHAIN_COMMAND,
  CHAIN_KEY,
  chainPlan,
  clampBudget,
  delegateDecision,
  toItems,
} from "../src/completion/chain";
import { parseManifest, record, takeEntry } from "../src/written";

const plan = (o: Partial<Parameters<typeof chainPlan>[0]> = {}) =>
  chainPlan({
    mode: "shortcut",
    inspected: undefined,
    coreWrote: false,
    undone: false,
    acknowledged: false,
    trusted: true,
    ...o,
  });

describe("RFC 0012 §4.2 — the default-on write, and all of its conditions", () => {
  it("writes when the key is absent at every scope, and announces it once", () => {
    expect(plan()).toMatchObject({ write: true, notice: true });
  });

  it("never writes over a value the user set — false or true, at any scope", () => {
    for (const value of [true, false])
      for (const scope of [
        "globalValue",
        "workspaceValue",
        "workspaceFolderValue",
      ] as const) {
        const p = plan({ inspected: { [scope]: value } });
        expect(p.write, `${scope}=${value}`).toBe(false);
        // Nothing is recorded and nothing is shown: a value BatleHub Java did
        // not write is not its to manage, so the remove command can never
        // delete a value the user chose.
        expect(p.notice, `${scope}=${value}`).toBe(false);
        expect(p.reason).toContain("set by you");
      }
  });

  it("does not write in an untrusted workspace, and says nothing there either", () => {
    expect(plan({ trusted: false })).toEqual({
      write: false,
      notice: false,
      reason: "untrusted workspace",
    });
  });

  it("remembers an Undo: the next activation does not write the key again", () => {
    expect(plan({ undone: true })).toMatchObject({
      write: false,
      notice: false,
    });
    // Even once the setting is gone from every scope again, which is exactly
    // the state Undo leaves behind.
    expect(plan({ undone: true, inspected: {} })).toMatchObject({
      write: false,
    });
  });

  it("is idempotent: a second activation writes nothing and repeats nothing", () => {
    // After the first write the value looks the same as a user's; the manifest
    // entry is what tells them apart.
    const second = plan({
      coreWrote: true,
      acknowledged: true,
      inspected: { workspaceValue: true },
    });
    expect(second).toMatchObject({ write: false, notice: false });
  });

  it("keeps the line up until it is read, across the reload that follows the write", () => {
    // The newcomer's first minute reloads the window right after this write
    // (RFC 0001 §4.2): a flag latched at write time would lose the only
    // announcement the core ever makes about it.
    expect(
      plan({
        coreWrote: true,
        acknowledged: false,
        inspected: { workspaceValue: true },
      }),
    ).toMatchObject({ write: false, notice: true });
  });
});

describe("RFC 0012 §4.2 — Undo is the removal of that one manifest entry", () => {
  const withBoth = () => {
    let m = parseManifest(undefined);
    m = record(m, {
      kind: "setting",
      key: "java.configuration.runtimes",
      scope: "workspace",
      before: undefined,
    });
    m = record(m, {
      kind: "setting",
      key: CHAIN_KEY,
      scope: "workspace",
      before: undefined,
    });
    return m;
  };

  it("takes the chain entry and leaves every other write alone", () => {
    const { manifest, entry } = takeEntry(withBoth(), `setting:${CHAIN_KEY}`);
    expect(entry).toMatchObject({ key: CHAIN_KEY, before: undefined });
    expect(manifest.entries.map((e) => (e as { key: string }).key)).toEqual([
      "java.configuration.runtimes",
    ]);
  });

  it("is a no-op when the core never wrote the key", () => {
    const m = parseManifest(undefined);
    const { manifest, entry } = takeEntry(m, `setting:${CHAIN_KEY}`);
    expect(entry).toBeUndefined();
    expect(manifest).toBe(m);
  });

  it("restores the value that was there before, which is 'unset'", () => {
    const { entry } = takeEntry(withBoth(), `setting:${CHAIN_KEY}`);
    // `before: undefined` is what `Undo` and `Remove BatleHub settings` both
    // put back — the key disappears rather than becoming `false`, because
    // `false` would be a value the user never chose.
    expect(entry && "before" in entry && entry.before).toBeUndefined();
  });
});

describe("RFC 0012 phase 2 — one source of chains at a time (decision 4)", () => {
  it('"auto" and "off" take the core\'s own write back, and write nothing new', () => {
    for (const mode of ["auto", "off"] as const) {
      expect(plan({ mode, coreWrote: true })).toMatchObject({
        write: false,
        unwrite: true,
        notice: false,
      });
      expect(plan({ mode })).toMatchObject({ write: false, notice: false });
      expect(plan({ mode }).unwrite).toBeUndefined();
    }
  });

  it("never takes back a value the user set: only the manifest entry is the core's", () => {
    expect(
      plan({ mode: "auto", inspected: { workspaceValue: true } }).unwrite,
    ).toBeUndefined();
  });

  it("answers only in auto, with the bundle's command, and never over a true server key", () => {
    const ok = {
      mode: "auto" as const,
      commands: [CHAIN_COMMAND],
      serverKey: undefined,
    };
    expect(delegateDecision(ok)).toBe("delegate");
    expect(delegateDecision({ ...ok, serverKey: false })).toBe("delegate");
    expect(delegateDecision({ ...ok, mode: "shortcut" })).toBe("not-auto");
    expect(delegateDecision({ ...ok, mode: "off" })).toBe("not-auto");
    expect(delegateDecision({ ...ok, serverKey: true })).toBe(
      "server-key-true",
    );
    expect(delegateDecision({ ...ok, commands: undefined })).toBe("absent");
    expect(delegateDecision({ ...ok, commands: ["batlehub.ping"] })).toBe(
      "absent",
    );
  });

  it("clamps the budget below 30 ms, and leaves 0 to the server", () => {
    expect(clampBudget(5)).toBe(30);
    expect(clampBudget(0)).toBe(0);
    expect(clampBudget(150)).toBe(150);
  });
});

describe("RFC 0012 §4.2 — the rank as sortText", () => {
  const row = (label: string, rank: number) => ({
    label,
    insertText: label,
    depth: 3,
    locality: 1,
    kind: "method" as const,
    rank,
  });

  it("keeps the bundle's order and sorts every chain after JDT's own nine-digit sortText", () => {
    const items = toItems(
      { rows: [row("a.b().c()", 0), row("x.y().z()", 1)], truncated: false },
      150,
    );
    expect(items.map((i) => i.label)).toEqual(["a.b().c()", "x.y().z()"]);
    expect(items[0]!.sortText < items[1]!.sortText).toBe(true);
    // The server's own chains are 999999979, a plain local sorts lower still.
    for (const i of items) expect(i.sortText > "999999999").toBe(true);
    expect(items[0]!.detail).toBe("chain · 3 · field");
  });

  it("says on the last item that the search was cut by the budget", () => {
    const items = toItems(
      { rows: [row("a.b().c()", 0), row("x.y().z()", 1)], truncated: true },
      150,
    );
    expect(items[0]!.detail).not.toContain("truncated");
    expect(items[1]!.detail).toContain("chains truncated at 150 ms");
  });
});

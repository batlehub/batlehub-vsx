import { describe, expect, it } from "vitest";
import { CHAIN_KEY, chainPlan } from "../src/completion/chain";
import { parseManifest, record, takeEntry } from "../src/written";

const plan = (o: Partial<Parameters<typeof chainPlan>[0]> = {}) =>
  chainPlan({
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

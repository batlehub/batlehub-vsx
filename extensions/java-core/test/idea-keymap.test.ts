import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  addEntries,
  normalizeKey,
  parseKeymap,
  planKeymap,
  removeEntries,
  toKey,
} from "../src/idea/keymap";

const MAX = `<keymap version="1" name="Max" parent="$default">
  <action id="Generate"><keyboard-shortcut first-keystroke="alt INSERT" /></action>
  <action id="RenameElement"><keyboard-shortcut first-keystroke="shift F6" /></action>
  <action id="ReformatCode"><keyboard-shortcut first-keystroke="control alt L" /></action>
  <action id="CompareTwoFiles"><keyboard-shortcut first-keystroke="control D" /></action>
  <action id="GotoAction"><keyboard-shortcut first-keystroke="control K" second-keystroke="control P" /></action>
  <action id="EditorDuplicate" />
</keymap>`;

describe("the IntelliJ keymap (RFC 0007 phase 3)", () => {
  it("reads a keymap's own actions and IDEA's keystroke grammar", () => {
    const k = parseKeymap(MAX);
    expect(k.name).toBe("Max");
    expect(k.parent).toBe("$default");
    expect(k.actions.map((a) => a.id)).toEqual([
      "Generate",
      "RenameElement",
      "ReformatCode",
      "CompareTwoFiles",
      "GotoAction",
      "EditorDuplicate",
    ]);
    expect(toKey("alt INSERT", "linux")).toBe("alt+insert");
    expect(toKey("control alt L", "linux")).toBe("ctrl+alt+l");
    expect(toKey("meta B", "darwin")).toBe("cmd+b");
    expect(toKey("meta B", "linux")).toBe("meta+b");
    expect(toKey("control K, control P", "linux")).toBe("ctrl+k ctrl+p");
    expect(toKey("control BRACE_MYSTERY", "linux")).toBeUndefined();
    expect(normalizeKey("Alt+Ctrl+L")).toBe("ctrl+alt+l");
  });

  it("plans what to write, keeps the user's own bindings, and names what it shadows", () => {
    const user = `// mine\n[\n  { "key": "ctrl+alt+l", "command": "my.format" }\n]`;
    const p = planKeymap(
      parseKeymap(MAX),
      user,
      [{ key: "shift+f6", command: "other.rename", extension: "x.y" }],
      "linux",
    );
    expect(p.entries).toEqual([
      {
        key: "alt+insert",
        command: "batlehub.java.generateMenu",
        when: "editorLangId == java",
      },
      { key: "shift+f6", command: "editor.action.rename" },
      { key: "ctrl+k ctrl+p", command: "workbench.action.showCommands" },
    ]);
    expect(p.skipped.map((s) => s.option)).toEqual([
      "ReformatCode (ctrl+alt+l)",
      "CompareTwoFiles",
      "EditorDuplicate",
    ]);
    expect(p.shadows).toEqual(["shift+f6 shadows x.y's other.rename"]);
  });

  it("adds marked entries and removes exactly those, the user's own kept", () => {
    const user = `// Place your key bindings in this file\n[\n  // mine\n  { "key": "ctrl+j", "command": "mine" }\n]`;
    const entries = planKeymap(parseKeymap(MAX), user, [], "linux").entries;
    const added = addEntries(user, entries, "Max");
    expect(parse(added)).toHaveLength(5);
    expect(added).toContain('// batlehub: imported from IntelliJ keymap "Max"');
    // A person adds one of their own after the import.
    const later = added.replace(
      /\n\]$/,
      `,\n  { "key": "ctrl+q", "command": "later" }\n]`,
    );
    const r = removeEntries(later);
    expect(r.removed).toBe(4);
    expect(parse(r.text)).toEqual([
      { key: "ctrl+j", command: "mine" },
      { key: "ctrl+q", command: "later" },
    ]);
    expect(r.text).toContain("// mine");
    // An empty file, as the editor creates it, round-trips to itself.
    const empty =
      "// Place your key bindings in this file to override the defaults\n[\n]";
    const once = addEntries(empty, entries, "Max");
    expect(parse(once)).toHaveLength(4);
    expect(parse(removeEntries(once).text)).toEqual([]);
    expect(removeEntries(user)).toEqual({ text: user, removed: 0 });
  });

  it("binds only commands that exist", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    ) as { contributes: { commands: { command: string }[] } };
    const ours = pkg.contributes.commands.map((c) => c.command);
    for (const [id, a] of Object.entries(ACTIONS))
      if (a.command.startsWith("batlehub."))
        expect(ours, id).toContain(a.command);
  });
});

describe("the keymap scope of the import plan", () => {
  const root = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "tests",
    "heavy",
    "fixtures",
  );
  const configDir = path.join(
    root,
    "idea-home",
    "JetBrains",
    "IntelliJIdea2026.1",
  );
  const user = {
    text: "[\n]",
    uri: "vscode-userdata:/User/keybindings.json",
    browser: true,
  };
  it("reads the active user keymap, never the workspace's, and says where it writes", async () => {
    const { planDiffs, readPlan, summary } = await import("../src/idea/import");
    const plan = readPlan(
      path.join(root, "maven-multi"),
      new Set(["keymap"]),
      configDir,
      {
        user,
        defaults: [],
        platform: "linux",
      },
    );
    expect(plan.errors).toEqual([]);
    expect(plan.keymap?.entries.map((e) => `${e.key} ${e.command}`)).toEqual([
      "alt+insert batlehub.java.generateMenu",
      "shift+f6 editor.action.rename",
    ]);
    const text = summary(plan).join("\n");
    expect(text).toContain('keymap               2 customisations of "Max"');
    expect(text).toContain("in this browser only");
    expect(text).toContain("- CompareTwoFiles: no command");
    expect(text).not.toContain("Evil");
    const [d] = planDiffs(plan, {});
    expect(d?.left).toBe(user.uri);
    expect(parse(d!.after)).toHaveLength(2);
  });
});

// `keymaps/<name>.xml` of the IDEA configuration directory → the user's
// keybindings (RFC 0007 §4.2 "Keymap", §6.4). Pure, like `codestyle.ts`: it
// parses strings and returns strings. The user file is reached through the
// editor's own command (`userkeys.ts`), never by a path: in the web build it
// lives in the browser (§11, spiked 2026-10-11).
import { parseTree, type Node } from "jsonc-parser";
import type { Skipped } from "./codestyle";

export interface IdeaKeymap {
  name: string;
  parent?: string;
  /** Only the keymap's own `<action>`s: the diff from its parent. */
  actions: { id: string; strokes: string[] }[];
}

export interface Keybinding {
  key: string;
  command: string;
  when?: string;
  args?: unknown;
}

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

export function parseKeymap(xml: string): IdeaKeymap {
  const head = /<keymap\b([^>]*)>/.exec(xml)?.[1];
  if (head === undefined) throw new Error("no <keymap> element");
  const actions: IdeaKeymap["actions"] = [];
  for (const m of xml.matchAll(
    /<action\b([^>]*?)(\/>|>([\s\S]*?)<\/action>)/g,
  )) {
    const id = attr(m[1]!, "id");
    if (!id) continue;
    const strokes = [
      ...(m[3] ?? "").matchAll(/<keyboard-shortcut\b([^>]*)\/>/g),
    ].flatMap((k) => {
      const first = attr(k[1]!, "first-keystroke");
      const second = attr(k[1]!, "second-keystroke");
      return first ? [second ? `${first}, ${second}` : first] : [];
    });
    actions.push({ id, strokes });
  }
  return {
    name: attr(head, "name") ?? "IntelliJ",
    parent: attr(head, "parent"),
    actions,
  };
}

const KEYS: Record<string, string> = {
  INSERT: "insert",
  DELETE: "delete",
  BACK_SPACE: "backspace",
  ENTER: "enter",
  ESCAPE: "escape",
  SPACE: "space",
  TAB: "tab",
  UP: "up",
  DOWN: "down",
  LEFT: "left",
  RIGHT: "right",
  HOME: "home",
  END: "end",
  PAGE_UP: "pageup",
  PAGE_DOWN: "pagedown",
  SLASH: "/",
  BACK_SLASH: "\\",
  MINUS: "-",
  EQUALS: "=",
  COMMA: ",",
  PERIOD: ".",
  SEMICOLON: ";",
  QUOTE: "'",
  BACK_QUOTE: "`",
  OPEN_BRACKET: "[",
  CLOSE_BRACKET: "]",
  ADD: "numpad_add",
  SUBTRACT: "numpad_subtract",
  MULTIPLY: "numpad_multiply",
  DIVIDE: "numpad_divide",
};
const MODIFIERS = ["ctrl", "shift", "alt", "meta", "cmd"];

/**
 * IDEA's keystroke grammar (`control alt L`, `shift F6`, `alt INSERT`, a chord
 * as `first, second`) → the editor's (`ctrl+alt+l`). `meta` is `cmd` on a
 * Mac. Undefined for a key this table does not know.
 */
export function toKey(
  stroke: string,
  platform: NodeJS.Platform,
): string | undefined {
  const chord = (part: string): string | undefined => {
    const words = part.trim().split(/\s+/);
    const key = words.pop()!;
    const mods = words.map((w) =>
      w === "control"
        ? "ctrl"
        : w === "meta"
          ? platform === "darwin"
            ? "cmd"
            : "meta"
          : w,
    );
    if (!mods.every((m) => MODIFIERS.includes(m))) return undefined;
    const k = /^[A-Z0-9]$/.test(key)
      ? key.toLowerCase()
      : /^F([1-9]|1[0-9])$/.test(key)
        ? key.toLowerCase()
        : /^NUMPAD[0-9]$/.test(key)
          ? key.toLowerCase()
          : KEYS[key];
    return k === undefined ? undefined : [...mods, k].join("+");
  };
  const parts = stroke.split(",").map(chord);
  return parts.every(Boolean) ? parts.join(" ") : undefined;
}

/** The same binding written two ways compares equal: modifiers in one order, lower case. */
export function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .split(/\s+/)
    .map((part) => {
      const ws = part.split("+");
      const k = ws.pop()!;
      const mods = ws.sort(
        (a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b),
      );
      return [...mods, k].join("+");
    })
    .join(" ");
}

const JAVA = "editorLangId == java";
const extract = (kind: string) => ({
  command: "editor.action.codeAction",
  args: { kind, apply: "first" },
  java: true,
});

/**
 * IDEA action → the editor's or BatleHub's command. Only actions with a
 * command doing the same thing; a `java` row binds in Java editors only.
 */
export const ACTIONS: Record<
  string,
  { command: string; java?: boolean; args?: unknown }
> = {
  Generate: { command: "batlehub.java.generateMenu", java: true },
  SurroundWith: { command: "batlehub.java.surroundWith", java: true },
  RenameElement: { command: "editor.action.rename" },
  GotoDeclaration: { command: "editor.action.revealDefinition" },
  GotoImplementation: { command: "editor.action.goToImplementation" },
  GotoTypeDeclaration: { command: "editor.action.goToTypeDefinition" },
  QuickImplementations: { command: "editor.action.peekDefinition" },
  FindUsages: { command: "editor.action.goToReferences" },
  ShowUsages: { command: "editor.action.referenceSearch.trigger" },
  CallHierarchy: { command: "references-view.showCallHierarchy" },
  QuickJavaDoc: { command: "editor.action.showHover" },
  ParameterInfo: { command: "editor.action.triggerParameterHints" },
  ShowIntentionActions: { command: "editor.action.quickFix" },
  ReformatCode: { command: "editor.action.formatDocument" },
  OptimizeImports: { command: "editor.action.organizeImports", java: true },
  CommentByLineComment: { command: "editor.action.commentLine" },
  CommentByBlockComment: { command: "editor.action.blockComment" },
  EditorDuplicate: { command: "editor.action.copyLinesDownAction" },
  EditorDeleteLine: { command: "editor.action.deleteLines" },
  EditorJoinLines: { command: "editor.action.joinLines" },
  MoveLineUp: { command: "editor.action.moveLinesUpAction" },
  MoveLineDown: { command: "editor.action.moveLinesDownAction" },
  MoveStatementUp: { command: "editor.action.moveLinesUpAction" },
  MoveStatementDown: { command: "editor.action.moveLinesDownAction" },
  EditorSelectWord: { command: "editor.action.smartSelect.expand" },
  EditorUnSelectWord: { command: "editor.action.smartSelect.shrink" },
  EditorToggleColumnMode: { command: "editor.action.toggleColumnSelection" },
  ExpandAllRegions: { command: "editor.unfoldAll" },
  CollapseAllRegions: { command: "editor.foldAll" },
  ExpandRegion: { command: "editor.unfold" },
  CollapseRegion: { command: "editor.fold" },
  ExtractMethod: extract("refactor.extract.function"),
  IntroduceVariable: extract("refactor.extract.variable"),
  IntroduceConstant: extract("refactor.extract.constant"),
  Inline: extract("refactor.inline"),
  GotoAction: { command: "workbench.action.showCommands" },
  GotoFile: { command: "workbench.action.quickOpen" },
  SearchEverywhere: { command: "workbench.action.quickOpen" },
  GotoClass: { command: "workbench.action.showAllSymbols" },
  GotoSymbol: { command: "workbench.action.showAllSymbols" },
  FileStructurePopup: { command: "workbench.action.gotoSymbol" },
  GotoLine: { command: "workbench.action.gotoLine" },
  Find: { command: "actions.find" },
  Replace: { command: "editor.action.startFindReplaceAction" },
  FindNext: { command: "editor.action.nextMatchFindAction" },
  FindPrevious: { command: "editor.action.previousMatchFindAction" },
  FindInPath: { command: "workbench.action.findInFiles" },
  ReplaceInPath: { command: "workbench.action.replaceInFiles" },
  Back: { command: "workbench.action.navigateBack" },
  Forward: { command: "workbench.action.navigateForward" },
  CloseContent: { command: "workbench.action.closeActiveEditor" },
  NextTab: { command: "workbench.action.nextEditor" },
  PreviousTab: { command: "workbench.action.previousEditor" },
  SplitVertically: { command: "workbench.action.splitEditorRight" },
  SplitHorizontally: { command: "workbench.action.splitEditorDown" },
  SaveAll: { command: "workbench.action.files.saveAll" },
  ShowSettings: { command: "workbench.action.openSettings" },
  CompileDirty: { command: "workbench.action.tasks.build" },
  RunClass: { command: "workbench.action.debug.run" },
  DebugClass: { command: "workbench.action.debug.start" },
  Run: { command: "workbench.action.debug.run" },
  Debug: { command: "workbench.action.debug.start" },
  Stop: { command: "workbench.action.debug.stop" },
  Resume: { command: "workbench.action.debug.continue" },
  StepOver: { command: "workbench.action.debug.stepOver" },
  StepInto: { command: "workbench.action.debug.stepInto" },
  StepOut: { command: "workbench.action.debug.stepOut" },
  ToggleLineBreakpoint: { command: "editor.debug.action.toggleBreakpoint" },
  ActivateProjectToolWindow: { command: "workbench.view.explorer" },
  ActivateFindToolWindow: { command: "workbench.view.search" },
  ActivateDebugToolWindow: { command: "workbench.view.debug" },
  ActivateVersionControlToolWindow: { command: "workbench.view.scm" },
  ActivateTerminalToolWindow: {
    command: "workbench.action.terminal.toggleTerminal",
  },
};

/** The marker comment above every entry the import writes: what removal looks for. */
export const MARKER = "// batlehub: imported from IntelliJ keymap";
const BASES = ["$default", "Eclipse", "NetBeans 6.5"];

export interface KeymapPlan {
  name: string;
  entries: Keybinding[];
  skipped: Skipped[];
  /** Entries written over a default some extension binds to the same key. */
  shadows: string[];
}

/** What the user file already binds, by normalized key. */
function bound(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const el of entriesOf(text)) {
    const key = stringProp(el, "key");
    const command = stringProp(el, "command");
    if (key && command && !command.startsWith("-"))
      out.set(normalizeKey(key), command);
  }
  return out;
}

const entriesOf = (text: string): Node[] => {
  const tree = parseTree(text, [], { allowTrailingComma: true });
  return tree?.type === "array" ? (tree.children ?? []) : [];
};
const stringProp = (el: Node, name: string): string | undefined => {
  const p = el.children?.find((c) => c.children?.[0]?.value === name);
  const v = p?.children?.[1]?.value;
  return typeof v === "string" ? v : undefined;
};

/**
 * The keymap's actions against the user file (§4.2): an action without a
 * command, a key this grammar cannot write and a key the user already binds
 * (theirs wins) are listed, not written; an extension's default on the same
 * key is written over, and named.
 */
export function planKeymap(
  keymap: IdeaKeymap,
  userText: string,
  defaults: { key: string; command: string; extension: string }[],
  platform: NodeJS.Platform,
): KeymapPlan {
  const plan: KeymapPlan = {
    name: keymap.name,
    entries: [],
    skipped: [],
    shadows: [],
  };
  if (keymap.parent && !BASES.includes(keymap.parent))
    plan.skipped.push({
      option: `parent "${keymap.parent}"`,
      reason:
        "imported as a diff all the same; its base is not the recommended IntelliJ keymap extension's",
    });
  const mine = bound(userText);
  const defaultsByKey = new Map(defaults.map((d) => [normalizeKey(d.key), d]));
  for (const a of keymap.actions) {
    const target = ACTIONS[a.id];
    if (!a.strokes.length) {
      plan.skipped.push({
        option: a.id,
        reason: "unbound in IDEA: removing a binding is not imported",
      });
      continue;
    }
    if (!target) {
      plan.skipped.push({ option: a.id, reason: "no command" });
      continue;
    }
    for (const stroke of a.strokes) {
      const key = toKey(stroke, platform);
      if (!key) {
        plan.skipped.push({
          option: `${a.id} (${stroke})`,
          reason: "a key this import cannot write",
        });
        continue;
      }
      const theirs = mine.get(normalizeKey(key));
      if (theirs) {
        plan.skipped.push({
          option: `${a.id} (${key})`,
          reason: `already bound by you to ${theirs} — yours is kept`,
        });
        continue;
      }
      const d = defaultsByKey.get(normalizeKey(key));
      if (d && d.command !== target.command)
        plan.shadows.push(`${key} shadows ${d.extension}'s ${d.command}`);
      plan.entries.push({
        key,
        command: target.command,
        ...(target.java ? { when: JAVA } : {}),
        ...(target.args ? { args: target.args } : {}),
      });
    }
  }
  return plan;
}

/** The user file with `entries` appended, each under the marker comment; comments and order kept. */
export function addEntries(
  text: string,
  entries: Keybinding[],
  keymap: string,
): string {
  const base = text.trim() ? text : "[\n]\n";
  const close = base.lastIndexOf("]");
  if (close < 0) throw new Error("the keybindings file is not a JSON array");
  const has = entriesOf(base).length > 0;
  const body = entries
    .map((e) => `  ${MARKER} "${keymap}"\n  ${JSON.stringify(e)}`)
    .join(",\n");
  // Back up over whitespace so the comma follows the last entry, not a blank line.
  let at = close;
  while (at > 0 && /\s/.test(base[at - 1]!)) at--;
  return `${base.slice(0, at)}${has ? "," : ""}\n${body}\n${base.slice(close)}`;
}

/**
 * The user file without the entries the import wrote — those with the
 * marker among the comments above them — and only those: a person's own
 * bindings and comments stay. The array is cut into one chunk per element
 * (its leading comments, then the element), the marked chunks dropped, the
 * rest joined with the commas between them.
 */
export function removeEntries(text: string): { text: string; removed: number } {
  const els = entriesOf(text);
  if (!els.length) return { text, removed: 0 };
  const commaAfter = (end: number) => {
    let i = end;
    while (/\s/.test(text[i] ?? "")) i++;
    return text[i] === "," ? i : text.indexOf(",", end);
  };
  const open = text.indexOf("[") + 1;
  const chunks = els.map((el, i) => {
    const start =
      i === 0 ? open : commaAfter(els[i - 1]!.offset + els[i - 1]!.length) + 1;
    return text.slice(start, el.offset + el.length);
  });
  const last = els[els.length - 1]!;
  const kept = chunks.filter((c) => !c.includes(MARKER));
  const removed = chunks.length - kept.length;
  if (!removed) return { text, removed: 0 };
  return {
    text:
      text.slice(0, open) +
      kept.join(",") +
      text.slice(last.offset + last.length),
    removed,
  };
}

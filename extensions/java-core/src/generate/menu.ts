// The Generate submenu (RFC 0001 §4.2 "Generate menu, v0.2 versus phase 6"):
// a grouped front end over `redhat.java`'s own generators, each taking one
// LSP `CodeActionParams` (spike b). From phase 6 the same entries try the
// bundle's delegate first, with the options of §4.1, and fall back here with
// a one-line notice. No entry ever dead-ends.
import * as vscode from "vscode";
import { readSettings } from "../config";
import type { Core } from "../extension";
import { log } from "../log";
import {
  hasLombok,
  lombokChoice,
  shortcutOptions,
  type ShortcutSettings,
} from "./options";

export type GeneratorKind =
  | "accessors"
  | "getters"
  | "setters"
  | "constructors"
  | "toString"
  | "hashCodeEquals"
  | "delegates"
  | "override"
  | "builder"
  | "withers";

/** Red Hat's prompt for each kind it has; the builder and withers have none (RFC 0015 §6.2). */
const REDHAT: Partial<Record<GeneratorKind, string>> = {
  accessors: "java.action.generateAccessorsPrompt",
  getters: "java.action.generateAccessorsPrompt",
  setters: "java.action.generateAccessorsPrompt",
  constructors: "java.action.generateConstructorsPrompt",
  toString: "java.action.generateToStringPrompt",
  hashCodeEquals: "java.action.hashCodeEqualsPrompt",
  delegates: "java.action.generateDelegateMethodsPrompt",
  override: "java.action.overrideMethodsPrompt",
};

/** `AccessorKind` of `redhat.java` (spike b): both = 0, getter = 1, setter = 2. */
// A Map, not an object literal: `toString` is a member of the union and an
// object literal's inherited `toString()` collides with the optional key.
const KIND = new Map<GeneratorKind, number>([
  ["accessors", 0],
  ["getters", 1],
  ["setters", 2],
]);

/** The delegate the phase 6 bundle answers, or undefined for the ones Red Hat keeps. */
export const DELEGATE = new Map<GeneratorKind, string>([
  ["accessors", "batlehub.generate.accessors"],
  ["getters", "batlehub.generate.accessors"],
  ["setters", "batlehub.generate.accessors"],
  ["builder", "batlehub.generate.builder"],
  ["withers", "batlehub.generate.withers"],
]);

/** Pure: the single argument Red Hat's prompt commands take. */
export function codeActionParams(
  uri: string,
  sel: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  },
  kind?: number,
) {
  return {
    textDocument: { uri },
    range: sel,
    context: { diagnostics: [] },
    ...(kind === undefined ? {} : { kind }),
  };
}

export async function generate(core: Core, what: GeneratorKind): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "java") {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Java: open a Java file first."),
    );
    return;
  }
  if (!(await core.server.requireStandard(vscode.l10n.t("generating code"))))
    return;
  const s = editor.selection;
  const params = codeActionParams(
    editor.document.uri.toString(),
    {
      start: { line: s.start.line, character: s.start.character },
      end: { line: s.end.line, character: s.end.character },
    },
    KIND.get(what),
  );
  if (what === "builder" || what === "withers")
    return shortcut(core, what, editor, params);
  const delegate = DELEGATE.get(what);
  if (delegate && core.bundle?.available) {
    try {
      const g = readSettings().generate;
      const opts = { ...g, kind: KIND.get(what) ?? 0 };
      const edit = (await vscode.commands.executeCommand(
        "java.execute.workspaceCommand",
        delegate,
        params,
        JSON.stringify(opts),
      )) as { changes?: Record<string, unknown[]> } | undefined;
      if (edit) {
        await applyLspEdit(edit);
        return;
      }
    } catch (e) {
      log.warn(
        `delegate ${delegate} failed, falling back to redhat.java: ${(e as Error).message}`,
      );
      void vscode.window.setStatusBarMessage(
        vscode.l10n.t(
          "Java: the BatleHub generator is not loaded; using Red Hat's (restart the language server to load it)",
        ),
        6000,
      );
    }
  }
  await vscode.commands.executeCommand(REDHAT[what]!, params);
}

type Params = ReturnType<typeof codeActionParams>;

/** One quick pick, the setting's value pre-selected; undefined on Esc. */
async function pickOne<T extends string>(
  title: string,
  items: { label: string; value: T; description?: string }[],
  current: T,
): Promise<T | undefined> {
  const qp = vscode.window.createQuickPick<(typeof items)[number]>();
  qp.title = title;
  qp.items = items;
  qp.activeItems = items.filter((i) => i.value === current);
  return new Promise((resolve) => {
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]?.value ?? qp.activeItems[0]?.value);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

/** The fields of the innermost class or record around the cursor, from the document's symbols. */
async function fieldsAt(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): Promise<string[]> {
  const symbols =
    (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      doc.uri,
    )) ?? [];
  let type: vscode.DocumentSymbol | undefined;
  const walk = (list: vscode.DocumentSymbol[]) => {
    for (const s of list)
      if (s.range.contains(pos)) {
        if (
          s.kind === vscode.SymbolKind.Class ||
          s.kind === vscode.SymbolKind.Struct
        )
          type = s;
        walk(s.children);
      }
  };
  walk(symbols);
  return (type?.children ?? [])
    .filter((c) => c.kind === vscode.SymbolKind.Field)
    .map((c) => c.name);
}

/**
 * Generate ▸ Builder… / With methods… (RFC 0015 §4.2): Lombok's annotation
 * when the project has it and the developer takes it, else fields, prefix and
 * placement (or style), each pre-selected from the settings; Esc at any step
 * writes nothing. A refusal is shown with its reason.
 */
async function shortcut(
  core: Core,
  what: "builder" | "withers",
  editor: vscode.TextEditor,
  params: Params,
): Promise<void> {
  if (!core.bundle?.commands?.includes(DELEGATE.get(what)!)) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Java: the BatleHub JDT bundle is not loaded, and this generator has no Red Hat equivalent: restart the language server.",
      ),
    );
    return;
  }
  const s: ShortcutSettings = readSettings().shortcuts;
  let classpath: string[] = [];
  try {
    classpath =
      (
        await core.server.api?.getClasspaths?.(editor.document.uri.toString(), {
          scope: "test",
        })
      )?.classpaths ?? [];
  } catch (e) {
    log.debug(`generate ${what}: no classpath (${(e as Error).message})`);
  }
  const annotation = what === "builder" ? "@Builder" : "@With";
  let lombok = false;
  const choice = lombokChoice(s.lombok, hasLombok(classpath));
  if (choice === "annotation") lombok = true;
  if (choice === "ask") {
    const a = await pickOne(
      vscode.l10n.t("Java: Lombok is on this module's classpath"),
      [
        { label: `${annotation} (Lombok)`, value: "lombok" as const },
        { label: vscode.l10n.t("Generated code"), value: "code" as const },
      ],
      "lombok",
    );
    if (!a) return;
    lombok = a === "lombok";
  }
  let fields: string[] | undefined;
  let methodPrefix: string = s.methodPrefix;
  let placement = s.placement;
  let style = s.withersStyle;
  if (!lombok) {
    const all = await fieldsAt(editor.document, editor.selection.active);
    if (all.length) {
      const picked = await vscode.window.showQuickPick(
        all.map((label) => ({ label, picked: true })),
        { canPickMany: true, title: vscode.l10n.t("Java: fields") },
      );
      if (!picked?.length) return;
      fields =
        picked.length === all.length ? undefined : picked.map((p) => p.label);
    }
    const prefix = await pickOne(
      vscode.l10n.t("Java: method names"),
      [
        { label: "withName(…)", value: "with" as const },
        { label: "setName(…)", value: "set" as const },
        { label: "name(…)", value: "" as const },
      ],
      s.methodPrefix,
    );
    if (prefix === undefined) return;
    methodPrefix = prefix;
    if (what === "builder") {
      const p = await pickOne(
        vscode.l10n.t("Java: where the builder goes"),
        [
          {
            label: vscode.l10n.t("Inner class"),
            value: "inner" as const,
            description: vscode.l10n.t("can call a private constructor"),
          },
          {
            label: vscode.l10n.t("Its own file"),
            value: "file" as const,
            description: "<Type>Builder.java",
          },
        ],
        s.placement,
      );
      if (!p) return;
      placement = p;
    } else {
      const st = await pickOne(
        vscode.l10n.t("Java: what a with method does"),
        [
          {
            label: vscode.l10n.t("Return a copy"),
            value: "copy" as const,
            description: vscode.l10n.t("records: the only form"),
          },
          {
            label: vscode.l10n.t("Set and return this"),
            value: "mutate" as const,
            description: vscode.l10n.t("final fields skipped"),
          },
        ],
        s.withersStyle,
      );
      if (!st) return;
      style = st;
    }
  }
  const edit = (await vscode.commands.executeCommand(
    "java.execute.workspaceCommand",
    DELEGATE.get(what),
    params,
    JSON.stringify(
      shortcutOptions(what, { fields, methodPrefix, placement, style, lombok }),
    ),
  )) as LspEdit & { refused?: string };
  if (edit?.refused) {
    log.info(`generate ${what}: ${edit.refused}`, "JDT");
    const ctor = vscode.l10n.t("Generate a constructor");
    const offer = /Constructors/.test(edit.refused) ? [ctor] : [];
    const a = await vscode.window.showWarningMessage(
      `Java: ${edit.refused.replace(/^batlehub: /, "")}`,
      ...offer,
    );
    if (a === ctor)
      await vscode.commands.executeCommand(REDHAT.constructors!, params);
    return;
  }
  if (edit) await applyLspEdit(edit);
}

interface LspTextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

export interface LspEdit {
  changes?: Record<string, unknown[]>;
  /** `create` operations and per-document edits: a builder in its own file (RFC 0015). */
  documentChanges?: (
    | { kind: "create"; uri: string }
    | { textDocument: { uri: string }; edits: LspTextEdit[] }
  )[];
}

/** An LSP WorkspaceEdit applied through the editor: one undo step, nothing saved. */
export async function applyLspEdit(edit: LspEdit): Promise<boolean> {
  const we = new vscode.WorkspaceEdit();
  for (const c of edit.documentChanges ?? []) {
    if ("kind" in c) {
      we.createFile(vscode.Uri.parse(c.uri), { ignoreIfExists: false });
      continue;
    }
    for (const e of c.edits)
      we.replace(
        vscode.Uri.parse(c.textDocument.uri),
        new vscode.Range(
          e.range.start.line,
          e.range.start.character,
          e.range.end.line,
          e.range.end.character,
        ),
        e.newText,
      );
  }
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    for (const e of edits as {
      range: {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      newText: string;
    }[]) {
      we.replace(
        vscode.Uri.parse(uri),
        new vscode.Range(
          e.range.start.line,
          e.range.start.character,
          e.range.end.line,
          e.range.end.character,
        ),
        e.newText,
      );
    }
  }
  return vscode.workspace.applyEdit(we);
}

/** The constructs of Surround with… (RFC 0015 §4.2), in the bundle's names. */
const CONSTRUCTS: { value: string; label: string }[] = [
  { value: "tryCatch", label: "try / catch" },
  { value: "tryFinally", label: "try / finally" },
  { value: "tryWithResources", label: "try-with-resources" },
  { value: "if", label: "if" },
  { value: "ifElse", label: "if / else" },
  { value: "while", label: "while" },
  { value: "for", label: "for" },
  { value: "synchronized", label: "synchronized" },
  { value: "runnable", label: "Runnable (lambda)" },
];

/**
 * Surround with… (RFC 0015 phase 2): the selection — widened by the bundle to
 * whole statements of one block — moved into the picked construct, one undo
 * step. A refusal says why and changes nothing.
 */
export async function surroundWith(core: Core): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "java") return;
  if (!(await core.server.requireStandard(vscode.l10n.t("surround with"))))
    return;
  if (!core.bundle?.commands?.includes("batlehub.generate.surroundWith")) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Java: the BatleHub JDT bundle is not loaded, and this generator has no Red Hat equivalent: restart the language server.",
      ),
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(CONSTRUCTS, {
    title: vscode.l10n.t("Java: surround with"),
  });
  if (!pick) return;
  const sel = editor.selection;
  const edit = (await vscode.commands.executeCommand(
    "java.execute.workspaceCommand",
    "batlehub.generate.surroundWith",
    editor.document.uri.toString(),
    {
      start: { line: sel.start.line, character: sel.start.character },
      end: { line: sel.end.line, character: sel.end.character },
    },
    JSON.stringify({
      construct: pick.value,
      catchType: readSettings().shortcuts.catchType,
    }),
  )) as LspEdit & { refused?: string; note?: string };
  if (edit?.note) log.info(edit.note, "JDT");
  if (edit?.refused) {
    log.info(`surround with ${pick.value}: ${edit.refused}`, "JDT");
    void vscode.window.showWarningMessage(
      `Java: ${edit.refused.replace(/^batlehub: /, "")}`,
    );
    return;
  }
  if (edit) await applyLspEdit(edit);
}

export function registerGenerate(core: Core): vscode.Disposable[] {
  const gens: GeneratorKind[] = [
    "accessors",
    "getters",
    "setters",
    "constructors",
    "toString",
    "hashCodeEquals",
    "delegates",
    "override",
    "builder",
    "withers",
  ];
  return [
    ...gens.map((g) =>
      vscode.commands.registerCommand(`batlehub.java.generate.${g}`, () =>
        generate(core, g),
      ),
    ),
    vscode.commands.registerCommand("batlehub.java.surroundWith", () =>
      surroundWith(core),
    ),
  ];
}

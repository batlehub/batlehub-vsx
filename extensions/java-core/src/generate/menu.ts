// The Generate submenu (RFC 0001 §4.2 "Generate menu, v0.2 versus phase 6"):
// a grouped front end over `redhat.java`'s own generators, each taking one
// LSP `CodeActionParams` (spike b). From phase 6 the same entries try the
// bundle's delegate first, with the options of §4.1, and fall back here with
// a one-line notice. No entry ever dead-ends.
import * as vscode from "vscode";
import { readSettings } from "../config";
import type { Core } from "../extension";
import { log } from "../log";

export type GeneratorKind =
  | "accessors"
  | "getters"
  | "setters"
  | "constructors"
  | "toString"
  | "hashCodeEquals"
  | "delegates"
  | "override";

const REDHAT: Record<GeneratorKind, string> = {
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
  await vscode.commands.executeCommand(REDHAT[what], params);
}

/** An LSP WorkspaceEdit (`changes: { uri: TextEdit[] }`) applied through the editor. */
export async function applyLspEdit(edit: {
  changes?: Record<string, unknown[]>;
}): Promise<boolean> {
  const we = new vscode.WorkspaceEdit();
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
  ];
  return gens.map((g) =>
    vscode.commands.registerCommand(`batlehub.java.generate.${g}`, () =>
      generate(core, g),
    ),
  );
}

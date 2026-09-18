// Rename with its keybinding and the Refactor / Go to submenus (RFC 0001
// §5.4, §6.1): nothing here is new code — the sequence exists in
// `redhat.java` and the editor; the core's contribution is the binding, the
// menu entry, the mode check and the preview threshold.
import * as vscode from "vscode";
import type { Core } from "../extension";

const REFACTORS: Record<
  string,
  { kind?: string; command?: string; needsStandard: boolean }
> = {
  rename: { needsStandard: true },
  extractMethod: { kind: "refactor.extract.function", needsStandard: true },
  extractVariable: { kind: "refactor.extract.variable", needsStandard: true },
  extractConstant: { kind: "refactor.extract.constant", needsStandard: true },
  extractField: { kind: "refactor.extract.field", needsStandard: true },
  inline: { kind: "refactor.inline", needsStandard: true },
  changeSignature: { kind: "refactor.change.signature", needsStandard: true },
  organizeImports: {
    command: "java.action.organizeImports",
    needsStandard: true,
  },
};

const GOTO: Record<string, string> = {
  definition: "editor.action.revealDefinition",
  typeDefinition: "editor.action.goToTypeDefinition",
  implementations: "editor.action.goToImplementation",
  references: "editor.action.goToReferences",
  superImplementation: "java.action.navigateToSuperImplementation",
  typeHierarchy: "java.action.showTypeHierarchy",
  symbol: "workbench.action.gotoSymbol",
  workspaceSymbol: "workbench.action.showAllSymbols",
};

export function registerRefactor(core: Core): vscode.Disposable[] {
  const out: vscode.Disposable[] = [];
  for (const [id, r] of Object.entries(REFACTORS)) {
    out.push(
      vscode.commands.registerCommand(
        `batlehub.java.refactor.${id}`,
        async () => {
          const editor = vscode.window.activeTextEditor;
          if (!editor) return;
          if (
            r.needsStandard &&
            !(await core.server.requireStandard(vscode.l10n.t("refactoring")))
          )
            return;
          if (id === "rename") {
            // The editor's own rename box; its preview (Ctrl+Enter) is the
            // editor's too. `prepareRename` and the workspace edit come from
            // JDT.LS, across every module (§5.4).
            await vscode.commands.executeCommand("editor.action.rename");
            return;
          }
          if (r.command) {
            await vscode.commands.executeCommand(
              r.command,
              editor.document.uri.toString(),
            );
            return;
          }
          await vscode.commands.executeCommand("editor.action.codeAction", {
            kind: r.kind,
            apply: "ifSingle",
          });
        },
      ),
    );
  }
  for (const [id, cmd] of Object.entries(GOTO)) {
    out.push(
      vscode.commands.registerCommand(`batlehub.java.goto.${id}`, async () => {
        const editor = vscode.window.activeTextEditor;
        if (cmd.startsWith("java.action.")) {
          if (
            !editor ||
            !(await core.server.requireStandard(vscode.l10n.t("navigation")))
          )
            return;
          await vscode.commands.executeCommand(
            cmd,
            editor.document.uri.toString(),
            {
              line: editor.selection.active.line,
              character: editor.selection.active.character,
            },
          );
          return;
        }
        await vscode.commands.executeCommand(cmd);
      }),
    );
  }
  return out;
}

// The user's keybindings, reached the one way that works on every build
// (RFC 0007 §11, spiked 2026-10-11): the editor's own command opens the
// document — a file on desktop, browser storage in the web build and Che —
// and the edit goes through that document and its save. No path is guessed.
import * as vscode from "vscode";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UserKeybindings {
  doc: vscode.TextDocument;
  /** The web build keeps the file in the browser: the bindings apply in that browser only. */
  browser: boolean;
}

export async function openUserKeybindings(): Promise<UserKeybindings> {
  await vscode.commands.executeCommand(
    "workbench.action.openGlobalKeybindingsFile",
  );
  for (let i = 0; i < 40; i++) {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && /keybindings\.json$/.test(doc.uri.path))
      return { doc, browser: doc.uri.scheme === "vscode-userdata" };
    await sleep(100);
  }
  throw new Error("the editor did not open the user keybindings file");
}

/** `change` over the document's text, applied as one edit and saved. False when the editor refused. */
export async function editUserKeybindings(
  change: (text: string) => string,
): Promise<boolean> {
  const { doc } = await openUserKeybindings();
  const text = doc.getText();
  const next = change(text);
  if (next === text) return true;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    doc.uri,
    new vscode.Range(doc.positionAt(0), doc.positionAt(text.length)),
    next,
  );
  return (await vscode.workspace.applyEdit(edit)) && (await doc.save());
}

/** Every installed extension's default bindings: what an imported key may shadow. */
export function extensionDefaults(): {
  key: string;
  command: string;
  extension: string;
}[] {
  const mac = process.platform === "darwin";
  return vscode.extensions.all.flatMap((e) => {
    const kb = (
      e.packageJSON as {
        contributes?: {
          keybindings?:
            | { key?: string; mac?: string; command?: string }
            | { key?: string; mac?: string; command?: string }[];
        };
      }
    ).contributes?.keybindings;
    return (Array.isArray(kb) ? kb : kb ? [kb] : []).flatMap((b) => {
      const key = (mac && b.mac) || b.key;
      return key && b.command
        ? [{ key, command: b.command, extension: e.id }]
        : [];
    });
  });
}

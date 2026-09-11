// A terminal in a Che pod has no clipboard: no X, no Wayland, no pbcopy. The
// editor in the browser has one, and `vscode.env.clipboard` reaches it from
// the extension host. So: listen on a unix socket, put pbcopy, pbpaste and
// xclip shims that talk to it on the terminal's PATH.
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { serve, writeShims } from "./shims";

let server: net.Server | undefined;

export function activate(context: vscode.ExtensionContext): void {
  if (process.platform === "win32") return;
  // ponytail: one fixed directory per user, so the PATH entry the editor
  // persists never goes stale; a second window on the same host takes the
  // socket over. A per-window directory if that ever matters.
  const dir = path.join(os.tmpdir(), `che-clipboard-${os.userInfo().uid}`);
  const sock = path.join(dir, "clipboard.sock");
  const { LD_LIBRARY_PATH } = process.env;
  writeShims(dir, process.execPath, sock, LD_LIBRARY_PATH ? { LD_LIBRARY_PATH } : {});
  server = serve(sock, vscode.env.clipboard);
  server.on("error", (e) => vscode.window.showErrorMessage(`Che Clipboard: ${e.message}`));
  const env = context.environmentVariableCollection;
  env.description = "pbcopy, pbpaste and xclip backed by the editor's clipboard";
  env.prepend("PATH", dir + path.delimiter);
}

export function deactivate(): void {
  server?.close();
  server = undefined;
}

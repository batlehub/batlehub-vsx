import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { type Action, type Level, parseLine } from "./protocol";
import { forward, parseForwarders } from "./forward";
import { FileTail } from "./tail";

let watchedFile: string | undefined;
let bridge: vscode.Webview | undefined;
let autoResolvePending = false;
const tail = new FileTail();
const configuration = () => vscode.workspace.getConfiguration("cheNotify");
const notificationFile = () => {
  const configured = configuration().get<string>("file")?.trim();
  return configured || path.join(os.homedir(), ".ide-notify");
};

function runAction(item: Action) {
  if (item.type === "url") return vscode.env.openExternal(vscode.Uri.parse(item.url, true));
  if (item.type === "file") {
    const position = item.line ? new vscode.Position(item.line - 1, 0) : undefined;
    return vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(item.path),
      position ? { selection: new vscode.Range(position, position) } : undefined,
    );
  }
  if (item.type === "command")
    return vscode.commands.executeCommand(item.command, ...(item.args ?? []));
  if (item.type === "shell") {
    const terminal = vscode.window.createTerminal({ name: item.label || "che-notify" });
    terminal.show(false);
    terminal.sendText(item.command);
    return;
  }
  if (item.type === "copy") {
    return vscode.env.clipboard
      .writeText(item.text)
      .then(() => vscode.window.setStatusBarMessage("Che Notify: copied to clipboard", 3000));
  }
}

function show(level: Level, message: string, actions: Action[]) {
  if (!message.trim() && !actions.length) return;
  const display =
    level === "error"
      ? vscode.window.showErrorMessage
      : level === "warn"
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;
  void display(message, ...actions.map((item) => item.label)).then((selected) => {
    const item = actions.find((candidate) => candidate.label === selected);
    if (item)
      void Promise.resolve(runAction(item)).catch((error: unknown) =>
        vscode.window.showErrorMessage(`Che Notify: action failed: ${String(error)}`),
      );
  });
  const target = bridge;
  if (target) void Promise.resolve(target.postMessage({ type: "notify", level, message, actions }));
  const forwarders = parseForwarders(configuration().get<unknown>("forwarders"));
  if (forwarders.length) {
    void forward({ level, message, actions }, forwarders).catch(() =>
      vscode.window.setStatusBarMessage("Che Notify: forwarding failed", 8000),
    );
  }
}

function processLines(lines: string[]) {
  for (const line of lines) {
    const item = parseLine(line);
    if (item) show(item.level, item.message, item.actions);
  }
}

function stopWatching() {
  if (watchedFile) fs.unwatchFile(watchedFile);
  watchedFile = undefined;
  tail.reset();
}

function startWatching() {
  stopWatching();
  watchedFile = notificationFile();
  try {
    fs.mkdirSync(path.dirname(watchedFile), { recursive: true });
    if (!fs.existsSync(watchedFile)) fs.writeFileSync(watchedFile, "", { mode: 0o600 });
    tail.start(watchedFile);
    const interval = configuration().get<number>("pollInterval") ?? 1000;
    fs.watchFile(watchedFile, { interval }, () => {
      try {
        processLines(tail.read(watchedFile!));
      } catch {
        // An atomic replace can race a poll. The next polling interval retries.
      }
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Che Notify: cannot watch ${watchedFile}: ${String(error)}`);
  }
}

function installCli(context: vscode.ExtensionContext) {
  if (!configuration().get<boolean>("installCli")) return;
  try {
    const source = path.join(context.extensionPath, "bin", "ide-notify");
    const directory = path.join(os.homedir(), ".local", "bin");
    const destination = path.join(directory, "ide-notify");
    const wanted = fs.readFileSync(source);
    const current = fs.existsSync(destination) ? fs.readFileSync(destination) : undefined;
    if (!current || !current.equals(wanted)) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, wanted, { mode: 0o755 });
    }
    fs.chmodSync(destination, 0o755);
  } catch (error) {
    vscode.window.showWarningMessage(`Che Notify: could not install ide-notify: ${String(error)}`);
  }
}

function bridgeHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>body{font-family:var(--vscode-font-family);padding:1rem}button{padding:.4rem .8rem}</style></head><body><h3>Browser notifications</h3><p>Allow notifications to relay Che Notify messages to your operating system.</p><button id="grant">Allow browser notifications</button><p id="status"></p><script>const v=acquireVsCodeApi(),s=document.querySelector('#status');function refresh(){s.textContent='Permission: '+(window.Notification?Notification.permission:'unavailable')}document.querySelector('#grant').onclick=async()=>{if(window.Notification)await Notification.requestPermission();refresh()};window.addEventListener('message',e=>{const d=e.data;if(!d||d.type!=='notify'||!window.Notification||Notification.permission!=='granted')return;const n=new Notification('Che Notify',{body:d.message});n.onclick=()=>{window.focus();if(d.actions&&d.actions[0])v.postMessage({type:'action',action:d.actions[0]});n.close()}});refresh()</script></body></html>`;
}

export function activate(context: vscode.ExtensionContext) {
  startWatching();
  installCli(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "cheNotify.osBridge",
      {
        resolveWebviewView(view) {
          bridge = view.webview;
          view.webview.options = { enableScripts: true };
          view.webview.html = bridgeHtml();
          view.webview.onDidReceiveMessage((message) => {
            if (message?.type === "action") void runAction(message.action as Action);
          });
          view.onDidDispose(() => (bridge = undefined));
          if (autoResolvePending && configuration().get<boolean>("osBridge.autoClose")) {
            autoResolvePending = false;
            setTimeout(
              () => void vscode.commands.executeCommand("workbench.action.closePanel"),
              1500,
            );
          }
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("cheNotify.test", () => {
      fs.appendFileSync(notificationFile(), "info|Che Notify test notification\n");
    }),
    vscode.commands.registerCommand("cheNotify.openOsBridge", () =>
      vscode.commands.executeCommand("cheNotify.osBridge.focus"),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("cheNotify.file") ||
        event.affectsConfiguration("cheNotify.pollInterval")
      )
        startWatching();
    }),
    { dispose: stopWatching },
  );
  if (configuration().get<boolean>("osBridge.autoOpen")) {
    autoResolvePending = true;
    void vscode.commands.executeCommand("cheNotify.osBridge.focus");
  }
}

export function deactivate() {
  stopWatching();
}

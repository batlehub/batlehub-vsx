// The satellite's activation (RFC 0001 §6.3, §4.2 "Satellite registration"):
// find the core, assert the contract, register the language, the status bar
// item and the panel tab. The core calls `start` with the JDK it resolved and
// the classpath JDT.LS reported; the server is a child of this extension.
import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";
import type { JavaCoreApi, Runtime } from "../../java-core/api";
import {
  CONTRACT_MAJOR,
  launch,
  settingsFor,
  type State,
  statusText,
  tabHtml,
} from "./server";

const channel = vscode.window.createOutputChannel("BatleHub Java: Groovy");
const log = (m: string) =>
  channel.appendLine(`[${new Date().toISOString()}] ${m}`);

let client: LanguageClient | undefined;
let state: State = "stopped";
let runtime: Runtime | undefined;
let classpath: string[] = [];
let warnedOnce = false;
let restart: (() => Promise<void>) | undefined;

async function startServer(
  context: vscode.ExtensionContext,
  ctx: {
    runtime: Runtime | undefined;
    folder: vscode.WorkspaceFolder;
    classpath: string[];
  },
  onState: () => void,
): Promise<vscode.Disposable> {
  runtime = ctx.runtime;
  classpath = ctx.classpath;
  const set = (s: State) => {
    state = s;
    onState();
  };
  if (!vscode.workspace.isTrusted) {
    set("untrusted");
    log("untrusted workspace: the server is not started");
    return new vscode.Disposable(() => {});
  }
  if (!ctx.runtime) {
    set("no-jdk");
    if (!warnedOnce) {
      warnedOnce = true;
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Groovy: BatleHub Java resolved no JDK, so the Groovy language server cannot start. Install one with Java: Install a JDK…",
        ),
      );
    }
    return new vscode.Disposable(() => {});
  }
  const jar = path.join(
    context.extensionPath,
    "server",
    "groovy-language-server-all.jar",
  );
  const { command, args } = launch(ctx.runtime.path, jar);
  const serverOptions: ServerOptions = {
    command,
    args,
    options: { cwd: ctx.folder.uri.fsPath },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "groovy" }],
    outputChannel: channel,
    initializationOptions: {},
    workspaceFolder: ctx.folder,
    synchronize: {},
  };
  set("starting");
  log(
    `starting: ${command} ${args.join(" ")} (cwd ${ctx.folder.uri.fsPath}, ${ctx.classpath.length} classpath entries)`,
  );
  const c = new LanguageClient(
    "batlehub-groovy",
    "Groovy",
    serverOptions,
    clientOptions,
  );
  client = c;
  try {
    await c.start();
    await c.sendNotification("workspace/didChangeConfiguration", {
      settings: settingsFor(ctx.classpath),
    });
    set("running");
    log("initialize succeeded; server running");
  } catch (e) {
    set("failed");
    log(`failed to start: ${(e as Error).message}`);
    if (!warnedOnce) {
      warnedOnce = true;
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "Groovy: the language server failed to start; Groovy files keep their syntax colouring. See the Groovy log.",
        ),
      );
    }
  }
  restart = async () => {
    await c.stop().catch(() => {});
    await startServer(context, ctx, onState);
  };
  return new vscode.Disposable(() => {
    void c.stop().catch(() => {});
    client = undefined;
    set("stopped");
  });
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const core =
    vscode.extensions.getExtension<JavaCoreApi>("batlehub.java-core");
  if (!core) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Groovy: BatleHub Java (batlehub.java-core) is not installed.",
      ),
    );
    return;
  }
  const api = await core.activate();
  try {
    api.assertContract(CONTRACT_MAJOR);
  } catch (e) {
    // The core already showed the refusal naming both versions (§4.3).
    log(`contract refused: ${(e as Error).message}`);
    return;
  }
  const def = {
    id: "groovy.server",
    defaultShown: false,
    ...statusText(state),
    command: "batlehub.java.groovy.showLog",
  };
  let itemHandle = api.registerStatusBarItem(def);
  const onState = () => {
    // The core reads the item's fields once per `registerStatusBarItem`: re-register to repaint.
    itemHandle.dispose();
    itemHandle = api.registerStatusBarItem({ ...def, ...statusText(state) });
  };
  context.subscriptions.push(
    channel,
    { dispose: () => itemHandle.dispose() },
    api.registerLanguage({
      id: "groovy",
      languages: ["groovy"],
      start: (ctx) => startServer(context, ctx, onState),
    }),
    api.registerPanelTab({
      id: "groovy",
      title: "Groovy",
      html: () =>
        tabHtml({
          state,
          jdk: runtime ? `${runtime.name} (${runtime.path})` : undefined,
          classpath: classpath.length,
          jar: "server/groovy-language-server-all.jar",
        }),
    }),
    vscode.commands.registerCommand("batlehub.java.groovy.showLog", () =>
      channel.show(true),
    ),
    vscode.commands.registerCommand(
      "batlehub.java.groovy.restart",
      async () => {
        if (restart) await restart();
        else
          void vscode.window.showInformationMessage(
            vscode.l10n.t(
              "Groovy: the server has not been started yet (no Groovy file opened, or no JDK).",
            ),
          );
      },
    ),
  );
  log(
    `registered with BatleHub Java (contract ${api.contractVersion.major}.${api.contractVersion.minor})`,
  );
}

export async function deactivate(): Promise<void> {
  await client?.stop().catch(() => {});
}

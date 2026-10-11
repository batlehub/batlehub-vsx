// The satellite's activation (RFC 0008 §6.1, revision 5): find the core,
// assert the contract, register the language, the status item and the panel
// tab. The core calls `start` with the folder's JDK and classpath; the
// satellite makes sure JetBrains' current server is in its storage, then has
// the core start it — the server runs on its own Java 25, the project's
// build on the folder's JDK (`JAVA_HOME`).
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";
import type { JavaCoreApi, ManagedProcess, Runtime } from "../../java-core/api";
import { ensure, installed, latestVersion } from "./fetch";
import {
  CONTRACT_MAJOR,
  DECLARED_MIB,
  isExpired,
  launch,
  type ProductInfo,
  type State,
  statusText,
  tabHtml,
} from "./server";

const channel = vscode.window.createOutputChannel("BatleHub Java: Kotlin");
const log = (m: string) =>
  channel.appendLine(`[${new Date().toISOString()}] ${m}`);

let client: LanguageClient | undefined;
let state: State = "stopped";
let runtime: Runtime | undefined;
let classpath: string[] = [];
let version: string | undefined;
let home: string | undefined;
let warnedOnce = false;
let restart: ((fresh: boolean) => Promise<void>) | undefined;

const cfg = () => vscode.workspace.getConfiguration("batlehub.java.kotlin");

/** The server to run: a configured directory, or JetBrains' release in our storage, downloaded once. */
async function serverHome(
  context: vscode.ExtensionContext,
  fresh: boolean,
  onDownload: () => void,
): Promise<{ home: string; version?: string }> {
  const fixed = cfg().get<string>("server.home");
  if (fixed) return { home: fixed };
  const dir = path.join(context.globalStorageUri.fsPath, "kotlin-server");
  const pinned = cfg().get<string>("server.version") ?? "latest";
  let v = pinned;
  if (pinned === "latest") {
    // Asked once a day, or when the release in hand has expired.
    const cached = context.globalState.get<{ v: string; at: number }>(
      "kotlin.latest",
    );
    if (!fresh && cached && Date.now() - cached.at < 86_400_000) v = cached.v;
    else {
      v = await latestVersion();
      await context.globalState.update("kotlin.latest", { v, at: Date.now() });
    }
  }
  const have = installed(dir, v);
  if (have) return { home: have, version: v };
  onDownload();
  const h = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t("Kotlin: JetBrains' language server"),
    },
    (p) => ensure(dir, v, (m) => (log(m), p.report({ message: m }))),
  );
  return { home: h, version: v };
}

async function startServer(
  api: JavaCoreApi,
  context: vscode.ExtensionContext,
  ctx: {
    runtime: Runtime | undefined;
    folder: vscode.WorkspaceFolder;
    classpath: string[];
  },
  onState: () => void,
  fresh = false,
): Promise<vscode.Disposable> {
  runtime = ctx.runtime;
  classpath = ctx.classpath;
  const set = (s: State) => {
    state = s;
    onState();
  };
  const none = new vscode.Disposable(() => {});
  restart = async (f) => {
    await stop();
    await startServer(api, context, ctx, onState, f);
  };
  let managed: ManagedProcess | undefined;
  const stop = async () => {
    await client?.stop().catch(() => {});
    await managed?.stop().catch(() => {});
    client = undefined;
  };
  if (cfg().get<boolean>("enabled") === false) {
    set("disabled");
    log("batlehub.java.kotlin.enabled is false: the server is not started");
    return none;
  }
  if (!vscode.workspace.isTrusted) {
    set("untrusted");
    log("untrusted workspace: the server is not started");
    return none;
  }
  const warn = (m: string) => {
    if (warnedOnce) return;
    warnedOnce = true;
    void vscode.window.showWarningMessage(m);
  };
  let systemPath: string;
  try {
    const s = await serverHome(context, fresh, () => set("downloading"));
    home = s.home;
    version = s.version;
    systemPath = path.join(
      context.globalStorageUri.fsPath,
      "kotlin-server",
      "system",
    );
  } catch (e) {
    set("failed");
    log(`no server: ${(e as Error).message}`);
    warn(
      vscode.l10n.t(
        "Kotlin: JetBrains' language server could not be downloaded ({0}). Kotlin files open without it; set batlehub.java.kotlin.server.home to an unpacked server to work offline.",
        (e as Error).message,
      ),
    );
    return none;
  }
  const info = JSON.parse(
    readFileSync(path.join(home, "product-info.json"), "utf8"),
  ) as ProductInfo;
  const l = info.launch.find((x) => x.os === "Linux") ?? info.launch[0]!;
  const { command, args } = launch(
    home,
    info,
    readFileSync(path.join(home, l.vmOptionsFilePath), "utf8"),
    {
      xmx: cfg().get<string>("server.xmx") || "1G",
      extra: cfg().get<string[]>("server.args") ?? [],
      systemPath,
    },
  );
  // Decision 4, as far as it holds: the server runs on its own Java 25; the
  // build it imports runs on the folder's JDK, which it reads from JAVA_HOME.
  const env: Record<string, string> = ctx.runtime
    ? { JAVA_HOME: ctx.runtime.path }
    : {};
  const serverOptions: ServerOptions = async () => {
    managed = await api.process.start({
      id: "kotlin-ls",
      argv: [command, ...args],
      cwd: ctx.folder.uri.fsPath,
      env,
      memoryMiB: DECLARED_MIB,
      stdio: "streams",
    });
    return { reader: managed.streams!.reader, writer: managed.streams!.writer };
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "kotlin" }],
    outputChannel: channel,
    workspaceFolder: ctx.folder,
  };
  set("starting");
  log(
    `starting: kotlin-server ${version ?? "(configured)"} at ${home}, ${command} -Xmx… (cwd ${ctx.folder.uri.fsPath}, JAVA_HOME ${ctx.runtime?.path ?? "unset"}, ${ctx.classpath.length} classpath entries)`,
  );
  const c = new LanguageClient(
    "batlehub-kotlin",
    "Kotlin",
    serverOptions,
    clientOptions,
  );
  client = c;
  try {
    await c.start();
    set("running");
    log("initialize succeeded; server running");
  } catch (e) {
    let serverLog = "";
    try {
      serverLog = readFileSync(
        path.join(systemPath, "system", "log", "intellij-server.log"),
        "utf8",
      );
    } catch {
      // No log yet: the JVM did not get that far.
    }
    if (isExpired(serverLog)) {
      set("expired");
      log(
        `kotlin-server ${version} has expired: Restart fetches the current release`,
      );
      warn(
        vscode.l10n.t(
          "Kotlin: this release of JetBrains' language server has expired. Restart the server to fetch the current one.",
        ),
      );
    } else {
      set("failed");
      log(`failed to start: ${(e as Error).message}`);
      warn(
        vscode.l10n.t(
          "Kotlin: the language server failed to start. See the Kotlin log.",
        ),
      );
    }
  }
  return new vscode.Disposable(() => {
    void stop();
    set("stopped");
  });
}

/** RFC 0008 §4.2: never two Kotlin servers silently. */
async function coexistence(api: JavaCoreApi): Promise<void> {
  if (cfg().get<boolean>("enabled") === false) return;
  const fwcd = vscode.extensions.getExtension("fwcd.kotlin");
  const jetbrains = vscode.extensions.getExtension("JetBrains.kotlin-server");
  if (!fwcd && !jetbrains) return;
  const theirs = vscode.l10n.t("Turn off the other server");
  const ours = vscode.l10n.t("Turn off BatleHub's");
  const pick = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Kotlin: {0} is installed too, and two Kotlin servers would both answer. Which one stays?",
      fwcd ? "fwcd.kotlin" : "JetBrains.kotlin-server",
    ),
    ...(fwcd ? [theirs] : []),
    ours,
  );
  if (pick === theirs)
    await api.manifest.writeSetting("kotlin.languageServer.enabled", false);
  else if (pick === ours)
    await api.manifest.writeSetting("batlehub.java.kotlin.enabled", false);
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const core =
    vscode.extensions.getExtension<JavaCoreApi>("batlehub.java-core");
  if (!core) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Kotlin: BatleHub Java (batlehub.java-core) is not installed.",
      ),
    );
    return;
  }
  const api = await core.activate();
  try {
    api.assertContract(CONTRACT_MAJOR);
  } catch (e) {
    log(`contract refused: ${(e as Error).message}`);
    return;
  }
  const def = {
    id: "kotlin.server",
    defaultShown: false,
    ...statusText(state),
    command: "batlehub.java.kotlin.showLog",
  };
  let itemHandle = api.registerStatusBarItem(def);
  const onState = () => {
    itemHandle.dispose();
    itemHandle = api.registerStatusBarItem({ ...def, ...statusText(state) });
  };
  context.subscriptions.push(
    channel,
    { dispose: () => itemHandle.dispose() },
    api.registerLanguage({
      id: "kotlin",
      languages: ["kotlin"],
      start: (ctx) => startServer(api, context, ctx, onState),
    }),
    api.registerPanelTab({
      id: "kotlin",
      title: "Kotlin",
      html: () =>
        tabHtml({
          state,
          version,
          home,
          jdk: runtime ? `${runtime.name} (${runtime.path})` : undefined,
          classpath: classpath.length,
        }),
    }),
    vscode.commands.registerCommand("batlehub.java.kotlin.showLog", () =>
      channel.show(true),
    ),
    vscode.commands.registerCommand(
      "batlehub.java.kotlin.restart",
      async () => {
        if (restart) await restart(state === "expired");
        else
          void vscode.window.showInformationMessage(
            vscode.l10n.t(
              "Kotlin: the server has not been started yet (no Kotlin file opened).",
            ),
          );
      },
    ),
  );
  log(
    `registered with BatleHub Java (contract ${api.contractVersion.major}.${api.contractVersion.minor})`,
  );
  void coexistence(api);
}

export async function deactivate(): Promise<void> {
  await client?.stop().catch(() => {});
}

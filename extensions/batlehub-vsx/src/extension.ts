// The entry point: read the settings, decide the mode (RFC 0011 §4.2),
// register the authentication provider, start the broker, and — in
// marketplace mode — the view and its commands.
import * as vscode from "vscode";
import { BatleHubClient, ExtensionSummary, extensionId, splitId } from "./api";
import { BatleHubAuthProvider } from "./auth-provider";
import { Broker } from "./broker";
import { readSettings, Settings } from "./config";
import { channelOf, disposeLog, log } from "./log";
import { ReadmeProvider, README_SCHEME, showExtension } from "./marketplace/detail";
import {
  applyPlan,
  InstallRefused,
  installedInEditor,
  installedVersion,
  planInstall,
  uninstall,
} from "./marketplace/installer";
import { Ledger } from "./marketplace/ledger";
import { ExtensionNode, MarketplaceTree } from "./marketplace/tree";
import { decideMode, ModeDecision, readProduct } from "./mode";

export function activate(context: vscode.ExtensionContext): void {
  let settings = readSettings();
  const auth = new BatleHubAuthProvider(context.secrets, () => settings.origin);
  const broker = new Broker(settings, auth, () => settings);
  const ledger = new Ledger(context.globalState);
  const readmes = new ReadmeProvider();
  let decision: ModeDecision = decide(settings);
  let client: BatleHubClient | null = makeClient(settings, broker);

  const tree = new MarketplaceTree(
    () => client,
    ledger,
    () => settings.pageSize,
  );
  const view = vscode.window.createTreeView("batlehub.marketplace", {
    treeDataProvider: tree,
    showCollapseAll: false,
  });

  const apply = () => {
    settings = readSettings();
    decision = decide(settings);
    client = makeClient(settings, broker);
    broker.configure(settings);
    void vscode.commands.executeCommand(
      "setContext",
      "batlehub.configured",
      settings.origin !== null,
    );
    void vscode.commands.executeCommand("setContext", "batlehub.mode", decision.mode);
    view.title =
      decision.mode === "marketplace"
        ? `Extensions${client ? ` · ${client.registryName || settings.origin}` : ""}`
        : "Extensions";
    tree.reset();
  };
  apply();
  log(
    `activated: mode ${decision.mode} (${decision.reason}); registry ${settings.registry || "(none)"}; contract ${settings.contractPath}`,
  );

  const install = async (s: ExtensionSummary, version?: string) => {
    const c = client;
    if (!c) return;
    const id = extensionId(s.namespace, s.name);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `BatleHub: ${id}`,
        cancellable: false,
      },
      async (p) => {
        try {
          const plan = await planInstall(
            c,
            { namespace: s.namespace, name: s.name, version },
            {
              verifySignatures: settings.verifySignatures,
              isInstalled: installedInEditor,
              confirmWarned: async (wid, v) => {
                const yes = "Install anyway";
                const r = await vscode.window.showWarningMessage(
                  `${wid} ${v} carries a warning from the registry's supply-chain scan.`,
                  { modal: true },
                  yes,
                );
                return r === yes;
              },
              progress: (m) => p.report({ message: m }),
            },
          );
          const installed = await applyPlan(plan, c, ledger, (m) => p.report({ message: m }));
          const extra = plan.missing.length
            ? ` Not in the registry: ${plan.missing.join(", ")}.`
            : "";
          void vscode.window.showInformationMessage(
            `BatleHub: installed ${installed.join(", ")}.${extra}`,
          );
        } catch (e) {
          const msg = (e as Error).message;
          log(`install ${id}: ${msg}`);
          void vscode.window.showErrorMessage(
            e instanceof InstallRefused
              ? `BatleHub: ${msg}`
              : `BatleHub: installing ${id} failed — ${msg}`,
          );
        }
      },
    );
    tree.redraw();
  };

  const detailActions = {
    install,
    uninstall: async (id: string) => {
      await uninstall(id, ledger);
      tree.redraw();
    },
    installedVersion,
  };

  context.subscriptions.push(
    auth,
    broker,
    tree,
    view,
    { dispose: disposeLog },
    vscode.workspace.registerTextDocumentContentProvider(README_SCHEME, readmes),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("batlehub")) {
        apply();
        log(
          `settings changed: mode ${decision.mode} (${decision.reason}); registry ${settings.registry || "(none)"}`,
        );
      }
    }),
    broker.onDidChange(() => tree.redraw()),
    vscode.extensions.onDidChange(() => tree.redraw()),

    vscode.commands.registerCommand("batlehub.signIn", () =>
      broker.signIn().then(() => tree.refresh()),
    ),
    vscode.commands.registerCommand("batlehub.signOut", () =>
      broker.signOut().then(() => tree.reset()),
    ),
    vscode.commands.registerCommand("batlehub.status", () =>
      broker.showStatus(decision.mode, decision.reason),
    ),
    vscode.commands.registerCommand("batlehub.refreshCredential", async () => {
      await broker.tick();
      await broker.requery();
      tree.redraw();
    }),
    vscode.commands.registerCommand("batlehub.showLog", () => channelOf().show(true)),
    vscode.commands.registerCommand("batlehub.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "batlehub."),
    ),

    vscode.commands.registerCommand("batlehub.search", async () => {
      const q = await vscode.window.showInputBox({
        title: "BatleHub: search extensions",
        value: tree.currentQuery,
        prompt: "Empty lists everything the registry shows you.",
      });
      if (q === undefined) return;
      await tree.search(q.trim());
    }),
    vscode.commands.registerCommand("batlehub.refreshView", () => tree.refresh()),
    vscode.commands.registerCommand("batlehub.checkUpdates", async () => {
      const c = client;
      if (!c) return;
      const updates: string[] = [];
      for (const [id, entry] of Object.entries(ledger.all())) {
        const parts = splitId(id);
        if (!parts) continue;
        const have = installedVersion(id);
        if (!have) continue;
        try {
          const doc = await c.extension(parts.namespace, parts.name);
          if (doc && doc.version !== have) updates.push(`${id} ${have} → ${doc.version}`);
        } catch (e) {
          log(`checking ${id}: ${(e as Error).message}`);
        }
        void entry;
      }
      await tree.refresh();
      void vscode.window.showInformationMessage(
        updates.length
          ? `BatleHub: updates available — ${updates.join(", ")}`
          : "BatleHub: everything installed from the registry is current.",
      );
    }),
    vscode.commands.registerCommand("batlehub.install", (n?: ExtensionNode) =>
      n?.summary ? install(n.summary) : undefined,
    ),
    vscode.commands.registerCommand("batlehub.update", (n?: ExtensionNode) =>
      n?.summary ? install(n.summary) : undefined,
    ),
    vscode.commands.registerCommand("batlehub.uninstall", (n?: ExtensionNode) =>
      n?.summary
        ? detailActions.uninstall(extensionId(n.summary.namespace, n.summary.name))
        : undefined,
    ),
    vscode.commands.registerCommand("batlehub.showExtension", (n?: ExtensionNode) =>
      n?.summary && client ? showExtension(client, readmes, n.summary, detailActions) : undefined,
    ),
    vscode.commands.registerCommand("batlehub.installById", async (arg?: string) => {
      const c = client;
      if (!c) {
        void vscode.window.showWarningMessage("BatleHub: set batlehub.registry first.");
        return;
      }
      const raw =
        arg ??
        (await vscode.window.showInputBox({
          title: "BatleHub: install by id",
          prompt: "publisher.name, optionally @version",
          placeHolder: "publisher.name@1.2.3",
        }));
      if (!raw) return;
      const [idPart, version] = raw.trim().split("@");
      const parts = splitId(idPart ?? "");
      if (!parts) {
        void vscode.window.showErrorMessage(`BatleHub: "${raw}" is not a publisher.name id.`);
        return;
      }
      await install(
        {
          ...parts,
          version: version ?? "",
          displayName: idPart!,
          description: "",
          url: "",
          files: { download: "" },
        },
        version || undefined,
      );
    }),
  );
}

export function deactivate(): void {}

function decide(settings: Settings): ModeDecision {
  return decideMode(settings.mode, readProduct(vscode.env.appRoot), process.env, settings.registry);
}

function makeClient(settings: Settings, broker: Broker): BatleHubClient | null {
  if (!settings.origin) return null;
  const chain = () => broker.chainOf();
  return new BatleHubClient(settings.registry, {
    get: async () => (await chain()?.resolve({ interactive: false }))?.token ?? null,
    reresolve: async () => {
      // A 401 after a credential was sent: the file may have been rewritten
      // by its owner meanwhile, or the session may need its refresh token.
      const cred = await chain()?.resolve({ interactive: false });
      return cred?.token ?? null;
    },
  });
}

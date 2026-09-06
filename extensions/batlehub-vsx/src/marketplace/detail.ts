// The detail of an entry: the registry's readme in the editor's markdown
// preview (a virtual document under the `batlehub` scheme), and a quick
// pick of what can be done with the entry — install, update, uninstall,
// the verdict, the signature.
import * as vscode from "vscode";
import { BatleHubClient, ExtensionDoc, ExtensionSummary, extensionId, verdictState } from "../api";
import { log } from "../log";

export const README_SCHEME = "batlehub";

export class ReadmeProvider implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, text: string): void {
    this.docs.set(uri.toString(), text);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "_Loading…_";
  }
}

export function readmeUri(id: string, version: string): vscode.Uri {
  return vscode.Uri.from({ scheme: README_SCHEME, path: `/${id}/${version}/README.md` });
}

export interface DetailActions {
  install: (s: ExtensionSummary, version?: string) => Promise<void>;
  uninstall: (id: string) => Promise<void>;
  installedVersion: (id: string) => string | null;
}

/** Everything the quick pick shows, fetched once. */
export async function describe(
  client: BatleHubClient,
  s: ExtensionSummary,
): Promise<{ doc: ExtensionDoc | null; verdict: string | null; readme: string | null }> {
  const [doc, verdict, readme] = await Promise.all([
    client.extension(s.namespace, s.name).catch((e) => {
      log(`extension document for ${extensionId(s.namespace, s.name)}: ${(e as Error).message}`);
      return null;
    }),
    client
      .verdict(s.namespace, s.name, s.version)
      .then(verdictState)
      .catch(() => null),
    client.readme(s.namespace, s.name, s.version).catch(() => null),
  ]);
  return { doc, verdict, readme };
}

export async function showExtension(
  client: BatleHubClient,
  readmes: ReadmeProvider,
  s: ExtensionSummary,
  actions: DetailActions,
): Promise<void> {
  const id = extensionId(s.namespace, s.name);
  const { doc, verdict, readme } = await describe(client, s);
  const have = actions.installedVersion(id);
  const signature = doc?.files.signature
    ? doc.files.publicKey
      ? "signed by the registry"
      : "carries its publisher's signature"
    : "unsigned";
  const versions = doc?.allVersions
    ? Object.keys(doc.allVersions).filter((v) => v !== "latest")
    : [s.version];

  const items: (vscode.QuickPickItem & { run?: () => Promise<void> })[] = [];
  const header = (label: string, detail?: string) =>
    items.push({ label, detail, kind: vscode.QuickPickItemKind.Default, alwaysShow: true });
  header(`$(info) ${s.displayName} — ${id}`, s.description || undefined);
  header(
    `$(tag) ${s.version}${have ? ` · installed ${have}` : ""}`,
    `${signature}${verdict ? ` · verdict: ${verdict}` : ""}`,
  );
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  if (!have) items.push({ label: "$(cloud-download) Install", run: () => actions.install(s) });
  else if (have !== s.version)
    items.push({ label: `$(arrow-up) Update to ${s.version}`, run: () => actions.install(s) });
  if (have) items.push({ label: "$(trash) Uninstall", run: () => actions.uninstall(id) });
  if (versions.length > 1)
    items.push({
      label: "$(versions) Install another version…",
      run: async () => {
        const v = await vscode.window.showQuickPick(versions, { title: `${id}: version` });
        if (v) await actions.install(s, v);
      },
    });
  items.push({
    label: "$(book) Open the readme",
    run: async () => {
      const uri = readmeUri(id, s.version);
      readmes.set(
        uri,
        readme ?? `# ${s.displayName}\n\n_${id} ${s.version} has no readme in the registry._`,
      );
      try {
        await vscode.commands.executeCommand("markdown.showPreview", uri);
      } catch {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), {
          preview: true,
        });
      }
    },
  });
  items.push({
    label: "$(copy) Copy the id",
    run: async () => {
      await vscode.env.clipboard.writeText(id);
    },
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: `BatleHub: ${s.displayName}`,
    ignoreFocusOut: true,
  });
  if (pick?.run) await pick.run();
}

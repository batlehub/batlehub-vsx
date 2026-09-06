// Installing from the registry into the editor, RFC 0011 §6.5: the VSIX
// is fetched with the credential, its dependencies and packs are resolved
// depth-first and cycle-guarded from the same registry, the registry's
// signature is verified when the entry carries one (RFC 0020), the
// verdict of RFC 0018 is honoured, and the editor's own install command
// does the rest — the file goes through `workbench.extensions.installExtension`,
// so the editor's dependency, engine and trust checks still run.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { BatleHubClient, ExtensionDoc, extensionId, verdictState } from "../api";
import { log } from "../log";
import { readVsixManifest, verifyVsixSignature, VsixManifest } from "../vsix";
import { Ledger } from "./ledger";

export interface PlannedItem {
  doc: ExtensionDoc;
  vsix: Uint8Array;
  manifest: VsixManifest;
  signature: { checked: boolean; ok: boolean; reason: string };
}

export interface InstallPlan {
  /** Post-order: dependencies before what needs them. */
  items: PlannedItem[];
  /** Dependencies the registry does not hold; the editor will say so at install. */
  missing: string[];
}

export interface InstallerOptions {
  verifySignatures: boolean;
  /** Which extensions are already present, by id (lower-case). */
  isInstalled: (id: string) => boolean;
  /** The user's answer to a `warned` verdict; default: ask. */
  confirmWarned?: (id: string, version: string) => Promise<boolean>;
  progress?: (message: string) => void;
}

export class InstallRefused extends Error {}

/**
 * Everything that can be decided before a byte reaches the editor: the
 * downloads, the manifests, the dependency order, the signatures and the
 * verdicts. Pure enough to test with a fake client.
 */
export async function planInstall(
  client: BatleHubClient,
  root: { namespace: string; name: string; version?: string },
  opts: InstallerOptions,
): Promise<InstallPlan> {
  const items: PlannedItem[] = [];
  const missing: string[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = async (
    namespace: string,
    name: string,
    version: string | undefined,
    isRoot: boolean,
  ): Promise<void> => {
    const id = extensionId(namespace, name).toLowerCase();
    if (done.has(id) || visiting.has(id)) return;
    if (!isRoot && opts.isInstalled(id)) return;
    visiting.add(id);
    opts.progress?.(`Resolving ${extensionId(namespace, name)}${version ? ` ${version}` : ""}…`);
    const doc = await client.extension(namespace, name, version);
    if (!doc) {
      if (isRoot)
        throw new InstallRefused(
          `${extensionId(namespace, name)}${version ? ` ${version}` : ""} is not in ${client.registry}.`,
        );
      missing.push(extensionId(namespace, name));
      visiting.delete(id);
      done.add(id);
      return;
    }
    await refuseByVerdict(client, doc, opts);
    opts.progress?.(`Downloading ${extensionId(doc.namespace, doc.name)} ${doc.version}…`);
    const vsix = await client.bytes(doc.files.download);
    const manifest = readVsixManifest(vsix);
    const signature = await checkSignature(client, doc, vsix, opts);
    if (opts.verifySignatures && signature.checked && !signature.ok)
      throw new InstallRefused(
        `${extensionId(doc.namespace, doc.name)} ${doc.version}: ${signature.reason}. Not installed.`,
      );
    for (const dep of [...manifest.extensionDependencies, ...manifest.extensionPack]) {
      const m = /^([^.]+)\.(.+)$/.exec(dep);
      if (!m) continue;
      await visit(m[1]!, m[2]!, undefined, false);
    }
    visiting.delete(id);
    done.add(id);
    items.push({ doc, vsix, manifest, signature });
  };

  await visit(root.namespace, root.name, root.version, true);
  return { items, missing };
}

async function refuseByVerdict(
  client: BatleHubClient,
  doc: ExtensionDoc,
  opts: InstallerOptions,
): Promise<void> {
  let state: string | null = null;
  try {
    state = verdictState(await client.verdict(doc.namespace, doc.name, doc.version));
  } catch (e) {
    log(
      `verdict for ${extensionId(doc.namespace, doc.name)} ${doc.version}: ${(e as Error).message}`,
    );
    return;
  }
  if (!state) return;
  const id = extensionId(doc.namespace, doc.name);
  if (state === "denied" || state === "quarantined")
    throw new InstallRefused(
      `${id} ${doc.version} is ${state} by the registry's supply-chain verdict. Not installed.`,
    );
  if (state === "warned") {
    const ok = opts.confirmWarned ? await opts.confirmWarned(id, doc.version) : true;
    if (!ok)
      throw new InstallRefused(
        `${id} ${doc.version} carries a warning verdict; install cancelled.`,
      );
  }
}

async function checkSignature(
  client: BatleHubClient,
  doc: ExtensionDoc,
  vsix: Uint8Array,
  opts: InstallerOptions,
): Promise<PlannedItem["signature"]> {
  if (!doc.files.signature)
    return { checked: false, ok: false, reason: "the entry carries no signature" };
  if (!opts.verifySignatures)
    return { checked: false, ok: false, reason: "verification is off (batlehub.verifySignatures)" };
  if (!doc.files.publicKey)
    // A relayed or provided signature (RFC 0020 §4.2, §13.6): the registry
    // vouches for it with no key of its own. The editor's verifier is the
    // one that can read it; this extension has nothing to check it against.
    return {
      checked: false,
      ok: false,
      reason: "the signature is an upstream's, with no registry key to verify it against",
    };
  const [archive, key] = await Promise.all([
    client.bytes(doc.files.signature),
    client.text(doc.files.publicKey),
  ]);
  const r = verifyVsixSignature(vsix, archive, key);
  return { checked: true, ok: r.ok, reason: r.reason };
}

/** Hand every planned VSIX to the editor, dependencies first; record the ledger. */
export async function applyPlan(
  plan: InstallPlan,
  client: BatleHubClient,
  ledger: Ledger,
  progress?: (m: string) => void,
): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "batlehub-vsx-"));
  const installed: string[] = [];
  try {
    for (const item of plan.items) {
      const id = extensionId(item.manifest.publisher, item.manifest.name);
      const file = path.join(dir, `${id}-${item.manifest.version}.vsix`);
      fs.writeFileSync(file, item.vsix);
      progress?.(`Installing ${id} ${item.manifest.version}…`);
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        vscode.Uri.file(file),
      );
      await ledger.set(id, {
        version: item.manifest.version,
        registry: client.registry,
        installedAt: new Date().toISOString(),
      });
      installed.push(id);
      log(
        `installed ${id} ${item.manifest.version} from ${client.registry} (${item.signature.checked ? item.signature.reason : "signature not checked: " + item.signature.reason})`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return installed;
}

export async function uninstall(id: string, ledger: Ledger): Promise<void> {
  await vscode.commands.executeCommand("workbench.extensions.uninstallExtension", id);
  await ledger.delete(id);
  log(`uninstalled ${id}`);
}

export function installedInEditor(id: string): boolean {
  return vscode.extensions.all.some((e) => e.id.toLowerCase() === id.toLowerCase());
}

export function installedVersion(id: string): string | null {
  const e = vscode.extensions.all.find((x) => x.id.toLowerCase() === id.toLowerCase());
  const v = (e?.packageJSON as { version?: string } | undefined)?.version;
  return typeof v === "string" ? v : null;
}

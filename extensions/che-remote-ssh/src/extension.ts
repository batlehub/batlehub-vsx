// Activation, and nothing else: the commands, the view, and the forwards
// that have to be stopped once nothing is using them.
//
// The rules live in the modules that import no `vscode` at all: discovery,
// oidc, kubeconfig, kubectl, sshconfig, sshfiles, ports, portforward, lease
// and exec. session.ts, connect.ts, view.ts and log.ts are the editor layer.
//
// This extension runs on the local machine in every window (it is `ui`), so
// it activates twice over one connection: once in the window that opened the
// tunnel and owns it, once in the remote window that uses it. The second one
// only takes a lease, which is how the first learns that the window is gone.
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { rm } from "node:fs/promises";
import * as vscode from "vscode";
import { connect, connectWithLink, pickWorkspace } from "./connect";
import { parseDevSpacesLink, summarizeLink, type DevSpacesLink } from "./devspaces-link";
import { reclaimable, readLeases, removeLease, writeLease } from "./lease";
import { forgetRecord, killRecord, readRecords, type ForwardRecord } from "./registry";
import { must } from "./exec";
import { hostOf } from "./instances";
import { contextsArgs, parseContexts } from "./kubectl";
import { channelOf, log } from "./log";
import { PortForwardPool, type ForwardProcess } from "./portforward";
import { freePort, waitForPort } from "./ports";
import { Session, SignInCancelled } from "./session";
import { WorkspaceItem, WorkspaceTree } from "./view";

const SSH_REMOTE = "ssh-remote+";
/** A lease is refreshed this often, and stays good for three refreshes. */
const LEASE_REFRESH_MS = 30_000;
const LEASE_TTL_MS = 90_000;
/**
 * How long a new forward waits before a lease is expected of it. It is long
 * because a remote window opens empty: until a folder is opened there, the
 * window cannot tell which host it is on, and takes no lease. Reclaiming a
 * tunnel someone is still using would drop their session, so the wait errs
 * towards leaving it up.
 */
const LEASE_GRACE_MS = 600_000;
const WATCHDOG_MS = 30_000;
/** Told once, then never again. */
const TOLD_ABOUT_CLOSING = "cheRemoteSsh.toldAboutClosing";

/** Removing the lease is the last thing the connected window does. */
let releaseLease: (() => Promise<void>) | undefined;

function guard(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (err) {
      // Cancelling is an answer, not a failure to report back.
      if (err instanceof SignInCancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      log(`command failed: ${message}`);
      void vscode.window.showErrorMessage(message);
    }
  };
}

/**
 * Which host this remote window is on. The editor's stable API says only
 * `ssh-remote`, never which one, so the authority is read off a remote
 * folder's URI. A window with nothing open yet cannot answer, which is why
 * the grace period above is generous.
 */
function authorityOf(): string | undefined {
  for (const candidate of [
    vscode.workspace.workspaceFolders?.[0]?.uri.authority,
    vscode.workspace.workspaceFile?.authority,
  ]) {
    if (candidate?.startsWith(SSH_REMOTE)) return candidate;
  }
  return undefined;
}

/**
 * Ask for a link and decode it. Returns undefined when the box is dismissed;
 * a link that is present but wrong is an error, and says which field is.
 */
async function askForLink(): Promise<DevSpacesLink | undefined> {
  const pasted = await vscode.window.showInputBox({
    title: "Che Remote SSH",
    prompt: "Paste the link from the Che dashboard",
    placeHolder: "vscode://redhat.devspaces-remote-ssh?namespace=…&podName=…&url=…",
    ignoreFocusOut: true,
    password: true,
    validateInput: (value) => {
      if (!value.trim()) return null;
      try {
        parseDevSpacesLink(value);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  });
  if (!pasted?.trim()) return undefined;
  return parseDevSpacesLink(pasted);
}

/** Show what a link says, in a document, with the key reduced to a fingerprint. */
async function showLink(link: DevSpacesLink): Promise<void> {
  const rows = summarizeLink(link);
  const width = Math.max(...rows.map(([label]) => label.length));
  const body = rows.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
  const document = await vscode.workspace.openTextDocument({
    content: `Che Remote SSH: what this link says\n\n${body}\n\nThe private key it carries is not shown; the fingerprint above identifies it.\n`,
    language: "plaintext",
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

const KEEP_CURRENT = "$(check) the context this file already selects";
const EVERY_INSTANCE = "$(globe) every Che, unless one says otherwise";
const ANOTHER_INSTANCE = "$(add) another Che…";

/**
 * Say, once, that this window is not holding the connection up.
 *
 * The tunnel is spawned detached and written to the registry precisely so
 * that it outlives the window that opened it, but nothing on screen says so,
 * and a window nobody dares close is the same nuisance as one that must stay.
 */
async function tellAboutClosing(
  context: vscode.ExtensionContext,
  workspace: string,
): Promise<void> {
  if (context.globalState.get<boolean>(TOLD_ABOUT_CLOSING)) return;
  const understood = "Got it, don't say it again";
  const choice = await vscode.window.showInformationMessage(
    `${workspace} is opening in its own window. The tunnel is held outside this one, so you can close this window without dropping the connection.`,
    understood,
  );
  if (choice === understood) await context.globalState.update(TOLD_ABOUT_CLOSING, true);
}

/** Which Che a kubeconfig is for. One editor, several clusters, one each. */
async function askWhichInstance(session: Session): Promise<string | undefined | "default"> {
  const known = session.knownInstances();
  const picked = await vscode.window.showQuickPick([...known, ANOTHER_INSTANCE, EVERY_INSTANCE], {
    title: "Which Che is this kubeconfig for?",
    ignoreFocusOut: true,
  });
  if (picked === undefined) return undefined;
  if (picked === EVERY_INSTANCE) return "default";
  if (picked !== ANOTHER_INSTANCE) return picked;
  const typed = await vscode.window.showInputBox({
    title: "Che Remote SSH",
    prompt: "The Che this kubeconfig reaches",
    placeHolder: "cde.example.dev",
    ignoreFocusOut: true,
  });
  const host = hostOf(typed ?? "");
  return host || undefined;
}

/**
 * Point the extension at a kubeconfig of the user's, from the interface
 * rather than from settings.json.
 *
 * The contexts are read by asking kubectl, which both lists them and proves
 * the file is one it can use. The choice is written to settings, so it is
 * visible and editable afterwards like anything else, and it can be written
 * against one Che rather than all of them: several instances mean several
 * clusters, and rarely one credential for both.
 */
async function useKubeconfig(session: Session): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: "Che Remote SSH: use an existing kubeconfig",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    defaultUri: vscode.Uri.file(path.join(homedir(), ".kube")),
    openLabel: "Use this kubeconfig",
  });
  const file = picked?.[0]?.fsPath;
  if (!file) return;

  const bin = session.effective.kubectlPath;
  const contexts = parseContexts(await must(session.run, bin, contextsArgs(file)));
  let context = "";
  if (contexts.length > 1) {
    const chosen = await vscode.window.showQuickPick([KEEP_CURRENT, ...contexts], {
      title: `Which context of ${path.basename(file)}?`,
      ignoreFocusOut: true,
    });
    if (chosen === undefined) return;
    context = chosen === KEEP_CURRENT ? "" : chosen;
  }

  const target = await askWhichInstance(session);
  if (target === undefined) return;

  const config = vscode.workspace.getConfiguration("cheRemoteSsh");
  if (target === "default") {
    await config.update("kubeconfig", file, vscode.ConfigurationTarget.Global);
    await config.update("context", context, vscode.ConfigurationTarget.Global);
  } else {
    await session.setInstanceKubeconfig(target, file, context);
    session.useInstance(target);
  }
  log(`using ${file}${context ? `, context ${context}` : ""} for ${target}`);

  await session.verify();
  const where = target === "default" ? "every Che" : target;
  void vscode.window.showInformationMessage(
    `The cluster answered. ${path.basename(file)} is what this extension uses for ${where}.`,
  );
}

/** Work against another Che, for the sidebar's listing and for connecting. */
async function switchInstance(session: Session): Promise<boolean> {
  const known = session.knownInstances();
  const picked = await vscode.window.showQuickPick([...known, ANOTHER_INSTANCE], {
    title: "Which Che should the sidebar show?",
    ignoreFocusOut: true,
  });
  if (picked === undefined) return false;
  if (picked !== ANOTHER_INSTANCE) {
    session.useInstance(picked);
    return true;
  }
  const typed = await vscode.window.showInputBox({
    title: "Che Remote SSH",
    prompt: "The Che to work against",
    placeHolder: "cde.example.dev",
    ignoreFocusOut: true,
  });
  const host = hostOf(typed ?? "");
  if (!host) return false;
  session.useInstance(host);
  return true;
}

/**
 * The connected window. It owns nothing and shows nothing: it holds a lease
 * so the window that opened the tunnel knows this one is still here.
 */
function activateGuest(context: vscode.ExtensionContext, session: Session): void {
  const dir = session.leaseDir;
  let held: string | undefined;
  const touch = async () => {
    const authority = authorityOf();
    if (!authority) return;
    if (held && held !== authority) await removeLease(dir, held);
    held = authority;
    await writeLease(dir, authority);
  };
  const tick = () => void touch().catch(() => undefined);
  tick();
  const timer = setInterval(tick, LEASE_REFRESH_MS);
  releaseLease = async () => {
    if (!held) return;
    await removeLease(dir, held).catch(() => undefined);
    // This window was the tunnel's only user. Closing it closes the tunnel,
    // rather than leaving it to the watchdog minutes later.
    for (const record of await readRecords(session.forwardDir).catch(() => [])) {
      if (record.authority !== held) continue;
      if (killRecord(record)) log(`closed the tunnel for ${held}`);
      await forgetRecord(session.forwardDir, held).catch(() => undefined);
    }
  };
  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    // A folder opened later is what finally tells this window where it is.
    vscode.workspace.onDidChangeWorkspaceFolders(tick),
  );
}

/** The window that opens connections, and owns every forward it opened. */
function activateOwner(context: vscode.ExtensionContext, session: Session): void {
  mkdirSync(session.storage, { recursive: true });
  const diagnosticsPath = path.join(session.storage, "forwards.log");
  const pool = new PortForwardPool({
    bin: () => session.effective.kubectlPath,
    spawn: (bin, args) => {
      // Detached, so the tunnel outlives this window; its output goes to a
      // file, because a pipe would break when this window closes.
      // Both streams go to the file: kubectl announces "Forwarding from …"
      // on stdout, and that line is what says a tunnel really came up.
      const output = openSync(diagnosticsPath, "a");
      const child = spawn(bin, args, {
        stdio: ["ignore", output, output],
        detached: true,
      });
      child.unref();
      return child as unknown as ForwardProcess;
    },
    freePort,
    waitReady: (port) => waitForPort(port, { timeoutMs: 15_000 }),
    log,
    diagnosticsPath,
  });
  const tree = new WorkspaceTree(session);
  const view = vscode.window.createTreeView("cheRemoteSsh.workspaces", {
    treeDataProvider: tree,
  });

  session.restoreInstance();
  const showActive = () => {
    view.description = session.activeInstance || undefined;
  };
  showActive();

  /** Close one tunnel for good, wherever it was started from. */
  const close = async (record: ForwardRecord) => {
    pool.stop(record.namespace, record.pod);
    killRecord(record);
    await forgetRecord(session.forwardDir, record.authority);
    await removeLease(session.leaseDir, record.authority);
    await session.forgetIdentity(record.pod);
  };

  /**
   * Stop the tunnels nothing uses any more, and forget the keys that went
   * with them.
   *
   * The list is read from the registry rather than from memory, so a tunnel
   * opened by a window that has since closed is reclaimed too: the forward
   * is detached on purpose, and this is what keeps that from leaking.
   */
  const reclaim = async () => {
    const records = await readRecords(session.forwardDir);
    if (records.length === 0) return;
    const leases = await readLeases(session.leaseDir);
    for (const record of reclaimable(records, leases, Date.now(), {
      ttlMs: LEASE_TTL_MS,
      graceMs: LEASE_GRACE_MS,
    })) {
      log(`no window is using ${record.authority} any more; closing its tunnel`);
      await close(record);
    }
  };

  const watchdog = setInterval(() => void reclaim().catch(() => undefined), WATCHDOG_MS);
  // Tunnels a previous window left behind are this window's to reclaim too.
  void reclaim().catch(() => undefined);

  context.subscriptions.push(
    view,
    tree,
    { dispose: () => clearInterval(watchdog) },
    vscode.commands.registerCommand(
      "cheRemoteSsh.signIn",
      guard(async () => {
        await session.deviceSignIn();
        await session.verify();
        const server = new URL(await session.apiServer()).hostname;
        void vscode.window.showInformationMessage(`Signed in to ${server}.`);
        tree.refresh();
      }),
    ),
    vscode.commands.registerCommand(
      "cheRemoteSsh.configure",
      guard(async () => {
        await session.verify();
        void vscode.window.showInformationMessage("The cluster accepted the credential.");
        tree.refresh();
      }),
    ),
    vscode.commands.registerCommand("cheRemoteSsh.connect", (item?: WorkspaceItem) =>
      guard(async () => {
        const workspace = item?.workspace ?? (await pickWorkspace(session));
        if (!workspace) return;
        await connect(session, pool, workspace);
        tree.refresh();
        await tellAboutClosing(context, workspace.name);
      })(),
    ),
    vscode.commands.registerCommand(
      "cheRemoteSsh.disconnect",
      guard(async () => {
        const records = await readRecords(session.forwardDir);
        for (const record of records) await close(record);
        void vscode.window.showInformationMessage(
          records.length === 1
            ? "The tunnel has been closed."
            : `${records.length} tunnels closed.`,
        );
      }),
    ),
    vscode.commands.registerCommand(
      "cheRemoteSsh.connectFromLink",
      guard(async () => {
        const link = await askForLink();
        if (!link) return;
        await connectWithLink(session, pool, link);
        showActive();
        tree.refresh();
        await tellAboutClosing(context, link.dwName);
      }),
    ),
    vscode.commands.registerCommand(
      "cheRemoteSsh.inspectLink",
      guard(async () => {
        const link = await askForLink();
        if (link) await showLink(link);
      }),
    ),
    // A link can be routed here once its extension id is this one; pasting
    // works either way, since Red Hat's id can never resolve to us.
    vscode.window.registerUriHandler({
      handleUri: (uri) =>
        void guard(async () => {
          const link = parseDevSpacesLink(uri.toString(true));
          const connectIt = "Connect";
          const choice = await vscode.window.showInformationMessage(
            `Connect to ${link.dwName} on ${new URL(link.cheUrl).hostname}?`,
            {
              modal: true,
              detail: summarizeLink(link)
                .map(([l, v]) => `${l}: ${v}`)
                .join("\n"),
            },
            connectIt,
          );
          if (choice !== connectIt) return;
          await connectWithLink(session, pool, link);
          tree.refresh();
          await tellAboutClosing(context, link.dwName);
        })(),
    }),
    vscode.commands.registerCommand(
      "cheRemoteSsh.useKubeconfig",
      guard(async () => {
        await useKubeconfig(session);
        tree.refresh();
      }),
    ),
    vscode.commands.registerCommand(
      "cheRemoteSsh.switchInstance",
      guard(async () => {
        if (await switchInstance(session)) {
          showActive();
          tree.refresh();
        }
      }),
    ),
    vscode.commands.registerCommand("cheRemoteSsh.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "cheRemoteSsh"),
    ),
    vscode.commands.registerCommand("cheRemoteSsh.refresh", () => tree.refresh()),
    vscode.commands.registerCommand(
      "cheRemoteSsh.signOut",
      guard(async () => {
        for (const record of await readRecords(session.forwardDir)) await close(record);
        pool.dispose();
        await session.signOut();
        // A kubeconfig we were merely pointed at belongs to the user.
        if (session.authenticates) await rm(session.ownKubeconfigPath, { force: true });
        await rm(session.identityDir, { recursive: true, force: true });
        await rm(session.leaseDir, { recursive: true, force: true });
        await rm(session.forwardDir, { recursive: true, force: true });
        void vscode.window.showInformationMessage(
          session.authenticates
            ? "Signed out; the kubeconfig and the workspace keys have been removed."
            : "The workspace keys have been removed; your kubeconfig was left alone.",
        );
        tree.refresh();
      }),
    ),
    vscode.commands.registerCommand("cheRemoteSsh.showLog", () => channelOf().show()),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const session = new Session(context);
  if (vscode.env.remoteName === "ssh-remote") {
    activateGuest(context, session);
    return;
  }
  activateOwner(context, session);
}

export async function deactivate(): Promise<void> {
  // The pool goes through the subscriptions. The lease has to be dropped
  // here: it is the signal that this window is no longer using its forward.
  await releaseLease?.();
  releaseLease = undefined;
}

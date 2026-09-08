// The connection itself, in the order it has to happen: find the running
// pod, read the key the workspace generated for it, hold a forward open,
// write the SSH entry, then hand the host to Remote SSH.
//
// Every step that decides something lives in a module that knows nothing of
// the editor. What is here is the sequence, the progress it reports, and the
// window it opens at the end.
import * as vscode from "vscode";
import { userNamespaces } from "./che";
import { must } from "./exec";
import {
  containerOrder,
  devWorkspacesAllArgs,
  devWorkspacesArgs,
  ensureSshdArgs,
  parseDevWorkspaces,
  parsePods,
  podsArgs,
  portForwardArgs,
  readKeyArgs,
  readUserArgs,
  runningPodOf,
  type DevWorkspace,
} from "./kubectl";
import { log } from "./log";
import type { PortForwardPool } from "./portforward";
import type { Session } from "./session";
import { installEntries } from "./sshfiles";
import type { DevSpacesLink } from "./devspaces-link";
import { hostOf } from "./instances";
import { writeRecord } from "./registry";
import type { HostEntry } from "./sshconfig";

export class NotRunning extends Error {
  constructor(readonly workspace: string) {
    super(`The workspace "${workspace}" has no running pod. Start it from the Che dashboard.`);
  }
}

/**
 * The DevWorkspaces to offer, found by whichever route the credential allows.
 *
 * A configured namespace is read directly. Otherwise, when this extension
 * holds the credential, Che is asked which namespaces are the user's: listing
 * them cluster-wide is refused to an ordinary user, and Che already knows the
 * answer. When the extension was pointed at a kubeconfig of the user's, there
 * is no Che token to ask with, so the cluster is listed at once, which that
 * kind of credential is usually allowed to do.
 */
export async function listWorkspaces(session: Session): Promise<DevWorkspace[]> {
  await session.kubeconfig();
  const ctx = session.kubectl();
  const configured = session.effective.namespace;

  if (configured) return readNamespace(session, configured);

  if (!session.authenticates) {
    try {
      return parseDevWorkspaces(await must(session.run, ctx.bin, devWorkspacesAllArgs(ctx)));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        "This kubeconfig cannot list DevWorkspaces across the cluster. Name the namespace " +
          `in the "cheRemoteSsh.namespace" setting. (${detail})`,
      );
    }
  }

  const che = await session.che();
  const token = await session.token();
  const namespaces = await userNamespaces(che, token, { log });
  const found: DevWorkspace[] = [];
  for (const ns of namespaces) {
    found.push(...(await readNamespace(session, ns.name)));
  }
  return found;
}

/** One namespace, whose failure is logged rather than hiding every other. */
async function readNamespace(session: Session, namespace: string): Promise<DevWorkspace[]> {
  const ctx = session.kubectl();
  try {
    const json = await must(session.run, ctx.bin, devWorkspacesArgs(ctx, namespace));
    return parseDevWorkspaces(json).map((w) => ({ ...w, namespace: w.namespace || namespace }));
  } catch (err) {
    log(`${namespace}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** The workspace to connect to, chosen by the user when more than one runs. */
export async function pickWorkspace(session: Session): Promise<DevWorkspace | undefined> {
  const workspaces = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Listing your workspaces…" },
    () => listWorkspaces(session),
  );
  if (workspaces.length === 0) {
    void vscode.window.showInformationMessage("Che reports no workspace in your namespaces.");
    return undefined;
  }
  const running = workspaces.filter((w) => w.phase === "Running");
  if (running.length === 1) return running[0];
  const picked = await vscode.window.showQuickPick(
    workspaces.map((w) => ({
      label: w.name,
      description: w.phase ?? "unknown",
      detail: w.namespace,
      workspace: w,
    })),
    { title: "Connect to a Che workspace", ignoreFocusOut: true },
  );
  return picked?.workspace;
}

interface Resolved {
  pod: string;
  container: string;
  user: string;
  key: string;
}

/**
 * The pod, a container of it that carries the workspace's key, and what that
 * key logs in as.
 *
 * The container is found by trying, not by reading the DevWorkspace: a
 * workspace assembled from a parent devfile and editor contributions has no
 * components in its own spec, so the pod is the only place that says what
 * runs. `/sshd` is a volume shared across the pod, so the first container
 * that answers is as good as any other.
 */
async function resolve(session: Session, workspace: DevWorkspace): Promise<Resolved> {
  const ctx = session.kubectl();
  const podsJson = await must(
    session.run,
    ctx.bin,
    podsArgs(ctx, workspace.namespace, workspace.name),
  );
  const pod = runningPodOf(parsePods(podsJson), workspace.name);
  if (!pod) throw new NotRunning(workspace.name);
  if (pod.containers.length === 0) {
    throw new Error(`The pod ${pod.name} declares no container.`);
  }

  const refusals: string[] = [];
  for (const container of containerOrder(pod.containers)) {
    const attempt = await session.run(
      ctx.bin,
      readKeyArgs(ctx, workspace.namespace, pod.name, container),
    );
    if (attempt.code !== 0 || !attempt.stdout.includes("PRIVATE KEY")) {
      refusals.push(`${container}: ${attempt.stderr.trim().slice(0, 120) || "no key there"}`);
      continue;
    }
    const user = (
      await must(session.run, ctx.bin, readUserArgs(ctx, workspace.namespace, pod.name, container))
    ).trim();
    log(`read the workspace key from ${pod.name}/${container}`);
    return { pod: pod.name, container, user: user || "user", key: attempt.stdout };
  }

  throw new Error(
    `No SSH key was found in ${pod.name}. The workspace needs an sshd component to be ` +
      `reachable this way. Tried: ${refusals.join("; ")}`,
  );
}

/**
 * Make sure sshd answers in the pod before a forward is pointed at it.
 *
 * A forward onto a dead port is the worst failure this extension has: it
 * binds, the connection is handed to Remote SSH, and only then does kubectl
 * die, so what the user is shown is a refused connection to a port that
 * existed a second ago. Asking the pod first turns that into one sentence.
 *
 * Only on the path that already ran an exec to read the key. The link path
 * deliberately runs none, and is left alone.
 */
async function ensureSshd(
  session: Session,
  namespace: string,
  pod: string,
  container: string,
): Promise<void> {
  const ctx = session.kubectl();
  const result = await session.run(ctx.bin, ensureSshdArgs(ctx, namespace, pod, container), 60_000);
  const said = result.stdout.trim() || result.stderr.trim();
  if (result.code !== 0) {
    throw new Error(`sshd is not answering in ${pod}: ${said || `kubectl exited ${result.code}`}`);
  }
  log(said === "up" ? `sshd is listening in ${pod}` : `started sshd in ${pod}`);
}

/**
 * Open the tunnel for this workspace, or reuse the one already open.
 *
 * A forward outlives the window that started it, so one may already be up:
 * started by this window earlier, or by a window since closed. Reusing it
 * avoids a second forward onto the same pod, and is what makes reconnecting
 * after closing the opener work at all.
 */
async function openTunnel(
  session: Session,
  pool: PortForwardPool,
  authority: string,
  namespace: string,
  pod: string,
  args: (localPort: number) => string[],
): Promise<number> {
  const live = await session.liveForward(authority);
  if (live) {
    log(`reusing the tunnel already open on 127.0.0.1:${live.port}`);
    return live.port;
  }
  const port = await pool.ensure({ namespace, pod, args });
  const pid = pool.get(namespace, pod)?.pid;
  if (pid === undefined) {
    log("the forward reported no pid; it cannot be reclaimed by another window");
  } else {
    await writeRecord(session.forwardDir, {
      authority,
      namespace,
      pod,
      port,
      pid,
      since: Date.now(),
    });
  }
  return port;
}

/** What the opener has to remember in order to reclaim the forward later. */
export interface Connection {
  authority: string;
  namespace: string;
  pod: string;
}

/**
 * Connect, and leave the forward running for the window that opens. The host
 * is named after the DevWorkspace, so reconnecting later finds the same entry.
 *
 * The returned handle is what lets the opener stop the forward once that
 * window has gone: it owns the tunnel, and the editor gives it no event when
 * the window using it closes.
 */
export async function connect(
  session: Session,
  pool: PortForwardPool,
  workspace: DevWorkspace,
  openInNewWindow = true,
): Promise<Connection> {
  await session.kubeconfig();
  const ctx = session.kubectl();

  const resolved = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to ${workspace.name}…`,
    },
    async (progress) => {
      progress.report({ message: "finding the running pod" });
      const r = await resolve(session, workspace);

      progress.report({ message: "checking sshd in the workspace" });
      await ensureSshd(session, workspace.namespace, r.pod, r.container);

      progress.report({ message: "opening the port-forward" });
      const port = await openTunnel(
        session,
        pool,
        `ssh-remote+${workspace.name}`,
        workspace.namespace,
        r.pod,
        (localPort) => portForwardArgs(ctx, workspace.namespace, r.pod, localPort),
      );

      progress.report({ message: "writing the SSH configuration" });
      const identityFile = await session.writeIdentity(r.pod, r.key);
      const entry: HostEntry = {
        host: workspace.name,
        port,
        user: r.user,
        identityFile,
      };
      const installed = await installEntries(session.sshDir, session.managedSshConfig, [entry]);
      if (installed.includeAdded) log(`added an Include to ${session.sshDir}/config`);
      if (installed.pubkeyDisabledSomewhere) {
        log(
          "note: this ssh config disables public key authentication in a Host block; " +
            "our include is placed above it, which is what makes the entry work",
        );
      }
      return { ...r, port };
    },
  );

  const authority = `ssh-remote+${workspace.name}`;
  log(`connecting to ${workspace.name} on 127.0.0.1:${resolved.port} as ${resolved.user}`);
  await vscode.commands.executeCommand("vscode.newWindow", {
    remoteAuthority: authority,
    reuseWindow: !openInNewWindow,
  });
  return { authority, namespace: workspace.namespace, pod: resolved.pod };
}

/**
 * Connect from a link the Che dashboard produced.
 *
 * The link already names the pod, the account and the key, so none of the
 * three calls `resolve` makes are needed: no listing, no exec, no reading of
 * the DevWorkspace. Only the tunnel still needs the cluster, and which
 * credential opens it is decided by the instance the link names.
 */
export async function connectWithLink(
  session: Session,
  pool: PortForwardPool,
  link: DevSpacesLink,
  openInNewWindow = true,
): Promise<Connection> {
  session.useInstance(hostOf(link.cheUrl));
  await session.kubeconfig();
  const ctx = session.kubectl();

  const port = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to ${link.dwName}…`,
    },
    async (progress) => {
      progress.report({ message: "opening the port-forward" });
      const assigned = await openTunnel(
        session,
        pool,
        `ssh-remote+${link.dwName}`,
        link.namespace,
        link.podName,
        (localPort) => portForwardArgs(ctx, link.namespace, link.podName, localPort),
      );

      progress.report({ message: "writing the SSH configuration" });
      const identityFile = await session.writeIdentity(link.podName, link.key);
      const entry: HostEntry = {
        host: link.dwName,
        port: assigned,
        user: link.userName,
        identityFile,
      };
      const installed = await installEntries(session.sshDir, session.managedSshConfig, [entry]);
      if (installed.includeAdded) log(`added an Include to ${session.sshDir}/config`);
      if (installed.pubkeyDisabledSomewhere) {
        log(
          "note: this ssh config disables public key authentication in a Host block; " +
            "our include is placed above it, which is what makes the entry work",
        );
      }
      return assigned;
    },
  );

  const authority = `ssh-remote+${link.dwName}`;
  log(`connecting to ${link.dwName} on 127.0.0.1:${port} as ${link.userName}`);
  await vscode.commands.executeCommand("vscode.newWindow", {
    remoteAuthority: authority,
    reuseWindow: !openInNewWindow,
  });
  return { authority, namespace: link.namespace, pod: link.podName };
}

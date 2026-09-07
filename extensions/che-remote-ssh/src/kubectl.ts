// Every kubectl this extension runs, as argument vectors.
//
// The first two arguments are always `--kubeconfig <our file>`. That is the
// whole reason this module builds argv instead of command strings: there is
// no path through it that can reach the user's default kubeconfig, and no
// shell that could reinterpret a namespace or a pod name.
//
// Only the standard API is used. Red Hat's extension reaches for OpenShift's
// Project API here, which is what confines it to OpenShift; DevWorkspaces
// and Pods are the same objects on any cluster running the operator.

export const DEVWORKSPACE_NAME_LABEL = "controller.devfile.io/devworkspace_name";

export interface KubectlContext {
  /** The binary, from settings. */
  bin: string;
  /** The kubeconfig: this extension's own, or the one it was pointed at. */
  kubeconfig: string;
  /** A context to select inside it, when the user named one. */
  context?: string;
}

export interface DevWorkspace {
  name: string;
  namespace: string;
  /** `status.devworkspaceId`, the id the SSH host entry is named after. */
  id?: string;
  phase?: string;
  mainUrl?: string;
}

export interface WorkspacePod {
  name: string;
  namespace: string;
  /** The DevWorkspace this pod belongs to, from its label. */
  devworkspace?: string;
  phase?: string;
  /**
   * The containers, in the order the pod declares them. This is the only
   * honest source: a DevWorkspace built from a `parent` devfile and editor
   * `contributions` has an empty `spec.template.components`, so reading the
   * DevWorkspace tells you nothing about what actually runs.
   */
  containers: string[];
}

function base(ctx: KubectlContext): string[] {
  const args = ["--kubeconfig", ctx.kubeconfig];
  if (ctx.context) args.push("--context", ctx.context);
  return args;
}

export function versionArgs(ctx: KubectlContext): string[] {
  return [...base(ctx), "version", "-o", "json"];
}

export function devWorkspacesArgs(ctx: KubectlContext, namespace: string): string[] {
  return [...base(ctx), "get", "devworkspaces", "-n", namespace, "-o", "json"];
}

/**
 * Every DevWorkspace on the cluster. Only reachable with a credential allowed
 * to list them cluster-wide, which is the case an explicit kubeconfig covers
 * and the OIDC path does not: there, Che says which namespaces are the
 * user's, and they are read one by one.
 */
export function devWorkspacesAllArgs(ctx: KubectlContext): string[] {
  return [...base(ctx), "get", "devworkspaces", "-A", "-o", "json"];
}

export function podsArgs(ctx: KubectlContext, namespace: string, devworkspace?: string): string[] {
  const args = [...base(ctx), "get", "pods", "-n", namespace, "-o", "json"];
  if (devworkspace) args.push("-l", `${DEVWORKSPACE_NAME_LABEL}=${devworkspace}`);
  return args;
}

/**
 * The long-running one. `localPort:2022` is the sshd the DevWorkspace
 * exposes; binding to loopback is explicit so the forward is never reachable
 * from outside this machine.
 */
export function portForwardArgs(
  ctx: KubectlContext,
  namespace: string,
  pod: string,
  localPort: number,
  remotePort = 2022,
): string[] {
  return [
    ...base(ctx),
    "port-forward",
    "-n",
    namespace,
    `pod/${pod}`,
    `${localPort}:${remotePort}`,
    "--address",
    "127.0.0.1",
  ];
}

/** The private key the workspace generated, read out of the running container. */
export function readKeyArgs(
  ctx: KubectlContext,
  namespace: string,
  pod: string,
  container: string,
): string[] {
  return [
    ...base(ctx),
    "exec",
    "-n",
    namespace,
    `pod/${pod}`,
    "-c",
    container,
    "--",
    "/bin/sh",
    "-c",
    "[ -e /etc/ssh/dwo_ssh_key ] && cat /etc/ssh/dwo_ssh_key || cat /sshd/ssh_client_*key",
  ];
}

export function readUserArgs(
  ctx: KubectlContext,
  namespace: string,
  pod: string,
  container: string,
): string[] {
  return [
    ...base(ctx),
    "exec",
    "-n",
    namespace,
    `pod/${pod}`,
    "-c",
    container,
    "--",
    "/bin/sh",
    "-c",
    "cat /sshd/username 2>/dev/null || id -un",
  ];
}

function items(json: string): Record<string, unknown>[] {
  const doc: unknown = JSON.parse(json);
  if (typeof doc !== "object" || doc === null) return [];
  const list = (doc as Record<string, unknown>).items;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

export function parseDevWorkspaces(json: string): DevWorkspace[] {
  const out: DevWorkspace[] = [];
  for (const item of items(json)) {
    const meta = record(item.metadata);
    const status = record(item.status);
    const name = str(meta.name);
    if (!name) continue;
    out.push({
      name,
      namespace: str(meta.namespace) ?? "",
      ...(str(status.devworkspaceId) ? { id: str(status.devworkspaceId)! } : {}),
      ...(str(status.phase) ? { phase: str(status.phase)! } : {}),
      ...(str(status.mainUrl) ? { mainUrl: str(status.mainUrl)! } : {}),
    });
  }
  return out;
}

function containersOf(item: Record<string, unknown>): string[] {
  const list = record(item.spec).containers;
  if (!Array.isArray(list)) return [];
  return list.map((c) => str(record(c).name)).filter((n): n is string => n !== undefined);
}

/**
 * The order to try containers in when looking for the workspace's key. The
 * `/sshd` directory is a volume shared across the pod, so more than one
 * container can serve it; the gateway is put last because it is a proxy
 * sidecar and the least likely to carry anything of the workspace.
 */
export function containerOrder(containers: string[]): string[] {
  const infrastructure = (name: string) => /gateway/i.test(name);
  return [...containers.filter((c) => !infrastructure(c)), ...containers.filter(infrastructure)];
}

export function parsePods(json: string): WorkspacePod[] {
  const out: WorkspacePod[] = [];
  for (const item of items(json)) {
    const meta = record(item.metadata);
    const labels = record(meta.labels);
    const name = str(meta.name);
    if (!name) continue;
    out.push({
      name,
      namespace: str(meta.namespace) ?? "",
      ...(str(labels[DEVWORKSPACE_NAME_LABEL])
        ? { devworkspace: str(labels[DEVWORKSPACE_NAME_LABEL])! }
        : {}),
      ...(str(record(item.status).phase) ? { phase: str(record(item.status).phase)! } : {}),
      containers: containersOf(item),
    });
  }
  return out;
}

/** The one running pod of a DevWorkspace, or null while it is starting. */
export function runningPodOf(pods: WorkspacePod[], devworkspace: string): WorkspacePod | null {
  return pods.find((p) => p.devworkspace === devworkspace && p.phase === "Running") ?? null;
}

/**
 * The contexts a kubeconfig declares. Asked of kubectl rather than parsed
 * here: the file is YAML, kubectl already reads it, and a file it cannot
 * read is one this extension could not have used either.
 *
 * No `--context` is passed, on purpose: the point of the call is to find out
 * which ones exist, and a stale setting must not make it fail.
 */
export function contextsArgs(kubeconfig: string): string[] {
  return ["--kubeconfig", kubeconfig, "config", "get-contexts", "-o", "name"];
}

export function parseContexts(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

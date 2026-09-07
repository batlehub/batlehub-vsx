// The kubeconfig this extension owns.
//
// By default it is never `~/.kube/config`. The file lives in the extension's
// own storage and every kubectl invocation names it with `--kubeconfig`, so a
// user who keeps an empty default kubeconfig keeps one, `KUBECONFIG` is
// left alone, and uninstalling the extension takes the credential with it.
//
// A kubeconfig can also be pointed at explicitly, for a cluster this
// extension has no business authenticating to: client certificates, a
// service account token, an exec plugin. That file is then used as it is and
// never written to. It is opt-in by path: no setting makes the default
// kubeconfig get picked up on its own.
//
// It is written as JSON. kubectl parses its kubeconfig as YAML, of which
// JSON is a subset, so this buys correct quoting of servers, paths and
// tokens without a YAML serialiser in the bundle.
//
// What goes in it is a short-lived id_token and nothing else. The client
// secret and the refresh token stay in the editor's SecretStorage: an exec
// credential plugin would have had to carry the secret in its arguments,
// in clear, in this very file.
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

export interface ClusterSpec {
  /** e.g. `https://che.example.dev:6443` */
  server: string;
  /** PEM bundle path. Preferred over skipping verification. */
  certificateAuthority?: string;
  insecureSkipTlsVerify?: boolean;
}

export interface KubeconfigSpec extends ClusterSpec {
  /** The id_token the apiserver authenticates. */
  token: string;
  namespace?: string;
  /** Named after the Che host, so a log line says which instance this is. */
  name?: string;
}

/** The shape kubectl reads, as far as this extension writes it. */
export interface Kubeconfig {
  apiVersion: "v1";
  kind: "Config";
  clusters: { name: string; cluster: Record<string, unknown> }[];
  users: { name: string; user: Record<string, unknown> }[];
  contexts: { name: string; context: Record<string, unknown> }[];
  "current-context": string;
  preferences: Record<string, never>;
}

export interface KubeconfigChoice {
  /** The file every kubectl call will be given. */
  file: string;
  /** True when this extension wrote it, and may therefore delete it. */
  owned: boolean;
  /** The context to select, only meaningful in a file we did not write. */
  context?: string;
}

/**
 * Expand a leading `~`, which is what a user types and what kubectl itself
 * would never expand: the shell does that, and there is no shell here.
 */
export function expandHome(file: string, home: string): string {
  const trimmed = file.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}

/**
 * Which kubeconfig to use. A configured path wins and is left alone; without
 * one, this extension writes and owns its file. A context name only applies
 * to a file we did not write, since the one we write holds a single context.
 */
export function chooseKubeconfig(opts: {
  configured: string;
  context: string;
  ownFile: string;
  home: string;
}): KubeconfigChoice {
  const configured = opts.configured.trim();
  if (!configured) return { file: opts.ownFile, owned: true };
  const context = opts.context.trim();
  return {
    file: expandHome(configured, opts.home),
    owned: false,
    ...(context ? { context } : {}),
  };
}

/** A context name kubectl accepts, derived from the Che host. */
export function contextNameOf(server: string): string {
  let host: string;
  try {
    host = new URL(server).hostname;
  } catch {
    host = server;
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `che-${slug || "cluster"}`;
}

export function buildKubeconfig(spec: KubeconfigSpec): Kubeconfig {
  const name = spec.name ?? contextNameOf(spec.server);
  const cluster: Record<string, unknown> = { server: spec.server };
  // A CA and a skip are mutually exclusive; kubectl refuses a config holding
  // both, so the CA wins when one is configured.
  if (spec.certificateAuthority) {
    cluster["certificate-authority"] = spec.certificateAuthority;
  } else if (spec.insecureSkipTlsVerify) {
    cluster["insecure-skip-tls-verify"] = true;
  }
  const context: Record<string, unknown> = { cluster: name, user: name };
  if (spec.namespace) context.namespace = spec.namespace;
  return {
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name, cluster }],
    users: [{ name, user: { token: spec.token } }],
    contexts: [{ name, context }],
    "current-context": name,
    preferences: {},
  };
}

export function renderKubeconfig(spec: KubeconfigSpec): string {
  return `${JSON.stringify(buildKubeconfig(spec), null, 2)}\n`;
}

/**
 * Write the file with only the owner able to read it. The write goes to a
 * temporary name and is renamed over the target, so a kubectl that starts
 * mid-write never reads half a token; the mode is set before the rename for
 * the same reason.
 */
export async function writeKubeconfig(file: string, spec: KubeconfigSpec): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, renderKubeconfig(spec), { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

// The link the Che dashboard hands out.
//
//   vscode://redhat.devspaces-remote-ssh?namespace=…&podName=…&userName=…
//            &dwName=…&key=<base64>&url=<che>
//
// It is worth taking seriously, because it already carries what would
// otherwise cost three calls to the cluster: the pod, the account to log in
// as, and the workspace's private key. Only the tunnel still needs the API.
//
// The extension id in that link is Red Hat's, and an id cannot be claimed by
// anyone else, so the editor will never route it here. Pasting it does, which
// is why this parses a string rather than a `vscode.Uri`: the same text works
// whether it arrives from the clipboard or from a URI handler.
//
// Everything is validated before use. The parameters name a namespace, a pod
// and an account that will be put in a command line and in an ssh_config, so
// each is held to the shape Kubernetes and OpenSSH accept.
import { describeKeySafely } from "./sshkey";

/** https://kubernetes.io/docs/concepts/overview/working-with-objects/names/ */
const KUBE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** Che allows a little more in a DevWorkspace name than Kubernetes does. */
const DW_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const USER_NAME = /^[a-zA-Z0-9_.-]+$/;

export interface DevSpacesLink {
  namespace: string;
  podName: string;
  userName: string;
  /** The DevWorkspace, and the name the SSH host entry takes. */
  dwName: string;
  /** The private key, decoded. */
  key: string;
  /** The Che instance, without a trailing slash. */
  cheUrl: string;
}

export class LinkError extends Error {}

/** The query of a pasted link, however much of the URI came with it. */
function queryOf(input: string): URLSearchParams {
  const text = input.trim();
  if (!text) throw new LinkError("nothing was pasted");
  const at = text.indexOf("?");
  if (at >= 0) return new URLSearchParams(text.slice(at + 1));
  // A bare query, which is what survives some copy-paste routes.
  if (text.includes("=")) return new URLSearchParams(text);
  throw new LinkError("this does not look like a Dev Spaces link");
}

function required(params: URLSearchParams, name: string): string {
  const value = params.get(name);
  if (value === null || value === "") throw new LinkError(`the link carries no ${name}`);
  return value;
}

function checked(value: string, pattern: RegExp, name: string): string {
  if (!pattern.test(value)) throw new LinkError(`${name} is not a valid name: ${value}`);
  return value;
}

/**
 * Decode the key. It arrives base64-encoded, and what comes out has to be a
 * private key: anything else means the link was mangled in transit, and is
 * refused here rather than written to disk and handed to ssh.
 */
export function decodeKey(encoded: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    throw new LinkError("the key in the link is not valid base64");
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(decoded)) {
    throw new LinkError("the key in the link did not decode to a private key");
  }
  return decoded.endsWith("\n") ? decoded : `${decoded}\n`;
}

function cheUrlOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LinkError(`the link's url is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LinkError(`the link's url is not http(s): ${raw}`);
  }
  return url.toString().replace(/\/+$/, "");
}

/** Parse a pasted Dev Spaces link, or say precisely what is wrong with it. */
export function parseDevSpacesLink(input: string): DevSpacesLink {
  const params = queryOf(input);
  return {
    namespace: checked(required(params, "namespace"), KUBE_NAME, "namespace"),
    podName: checked(required(params, "podName"), KUBE_NAME, "podName"),
    userName: checked(required(params, "userName"), USER_NAME, "userName"),
    dwName: checked(required(params, "dwName"), DW_NAME, "dwName"),
    key: decodeKey(required(params, "key")),
    cheUrl: cheUrlOf(required(params, "url")),
  };
}

/**
 * The link, said out loud. The key is never one of the rows: what identifies
 * it is its fingerprint, which is what `ssh-keygen -l` would print and what
 * can be compared against the workspace without revealing anything.
 */
export function summarizeLink(link: DevSpacesLink): [string, string][] {
  const described = describeKeySafely(link.key);
  const key =
    "error" in described
      ? `unreadable (${described.error})`
      : `${described.type}, ${described.fingerprint}${described.encrypted ? ", passphrase-protected" : ""}`;
  return [
    ["Che instance", link.cheUrl],
    ["Workspace", link.dwName],
    ["Namespace", link.namespace],
    ["Pod", link.podName],
    ["Account", link.userName],
    ["Key", key],
    ["SSH host it becomes", link.dwName],
  ];
}

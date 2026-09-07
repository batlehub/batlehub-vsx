// The SSH client configuration, and the one rule that decides whether any of
// this works.
//
// ssh_config keeps the FIRST value obtained for each keyword, not the last.
// A `Host *` block near the top of ~/.ssh/config therefore wins over every
// block below it, and a config that opens with
//
//     Host *
//         PubkeyAuthentication no
//
// disables key authentication for every host in the file, whatever those
// hosts declare afterwards. Appending our entry at the end, as Red Hat's
// extension does, produces a host that looks right and cannot authenticate.
//
// So two things are done here that the upstream extension does not do: our
// `Include` is inserted ahead of the first `Host` or `Match` line rather than
// appended, and the generated entry states `PubkeyAuthentication yes`
// explicitly instead of relying on the default.

export interface HostEntry {
  /** The name Remote SSH connects to; the DevWorkspace id. */
  host: string;
  port: number;
  user: string;
  identityFile: string;
  hostName?: string;
}

/** ssh_config quotes with double quotes; a path holding one cannot be used. */
export function quote(value: string): string {
  if (!/[\s"]/.test(value)) return value;
  if (value.includes('"')) {
    throw new Error(`a double quote in an ssh_config value cannot be escaped: ${value}`);
  }
  return `"${value}"`;
}

export const BEGIN = "# --- che-remote-ssh: managed, do not edit ---";
export const END = "# --- che-remote-ssh: end ---";

/**
 * The entry for one workspace. The forward is on loopback, and the host key
 * changes every time the pod restarts, so the known_hosts checks are turned
 * off for this host alone rather than trusting a key that is meaningless.
 */
export function hostBlock(entry: HostEntry, platform: NodeJS.Platform = process.platform): string {
  const nullDevice = platform === "win32" ? "nul" : "/dev/null";
  return [
    `Host ${entry.host}`,
    `  HostName ${entry.hostName ?? "127.0.0.1"}`,
    `  Port ${entry.port}`,
    `  User ${entry.user}`,
    `  IdentityFile ${quote(entry.identityFile)}`,
    "  IdentitiesOnly yes",
    "  PubkeyAuthentication yes",
    `  UserKnownHostsFile ${nullDevice}`,
    "  StrictHostKeyChecking no",
    "",
  ].join("\n");
}

/** The file this extension owns, rewritten whole on every change. */
export function renderManagedConfig(entries: HostEntry[], platform?: NodeJS.Platform): string {
  const body = entries.map((e) => hostBlock(e, platform)).join("\n");
  return `${BEGIN}\n${body}${END}\n`;
}

function isHostOrMatch(line: string): boolean {
  return /^\s*(host|match)\b/i.test(line);
}

function includesAlready(lines: string[], includePath: string): boolean {
  const needle = includePath.replace(/^"|"$/g, "");
  return lines.some((l) => /^\s*include\b/i.test(l) && l.includes(needle));
}

/**
 * Put `Include <path>` at the top of ~/.ssh/config, above the first `Host` or
 * `Match` block. Leading comments and global options keep their place: only
 * the first block boundary matters, because that is where the file starts
 * fixing values we would otherwise be unable to override.
 *
 * Returns the text unchanged when the include is already there, so this is
 * safe to run on every activation.
 */
export function ensureIncluded(
  configText: string,
  includePath: string,
): { text: string; changed: boolean } {
  const lines = configText.split("\n");
  if (includesAlready(lines, includePath)) return { text: configText, changed: false };
  const directive = `Include ${quote(includePath)}`;
  const at = lines.findIndex(isHostOrMatch);
  if (at < 0) {
    const sep = configText.length === 0 || configText.endsWith("\n") ? "" : "\n";
    return { text: `${configText}${sep}${directive}\n`, changed: true };
  }
  lines.splice(at, 0, directive, "");
  return { text: lines.join("\n"), changed: true };
}

/**
 * Does a `Host *` block ahead of our include disable key authentication? The
 * include is placed above it, so this only ever reports a file we have not
 * been able to fix, but the answer belongs in the log when a connection is
 * refused for no visible reason.
 */
export function findsPubkeyDisabled(configText: string): boolean {
  for (const line of configText.split("\n")) {
    if (/^\s*pubkeyauthentication\s+no\b/i.test(line)) return true;
  }
  return false;
}

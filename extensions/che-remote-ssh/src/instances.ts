// One editor, several Che instances, one kubeconfig each.
//
// A link names its instance, and every instance is reached with its own
// credential: the lab cluster by certificate, the shared one by OIDC. So the
// settings that describe how to reach a cluster can be given per host, and
// what is set at the top level is what an unlisted host falls back to.
//
// Matching is on the host alone. A user writes the key as a hostname or as
// the URL they were given, and both mean the same instance.

export interface ClusterSettings {
  apiServer: string;
  insecureSkipTlsVerify: boolean;
  certificateAuthority: string;
  kubectlPath: string;
  kubeconfig: string;
  context: string;
  namespace: string;
}

/** What a single entry of the instances table may override. */
export type InstanceOverride = Partial<ClusterSettings>;

/** The host an instance is keyed by, whether written bare or as a URL. */
export function hostOf(urlOrHost: string): string {
  const text = urlOrHost.trim().toLowerCase();
  if (!text) return "";
  // Only parse as a URL when a scheme is actually there. `URL` reads
  // "cde.example.dev:6443" as the scheme "cde.example.dev" with no host at
  // all, which would silently turn a host and port into nothing.
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    try {
      return new URL(text).hostname;
    } catch {
      // Falls through to the bare-host reading below.
    }
  }
  return text.replace(/^\/+/, "").split("/")[0]!.split(":")[0]!;
}

/**
 * The settings that apply to one instance: its own entry over the defaults.
 * An entry that says nothing changes nothing, and an unknown host simply
 * gets the defaults, so adding the table never breaks a working setup.
 */
export function forInstance<T extends ClusterSettings>(
  defaults: T,
  table: Record<string, InstanceOverride> | undefined,
  host: string,
): T {
  if (!table) return defaults;
  const wanted = hostOf(host);
  if (!wanted) return defaults;
  for (const [key, override] of Object.entries(table)) {
    if (hostOf(key) !== wanted) continue;
    const applied = { ...defaults } as Record<string, unknown>;
    for (const [field, value] of Object.entries(override)) {
      // An entry that leaves a field empty defers to the default rather than
      // blanking it: an empty string in settings is how a field is unset.
      if (value !== undefined && value !== null && value !== "") applied[field] = value;
    }
    return applied as T;
  }
  return defaults;
}

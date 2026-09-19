// Maven profiles for the language server's import (RFC 0001 §4.2, decision
// 14): JDT.LS has no `-P`; m2e reads `activeProfiles=` from
// `.settings/org.eclipse.m2e.core.prefs` beside `.classpath`. Spike (a)
// tries this first. If it fails, the overlay of `overlay.ts` is the fallback.
// Pure: the prefs file is a Java properties file with four known keys.

export function setActiveProfiles(
  prefs: string | undefined,
  profiles: string[],
): string {
  const lines = (prefs ?? "")
    .split(/\r?\n/)
    .filter((l) => l.length && !l.startsWith("activeProfiles="));
  const defaults = [
    "eclipse.preferences.version=1",
    "resolveWorkspaceProjects=true",
    "version=1",
  ];
  for (const d of defaults)
    if (!lines.some((l) => l.startsWith(d.split("=")[0] + "="))) lines.push(d);
  lines.push(`activeProfiles=${profiles.join(",")}`);
  return lines.sort().join("\n") + "\n";
}

export function activeProfilesOf(prefs: string | undefined): string[] {
  const v = /^activeProfiles=(.*)$/m.exec(prefs ?? "")?.[1] ?? "";
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

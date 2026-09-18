// The resolution rule of RFC 0001 §4.2: build-tool requirement → matching
// installed runtime → otherwise the newest installed → otherwise none (offer
// an install). Pure; the table is the unit test.
import type { JavaVersionRange, Resolution, Runtime } from "../api-types";

export function resolve(
  runtimes: Runtime[],
  required?: JavaVersionRange,
  matchProject = true,
): Resolution {
  const sorted = [...runtimes].sort((a, b) => b.major - a.major);
  if (required && matchProject) {
    const inRange = sorted.filter(
      (r) =>
        r.major >= required.min &&
        (required.max === undefined || r.major <= required.max),
    );
    // The lowest runtime that satisfies the range: a project asking for 17
    // is built with 17 when it is installed, not with 25.
    const exact =
      inRange.find((r) => r.major === required.min) ?? inRange.at(-1);
    if (exact) return { runtime: exact, required, reason: "matches" };
  }
  const newest = sorted[0];
  return newest
    ? { runtime: newest, required, reason: "newest" }
    : { required, reason: "none" };
}

/** The `java.configuration.runtimes` entries the core writes: every runtime, the resolved one default. */
export function toSettingsRuntimes(
  runtimes: Runtime[],
  resolved?: Runtime,
): { name: string; path: string; default?: boolean }[] {
  const byName = new Map<string, Runtime>();
  // `java.configuration.runtimes` allows one entry per name; the resolved
  // one wins its name, then the newest patch of each major.
  for (const r of runtimes) {
    const cur = byName.get(r.name);
    if (
      !cur ||
      r.path === resolved?.path ||
      (cur.path !== resolved?.path &&
        r.version.localeCompare(cur.version, undefined, { numeric: true }) > 0)
    )
      byName.set(r.name, r);
  }
  return [...byName.values()].map((r) =>
    r.path === resolved?.path
      ? { name: r.name, path: r.path, default: true }
      : { name: r.name, path: r.path },
  );
}

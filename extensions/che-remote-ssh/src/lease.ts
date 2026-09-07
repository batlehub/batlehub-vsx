// Knowing when a remote window has gone.
//
// The forward belongs to the window that opened the connection; the window
// that uses it is another process entirely, and the editor gives the opener
// no event when it closes. So the connected window takes a lease: a small
// file it refreshes while it lives and removes when it unloads. The owner
// stops any forward no live lease refers to.
//
// The lease is deliberately not trusted to be removed. A window that crashes
// leaves its file behind, so a lease also goes stale on age, and staleness
// alone is enough to reclaim the forward. Removal on unload is only what
// makes the common case immediate.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

export interface Lease {
  /** The remote authority, e.g. `ssh-remote+weebo-dev-setup`. */
  authority: string;
  /** Seconds since the epoch, refreshed while the window lives. */
  updatedAt: number;
}

/** What the owner knows about a forward it handed over. */
export interface HandedOver {
  namespace: string;
  pod: string;
  authority: string;
  /** When it was handed over, in the same unit as `now`. */
  since: number;
}

export interface ReclaimOptions {
  /** How long a lease stays good without a refresh. */
  ttlMs: number;
  /** How long a new forward is left alone before a lease is expected. */
  graceMs: number;
}

/** One file per authority, named so it cannot escape the directory. */
export function leaseFileName(authority: string): string {
  const safe = authority.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return `${safe || "unnamed"}.lease`;
}

export async function writeLease(dir: string, authority: string, now = Date.now()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lease: Lease = { authority, updatedAt: now };
  await writeFile(path.join(dir, leaseFileName(authority)), JSON.stringify(lease), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function removeLease(dir: string, authority: string): Promise<void> {
  await rm(path.join(dir, leaseFileName(authority)), { force: true });
}

export async function readLeases(dir: string): Promise<Lease[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Lease[] = [];
  for (const name of names) {
    if (!name.endsWith(".lease")) continue;
    try {
      const doc: unknown = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      const d = doc as Record<string, unknown> | null;
      if (typeof d?.authority === "string" && typeof d.updatedAt === "number") {
        out.push({ authority: d.authority, updatedAt: d.updatedAt });
      }
    } catch {
      // A half-written or hand-edited lease is simply not a lease.
    }
  }
  return out;
}

/**
 * The forwards nothing is using any more: no live lease names them, and they
 * are past the grace period a window is given to take one out.
 *
 * This is the whole rule, and it is pure so it can be tested without an
 * editor, a window or a clock.
 */
export function reclaimable<T extends { authority: string; since: number }>(
  handedOver: T[],
  leases: Lease[],
  now: number,
  opts: ReclaimOptions,
): T[] {
  const live = new Set(
    leases.filter((l) => now - l.updatedAt <= opts.ttlMs).map((l) => l.authority),
  );
  return handedOver.filter((h) => now - h.since > opts.graceMs && !live.has(h.authority));
}

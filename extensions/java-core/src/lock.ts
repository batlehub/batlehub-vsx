// Shared-file locks (RFC 0001 §4.2 "Trust"): `~/.m2/settings.xml`,
// `~/.gradle/init.d/batlehub.gradle` and the overlay are written under
// `<file>.batlehub.lock`, created exclusively, so two windows cannot
// interleave. A lock older than `stale` belongs to a window that died.
import * as fs from "node:fs";

export async function withLock<T>(
  file: string,
  fn: () => Promise<T> | T,
  opts: { stale?: number; wait?: number } = {},
): Promise<T> {
  const lock = `${file}.batlehub.lock`;
  const stale = opts.stale ?? 30_000;
  const deadline = Date.now() + (opts.wait ?? 10_000);
  for (;;) {
    try {
      fs.mkdirSync(require("node:path").dirname(lock), { recursive: true });
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > stale) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`${file} is locked by another window (${lock})`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

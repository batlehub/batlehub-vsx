// The cap ledger (RFC 0003 decision 16, RFC 0002 decision 15): the declared
// caps running against one repository, shared between the editor and the
// command line, so each counts the other. One JSON file per repository
// under the user's cache directory, `0600`; a line whose pid is gone is
// dropped on read. No secret is in it.
import crypto from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface LedgerLine {
  pid: number;
  owner: "editor" | "engine";
  label: string;
  bytes: number;
}

/** `$XDG_CACHE_HOME`, else `~/.cache`: where the engine keeps its server too. */
export const cacheHome = (
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string => env.XDG_CACHE_HOME || path.join(home, ".cache");

/** `kill(pid, 0)`: EPERM is a live process someone else owns. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The ledger of the repository holding `root`: its `.git` folder's parent,
 * else `root` — the engine starts on a module (`core/`), the editor on the
 * repository, and both must land on one file.
 */
export function ledgerFile(root: string, cacheHome: string): string {
  let repo = root;
  for (let d = root; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) {
      repo = d;
      break;
    }
    if (path.dirname(d) === d) break;
  }
  let real = repo;
  try {
    real = realpathSync(repo);
  } catch {
    // A root that does not exist yet is keyed by its path.
  }
  const key = crypto.createHash("sha256").update(real).digest("hex");
  return path.join(
    cacheHome,
    "batlehub",
    "java",
    "ledger",
    `${key.slice(0, 16)}.json`,
  );
}

/** The live lines; a stale or unreadable file is an empty ledger. */
export function readLedger(file: string, isAlive = alive): LedgerLine[] {
  try {
    const lines = JSON.parse(readFileSync(file, "utf8")) as LedgerLine[];
    return Array.isArray(lines) ? lines.filter((l) => isAlive(l.pid)) : [];
  } catch {
    return [];
  }
}

// ponytail: read-modify-rename with no lock; two writers in the same
// millisecond lose one line until its owner's next write. Add a lock file
// when a third writer appears.
function update(
  file: string,
  f: (lines: LedgerLine[]) => LedgerLine[],
  isAlive: (pid: number) => boolean,
): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, JSON.stringify(f(readLedger(file, isAlive))), {
    mode: 0o600,
  });
  renameSync(part, file);
}

/** Adds `line`, replacing the one its pid and owner already had. */
export function putLine(file: string, line: LedgerLine, isAlive = alive): void {
  update(
    file,
    (ls) => [
      ...ls.filter((l) => !(l.pid === line.pid && l.owner === line.owner)),
      line,
    ],
    isAlive,
  );
}

export function removeLine(
  file: string,
  pid: number,
  owner: LedgerLine["owner"],
  isAlive = alive,
): void {
  update(
    file,
    (ls) => ls.filter((l) => !(l.pid === pid && l.owner === owner)),
    isAlive,
  );
}

// Putting what sshconfig.ts generates on disk.
//
// Two files are written, both owned by this extension: the identity read out
// of the workspace, and the config fragment holding the host entries. The
// user's ~/.ssh/config is touched once and only to add the `Include`, which
// goes above the first block for the reason sshconfig.ts explains.
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  ensureIncluded,
  findsPubkeyDisabled,
  renderManagedConfig,
  type HostEntry,
} from "./sshconfig";

export interface InstallResult {
  /** The fragment the Include points at. */
  managedFile: string;
  /** True when ~/.ssh/config had to be edited. */
  includeAdded: boolean;
  /**
   * True when a `PubkeyAuthentication no` is still in the user's config. Our
   * include comes first so it does not bite, but it is worth a log line when
   * a connection is refused anyway.
   */
  pubkeyDisabledSomewhere: boolean;
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** Write a private key only its owner can read. */
export async function writeIdentity(dir: string, name: string, key: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}.key`);
  // OpenSSH refuses a key whose file does not end in a newline.
  const body = key.endsWith("\n") ? key : `${key}\n`;
  await writeFile(file, body, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

export async function removeIdentity(dir: string, name: string): Promise<void> {
  await rm(path.join(dir, `${name}.key`), { force: true });
}

/**
 * Write the host entries and make sure ~/.ssh/config includes them. Safe to
 * run on every connection: the fragment is rewritten whole and the include
 * is added at most once.
 */
export async function installEntries(
  sshDir: string,
  managedFile: string,
  entries: HostEntry[],
  platform?: NodeJS.Platform,
): Promise<InstallResult> {
  await mkdir(path.dirname(managedFile), { recursive: true, mode: 0o700 });
  await writeFile(managedFile, renderManagedConfig(entries, platform), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(managedFile, 0o600);

  const configFile = path.join(sshDir, "config");
  const current = await readOrEmpty(configFile);
  const { text, changed } = ensureIncluded(current, managedFile);
  if (changed) {
    await mkdir(sshDir, { recursive: true, mode: 0o700 });
    await writeFile(configFile, text, { encoding: "utf8", mode: 0o600 });
  }
  return {
    managedFile,
    includeAdded: changed,
    pubkeyDisabledSomewhere: findsPubkeyDisabled(current),
  };
}

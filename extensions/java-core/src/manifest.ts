// The editor side of `written.ts`: every write the family makes outside its
// own settings goes through here, so `Java: Remove BatleHub settings` can
// replay it (RFC 0001 §4.2 "Clean removal"). The manifest lives at
// `<first workspace folder>/.batlehub/java/written.json`.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { withLock } from "./lock";
import { log } from "./log";
import {
  addGitignoreLine,
  describe,
  GITIGNORE_LINE,
  type Manifest,
  parseManifest,
  record,
  removeGitignoreLine,
  replay,
  takeEntry,
} from "./written";

/**
 * After `Remove BatleHub settings` the foreign writes stay off until the user
 * asks for a detection: restoring `java.configuration.runtimes` fires a
 * configuration change, which re-detects, which would write it right back.
 */
let writesSuspended = false;
export const suspendForeignWrites = (): void => {
  writesSuspended = true;
};
export const resumeForeignWrites = (): void => {
  writesSuspended = false;
};
export const foreignWritesSuspended = (): boolean => writesSuspended;

export function manifestPath(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root
    ? path.join(root, ".batlehub", "java", "written.json")
    : undefined;
}

export function readManifest(): Manifest {
  const p = manifestPath();
  if (!p) return parseManifest(undefined);
  try {
    return parseManifest(fs.readFileSync(p, "utf8"));
  } catch {
    return parseManifest(undefined);
  }
}

function save(m: Manifest): void {
  const p = manifestPath();
  if (!p) return;
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n", { mode: 0o600 });
}

/** The file's permission bits before we touch it, `null` when there is no file. */
export function modeOf(p: string): number | null {
  try {
    return fs.statSync(p).mode & 0o777;
  } catch {
    return null;
  }
}

/**
 * `.vscode/settings.json` is a shared file like `~/.m2/settings.xml`: two
 * windows on one workspace write it through their own extension host, and the
 * editor serialises nothing between them (§4.2 "Trust", the locks).
 */
function withSettingsLock<T>(
  folder: vscode.WorkspaceFolder | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const root = (folder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
  if (!root) return Promise.resolve(fn());
  return withLock(path.join(root, ".vscode", "settings.json"), fn);
}

/**
 * A dotted key's section and leaf. `"[java]"` — a language block — has no
 * section at all: `getConfiguration("")` is not the root, so the section must
 * be `undefined`, and the manifest key must not gain a leading dot.
 */
export function splitKey(key: string): {
  section: string | undefined;
  leaf: string;
} {
  if (key.startsWith("[")) return { section: undefined, leaf: key };
  const i = key.lastIndexOf(".");
  return i < 0
    ? { section: undefined, leaf: key }
    : { section: key.slice(0, i), leaf: key.slice(i + 1) };
}

/** Write a foreign key at workspace scope, recording its previous workspace value. */
export async function writeForeignSetting(
  section: string | undefined,
  key: string,
  value: unknown,
  folder?: vscode.WorkspaceFolder,
): Promise<void> {
  if (writesSuspended) return;
  const c = vscode.workspace.getConfiguration(section, folder);
  const before = folder
    ? c.inspect(key)?.workspaceFolderValue
    : c.inspect(key)?.workspaceValue;
  if (JSON.stringify(before) === JSON.stringify(value)) return;
  await withSettingsLock(folder, async () => {
    save(
      record(readManifest(), {
        kind: "setting",
        key: section ? `${section}.${key}` : key,
        scope: "workspace",
        before,
      }),
    );
    await c.update(
      key,
      value,
      folder
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : vscode.ConfigurationTarget.Workspace,
    );
  });
  log.info(
    `wrote ${section ? `${section}.${key}` : key} (workspace) — previous value recorded in the manifest`,
  );
}

/**
 * Undo one recorded setting write: put the previous value back and drop that
 * entry, leaving every other write alone. Returns false when the manifest has
 * no such entry — the key was the user's, and was never the core's to undo.
 */
export async function undoForeignSetting(key: string): Promise<boolean> {
  const { manifest, entry } = takeEntry(readManifest(), `setting:${key}`);
  if (!entry || entry.kind !== "setting") return false;
  const { section, leaf } = splitKey(key);
  await withSettingsLock(undefined, async () => {
    await vscode.workspace
      .getConfiguration(section)
      .update(leaf, entry.before, vscode.ConfigurationTarget.Workspace);
    save(manifest);
  });
  log.info(`undo: ${key} restored to ${JSON.stringify(entry.before)}`);
  return true;
}

/** Another extension's setting (coexistence), recorded as such. */
export async function writeExtSetting(
  section: string,
  key: string,
  value: unknown,
): Promise<void> {
  const c = vscode.workspace.getConfiguration(section);
  const before = c.inspect(key)?.workspaceValue;
  await withSettingsLock(undefined, async () => {
    save(
      record(readManifest(), {
        kind: "extSetting",
        key: `${section}.${key}`,
        before,
      }),
    );
    await c.update(key, value, vscode.ConfigurationTarget.Workspace);
  });
}

/** A file the family owns entirely (the overlay, `init.d/batlehub.gradle`), 0600. */
export function writeOwnedFile(p: string, content: string): void {
  let before: string | null = null;
  try {
    before = fs.readFileSync(p, "utf8");
  } catch {
    before = null;
  }
  save(
    record(readManifest(), {
      kind: "file",
      path: p,
      before,
      mode: modeOf(p),
    }),
  );
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, content, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

/** A fenced block inside a shared file (`settings.xml`); the caller has already rewritten the file, and read its mode before doing so. */
export function recordBlock(
  p: string,
  marker: string,
  mode: number | null,
): void {
  save(record(readManifest(), { kind: "block", path: p, marker, mode }));
}

/** The `.gitignore` line, written *before* the overlay (§4.2); throws when it cannot be written. */
export function ensureGitignore(root: string): void {
  const p = path.join(root, ".gitignore");
  let cur: string | undefined;
  try {
    cur = fs.readFileSync(p, "utf8");
  } catch {
    cur = undefined;
  }
  const next = addGitignoreLine(cur);
  if (next === cur) return;
  save(
    record(readManifest(), {
      kind: "gitignore",
      path: p,
      line: GITIGNORE_LINE,
    }),
  );
  fs.writeFileSync(p, next);
}

/** Put back the permission bits the file had before the core set `0600` on it. */
function restoreMode(p: string, mode: number | null | undefined): void {
  if (typeof mode !== "number") return;
  try {
    fs.chmodSync(p, mode);
  } catch {
    /* the file is gone: nothing to restore */
  }
}

/** `Java: Remove BatleHub settings`: list, ask, replay backwards, delete the manifest. */
export async function removeBatleHubSettings(
  blockRemovers: Record<string, (file: string) => void>,
): Promise<void> {
  const m = readManifest();
  const lines = describe(m);
  if (!lines.length) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        "BatleHub Java has written nothing outside its own settings in this workspace.",
      ),
    );
    return;
  }
  const go = vscode.l10n.t("Restore {0} item(s)", lines.length);
  const pick = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "BatleHub Java will restore, newest first:\n\n{0}",
      lines.map((l) => `• ${l}`).join("\n"),
    ),
    { modal: true },
    go,
  );
  if (pick !== go) return;
  const errors = await replay(m, {
    setting: async (key, before) => {
      const { section, leaf } = splitKey(key);
      await vscode.workspace
        .getConfiguration(section)
        .update(leaf, before, vscode.ConfigurationTarget.Workspace);
    },
    extSetting: async (key, before) => {
      const i = key.lastIndexOf(".");
      await vscode.workspace
        .getConfiguration(key.slice(0, i))
        .update(key.slice(i + 1), before, vscode.ConfigurationTarget.Workspace);
    },
    file: async (p, before, mode) => {
      if (before === null) fs.rmSync(p, { force: true });
      else {
        fs.writeFileSync(p, before);
        restoreMode(p, mode);
      }
    },
    block: async (p, marker, mode) => {
      const remover = blockRemovers[marker];
      if (!remover) throw new Error(`no remover for the ${marker} block`);
      remover(p);
      restoreMode(p, mode);
    },
    gitignore: async (p, line) => {
      try {
        fs.writeFileSync(
          p,
          removeGitignoreLine(fs.readFileSync(p, "utf8"), line),
        );
      } catch {
        /* already gone */
      }
    },
  });
  suspendForeignWrites();
  const mp = manifestPath();
  if (mp) fs.rmSync(path.dirname(mp), { recursive: true, force: true });
  for (const e of errors) log.error(`remove: ${e}`);
  void vscode.window.showInformationMessage(
    errors.length
      ? vscode.l10n.t(
          "BatleHub Java: restored with {0} error(s) — see the BatleHub Java log.",
          errors.length,
        )
      : vscode.l10n.t(
          "BatleHub Java: every foreign write restored. Installed JDKs and your launch.json entries were left alone.",
        ),
  );
}

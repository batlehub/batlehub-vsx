// The editor side of `written.ts`: every write the family makes outside its
// own settings goes through here, so `Java: Remove BatleHub settings` can
// replay it (RFC 0001 §4.2 "Clean removal"). The manifest lives at
// `<first workspace folder>/.batlehub/java/written.json`.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
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

/** Write a foreign key at workspace scope, recording its previous workspace value. */
export async function writeForeignSetting(
  section: string,
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
  save(
    record(readManifest(), {
      kind: "setting",
      key: `${section}.${key}`,
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
  log.info(
    `wrote ${section}.${key} (workspace) — previous value recorded in the manifest`,
  );
}

/** Another extension's setting (coexistence), recorded as such. */
export async function writeExtSetting(
  section: string,
  key: string,
  value: unknown,
): Promise<void> {
  const c = vscode.workspace.getConfiguration(section);
  const before = c.inspect(key)?.workspaceValue;
  save(
    record(readManifest(), {
      kind: "extSetting",
      key: `${section}.${key}`,
      before,
    }),
  );
  await c.update(key, value, vscode.ConfigurationTarget.Workspace);
}

/** A file the family owns entirely (the overlay, `init.d/batlehub.gradle`), 0600. */
export function writeOwnedFile(p: string, content: string): void {
  let before: string | null = null;
  try {
    before = fs.readFileSync(p, "utf8");
  } catch {
    before = null;
  }
  save(record(readManifest(), { kind: "file", path: p, before }));
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, content, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

/** A fenced block inside a shared file (`settings.xml`); the caller has already rewritten the file. */
export function recordBlock(p: string, marker: string): void {
  save(record(readManifest(), { kind: "block", path: p, marker }));
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
      const i = key.lastIndexOf(".");
      await vscode.workspace
        .getConfiguration(key.slice(0, i))
        .update(key.slice(i + 1), before, vscode.ConfigurationTarget.Workspace);
    },
    extSetting: async (key, before) => {
      const i = key.lastIndexOf(".");
      await vscode.workspace
        .getConfiguration(key.slice(0, i))
        .update(key.slice(i + 1), before, vscode.ConfigurationTarget.Workspace);
    },
    file: async (p, before) => {
      if (before === null) fs.rmSync(p, { force: true });
      else fs.writeFileSync(p, before);
    },
    block: async (p, marker) => {
      const remover = blockRemovers[marker];
      if (!remover) throw new Error(`no remover for the ${marker} block`);
      remover(p);
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

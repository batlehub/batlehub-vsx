// The editor side of `written.ts`: every write the family makes outside its
// own settings goes through here, so `Java: Remove BatleHub settings` can
// replay it (RFC 0001 §4.2 "Clean removal"). The manifest lives at
// `<first workspace folder>/.batlehub/java/local/written.json` — `local/` is
// the machine's half of the directory, the rest is the team's (RFC 0006
// §5.2); a workspace still on the v1 layout keeps `.batlehub/java/written.json`
// until `migrateV1Layout()` moves it.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  type ProfileRule,
  unwriteRules,
  writeRules,
} from "@batlehub/java-rules/profile";
import { withLock } from "./lock";
import { log } from "./log";
import {
  addGitignoreLine,
  describe,
  GITIGNORE_LINE,
  type Manifest,
  narrowGitignore,
  parseManifest,
  record,
  relocate,
  removeGitignoreLine,
  V1_GITIGNORE_LINE,
  wouldExpose,
  replay,
  takeEntry,
  targetOf,
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

/** `.batlehub/java/local/` of the first folder: the core's own files, never committed. */
export function localDir(): string | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, ".batlehub", "java", "local") : undefined;
}

export function manifestPath(): string | undefined {
  const local = localDir();
  if (!local) return undefined;
  const p = path.join(local, "written.json");
  const v1 = path.join(path.dirname(local), "written.json");
  return !fs.existsSync(p) && fs.existsSync(v1) ? v1 : p;
}

/** Every path under `dir`, relative and `/`-separated, directories included. */
function listUnder(dir: string, rel = ""): string[] {
  let out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), {
    withFileTypes: true,
  })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    out.push(r);
    if (e.isDirectory() && r !== "local") out = out.concat(listUnder(dir, r));
  }
  return out;
}

/**
 * RFC 0006 §5.3, once at activation: a workspace on the v1 layout (the
 * manifest beside the team's files, or the .gitignore line that hid the
 * whole directory) moves the core's files under `local/` and narrows the
 * line. When narrowing would expose a file nobody declared, nothing moves
 * until the developer answers; untrusted, the v1 layout stays.
 */
export async function migrateV1Layout(trusted: boolean): Promise<void> {
  const local = localDir();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!local || !root) return;
  const dir = path.dirname(local);
  const gi = path.join(root, ".gitignore");
  let giText: string | undefined;
  try {
    giText = fs.readFileSync(gi, "utf8");
  } catch {
    giText = undefined;
  }
  const v1Line = !!giText?.split(/\r?\n/).includes(V1_GITIGNORE_LINE);
  const v1Manifest = path.join(dir, "written.json");
  if (!fs.existsSync(v1Manifest) && !v1Line) return;
  if (v1Line) {
    try {
      fs.accessSync(gi, fs.constants.W_OK);
    } catch {
      log.warn(
        "migration skipped: .gitignore is not writable, so its v1 line cannot be narrowed to .batlehub/java/local/ — the v1 layout keeps working",
      );
      return;
    }
  }
  // Only the v1 line hid anything: without it, nothing becomes visible.
  const exposed =
    v1Line && fs.existsSync(dir) ? wouldExpose(listUnder(dir)) : [];
  let move: string[] = [];
  if (exposed.length) {
    if (!trusted) return;
    const moveIt = vscode.l10n.t("Move to local/ and continue");
    const leave = vscode.l10n.t("Leave them and continue");
    const later = vscode.l10n.t("Not now");
    const a = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "BatleHub Java now ignores only .batlehub/java/local/, so the team's files there can be committed. These would become visible to git: {0}",
        exposed.join(", "),
      ),
      moveIt,
      leave,
      later,
    );
    if (a === moveIt)
      move = exposed.filter(
        (p) => !exposed.some((q) => q !== p && p.startsWith(`${q}/`)),
      );
    else if (a !== leave) return;
  }
  fs.mkdirSync(local, { recursive: true, mode: 0o700 });
  let m = readManifest();
  const overlay = path.join(dir, "settings-overlay.xml");
  const overlayTo = path.join(local, "settings-overlay.xml");
  const overlayMoved = fs.existsSync(overlay);
  if (overlayMoved) {
    fs.renameSync(overlay, overlayTo);
    m = relocate(m, overlay, overlayTo);
  }
  for (const p of move) {
    const from = path.join(dir, p);
    const to = path.join(local, p);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.renameSync(from, to);
    m = record(m, { kind: "moved", from, to });
  }
  if (v1Line) {
    fs.writeFileSync(gi, narrowGitignore(giText!));
    m = record(m, { kind: "gitignore", path: gi, line: GITIGNORE_LINE });
  }
  // The new manifest first, then the old one goes: a crash between leaves a
  // manifest, never none.
  fs.writeFileSync(
    path.join(local, "written.json"),
    JSON.stringify(m, null, 2) + "\n",
    { mode: 0o600 },
  );
  fs.rmSync(v1Manifest, { force: true });
  if (
    overlayMoved &&
    vscode.workspace
      .getConfiguration("java")
      .inspect("configuration.maven.userSettings")?.workspaceValue === overlay
  )
    await writeForeignSetting(
      "java",
      "configuration.maven.userSettings",
      overlayTo,
    );
  log.info(
    `migrated .batlehub/java to the local/ layout${move.length ? ` (moved: ${move.join(", ")})` : ""}`,
  );
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
 * Contract 1.1 `manifest.writeSetting`: a satellite's foreign write, under
 * the default-on rule of RFC 0001 §7.1 — never over a value the user set at
 * any scope (one the core recorded is its own, and may be rewritten).
 */
export async function writeSatelliteSetting(
  key: string,
  value: unknown,
): Promise<boolean> {
  const { section, leaf } = splitKey(key);
  const i = vscode.workspace.getConfiguration(section).inspect(leaf);
  const ours = readManifest().entries.some(
    (e) => targetOf(e) === `setting:${key}`,
  );
  const users =
    !ours &&
    (i?.globalValue !== undefined ||
      i?.workspaceValue !== undefined ||
      i?.workspaceFolderValue !== undefined);
  if (users || writesSuspended) return false;
  await writeForeignSetting(section, leaf, value);
  return true;
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

/**
 * The one way a program writes the team's profile (RFC 0005 §6.6): RFC 0007's
 * import and `Save as project profile` both call it. Each rule of `patch` is
 * set (`null` removes it), comments and other keys kept, and the manifest
 * records what each key replaced. The file is the team's, committed: its mode
 * is left alone.
 */
export function writeProfileEntries(
  file: string,
  patch: Record<string, ProfileRule | null>,
): void {
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = undefined;
  }
  const out = writeRules(text, patch);
  const entries = Object.fromEntries(
    Object.entries(patch)
      .filter((e): e is [string, ProfileRule] => e[1] !== null)
      .map(([k, written]) => [
        k,
        { written, previous: out.previous[k] ?? null },
      ]),
  );
  save(
    record(readManifest(), {
      kind: "profile",
      path: file,
      created: text === undefined,
      entries,
    }),
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.text);
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

/**
 * `Java: Remove BatleHub settings`: list, ask, replay backwards, delete the
 * manifest — and `ownStorage`, the extension's own files that have no
 * previous value to restore (RFC 0003 §9: the process history, a step kind's
 * base directories).
 */
export async function removeBatleHubSettings(
  blockRemovers: Record<string, (file: string) => void>,
  ownStorage: () => string[] = () => [],
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
    moved: async (from, to) => {
      if (!fs.existsSync(to) || fs.existsSync(from)) return;
      fs.mkdirSync(path.dirname(from), { recursive: true });
      fs.renameSync(to, from);
    },
    profile: async (p, created, entries) => {
      let text: string;
      try {
        text = fs.readFileSync(p, "utf8");
      } catch {
        return; /* deleted by someone: nothing to take back */
      }
      const u = unwriteRules(text, entries, created);
      if (u.text === null) fs.rmSync(p, { force: true });
      else if (u.text !== text) fs.writeFileSync(p, u.text);
      if (u.kept.length)
        log.info(
          `remove: kept in ${p}, edited since the family wrote them: ${u.kept.join(", ")}`,
        );
    },
  });
  suspendForeignWrites();
  // The manifest, then its directories up to `.batlehub/` only when nothing
  // else is in them: `.batlehub/java/` holds the team's committed files too
  // (RFC 0005, RFC 0006), which are not the family's to delete.
  const mp = manifestPath();
  if (mp) {
    fs.rmSync(mp, { force: true });
    for (let d = path.dirname(mp); ; d = path.dirname(d)) {
      try {
        fs.rmdirSync(d);
      } catch {
        break; /* not empty, or gone */
      }
      if (path.basename(d) === ".batlehub") break;
    }
  }
  for (const p of ownStorage()) fs.rmSync(p, { recursive: true, force: true });
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

// The manifest of every write the family makes outside its own settings
// (RFC 0001 §4.2 "Clean removal", decision 24): `.batlehub/java/written.json`
// records the previous value, and `Java: Remove BatleHub settings` replays it
// backwards — restoring, not deleting. Pure over an injected store.

export type Entry =
  | {
      kind: "setting";
      key: string;
      scope: "workspace";
      before: unknown;
      at: string;
    }
  | { kind: "file"; path: string; before: string | null; at: string }
  | { kind: "block"; path: string; marker: string; at: string }
  | { kind: "gitignore"; path: string; line: string; at: string }
  | { kind: "extSetting"; key: string; before: unknown; at: string };

/** `Omit` distributed over the union, so each kind keeps its own fields. */
export type NewEntry = Entry extends infer E
  ? E extends Entry
    ? Omit<E, "at">
    : never
  : never;

export interface Manifest {
  version: 1;
  entries: Entry[];
}

export const EMPTY: Manifest = { version: 1, entries: [] };

export function parseManifest(text: string | undefined): Manifest {
  if (!text) return { ...EMPTY, entries: [] };
  try {
    const m = JSON.parse(text) as Manifest;
    return m && m.version === 1 && Array.isArray(m.entries)
      ? m
      : { ...EMPTY, entries: [] };
  } catch {
    return { ...EMPTY, entries: [] };
  }
}

/**
 * Append an entry — except when the same target is already recorded: the
 * manifest keeps the value *before the family's first write*, so a second
 * write of the same key does not overwrite the original with the family's own.
 */
export function record(m: Manifest, e: NewEntry): Manifest {
  const same = m.entries.some((x) => targetOf(x) === targetOf(e as Entry));
  if (same) return m;
  return {
    version: 1,
    entries: [...m.entries, { ...e, at: new Date().toISOString() } as Entry],
  };
}

export function targetOf(e: Entry): string {
  switch (e.kind) {
    case "setting":
      return `setting:${e.key}`;
    case "extSetting":
      return `ext:${e.key}`;
    case "file":
      return `file:${e.path}`;
    case "block":
      return `block:${e.path}:${e.marker}`;
    case "gitignore":
      return `gitignore:${e.path}:${e.line}`;
  }
}

/** One human line per entry, newest first — what the command lists before asking. */
export function describe(m: Manifest): string[] {
  return [...m.entries].reverse().map((e) => {
    switch (e.kind) {
      case "setting":
        return `restore workspace setting ${e.key} to ${e.before === undefined ? "(unset)" : JSON.stringify(e.before)}`;
      case "extSetting":
        return `restore ${e.key} (another extension's setting) to ${e.before === undefined ? "(unset)" : JSON.stringify(e.before)}`;
      case "file":
        return e.before === null
          ? `delete ${e.path}`
          : `restore ${e.path} to its previous content`;
      case "block":
        return `remove the ${e.marker} block from ${e.path}`;
      case "gitignore":
        return `remove "${e.line}" from ${e.path}`;
    }
  });
}

export interface Replayer {
  setting(key: string, before: unknown): Promise<void>;
  extSetting(key: string, before: unknown): Promise<void>;
  file(path: string, before: string | null): Promise<void>;
  block(path: string, marker: string): Promise<void>;
  gitignore(path: string, line: string): Promise<void>;
}

/** Newest first, every entry, errors collected rather than stopping the replay. */
export async function replay(m: Manifest, r: Replayer): Promise<string[]> {
  const errors: string[] = [];
  for (const e of [...m.entries].reverse()) {
    try {
      if (e.kind === "setting") await r.setting(e.key, e.before);
      else if (e.kind === "extSetting") await r.extSetting(e.key, e.before);
      else if (e.kind === "file") await r.file(e.path, e.before);
      else if (e.kind === "block") await r.block(e.path, e.marker);
      else await r.gitignore(e.path, e.line);
    } catch (err) {
      errors.push(`${targetOf(e)}: ${(err as Error).message}`);
    }
  }
  return errors;
}

/** The `.gitignore` line the family owns, fenced so it can be found and removed. */
export const GITIGNORE_LINE =
  "/.batlehub/java/  # batlehub-java: the Maven overlay carries credentials";

export function addGitignoreLine(
  text: string | undefined,
  line = GITIGNORE_LINE,
): string {
  const cur = text ?? "";
  if (cur.split(/\r?\n/).includes(line)) return cur;
  return cur.length && !cur.endsWith("\n")
    ? `${cur}\n${line}\n`
    : `${cur}${line}\n`;
}

export function removeGitignoreLine(
  text: string,
  line = GITIGNORE_LINE,
): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l !== line)
    .join("\n");
}

// `WorkspaceEdit` → files (RFC 0002 §5.2, §4.2 "Command line: dry run by
// default"). The engine applies the server's edits itself, as the editor
// does. A write lands only inside the workspace, never through a symlink out
// of it, and only on a file that is as the server read it (exit 3, §4.3).
import { realpathSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface TextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}
export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
}

/** The offset of an LSP position: UTF-16 units, which is what a JS string counts. */
function offsetOf(
  text: string,
  p: { line: number; character: number },
): number {
  let at = 0;
  for (let l = 0; l < p.line; l++) {
    const nl = text.indexOf("\n", at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  return Math.min(at + p.character, text.length);
}

/** The text after the edits; overlapping edits are the server's bug, refused. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const spans = edits
    .map((e) => ({
      s: offsetOf(text, e.range.start),
      e: offsetOf(text, e.range.end),
      t: e.newText,
    }))
    .sort((a, b) => b.s - a.s || b.e - a.e);
  let out = text;
  let floor = Infinity;
  for (const x of spans) {
    if (x.e > floor) throw new Error("overlapping edits");
    out = out.slice(0, x.s) + x.t + out.slice(x.e);
    floor = x.s;
  }
  return out;
}

export interface Planned {
  file: string;
  before: string;
  after: string;
  edits: number;
}

/** Every file the edit touches, before and after, nothing written. */
export function plan(edit: WorkspaceEdit): Planned[] {
  return Object.entries(edit.changes ?? {})
    .filter(([, l]) => l.length)
    .map(([uri, l]) => {
      const file = fileURLToPath(uri);
      const before = readFileSync(file, "utf8");
      return { file, before, after: applyEdits(before, l), edits: l.length };
    })
    .filter((p) => p.after !== p.before)
    .sort((a, b) => a.file.localeCompare(b.file));
}

export class Refused extends Error {}

/**
 * Writes the planned files. `mtimes` (by real path) is what each mtime was when the
 * server was asked; a file changed since, or reached through a symlink that
 * leaves `root`, refuses the whole write before any file is touched.
 */
export function write(
  planned: Planned[],
  root: string,
  mtimes: Map<string, number>,
): void {
  const realRoot = realpathSync(root);
  for (const p of planned) {
    const real = realpathSync(p.file);
    const rel = path.relative(realRoot, real);
    if (rel.startsWith("..") || path.isAbsolute(rel))
      throw new Refused(
        `${p.file} resolves to ${real}, outside the workspace: not written`,
      );
    const was = mtimes.get(real);
    if (
      was === undefined ||
      statSync(p.file).mtimeMs !== was ||
      readFileSync(p.file, "utf8") !== p.before
    )
      throw new Refused(
        `${p.file} changed on disk since the server read it: nothing written`,
      );
  }
  for (const p of planned) writeFileSync(p.file, p.after);
}

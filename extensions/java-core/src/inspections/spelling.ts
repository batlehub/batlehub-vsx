// Spell checking in code (RFC 0013 phase 1): a bridge to cspell, not a
// checker. cspell owns the words, the dictionaries, the level and its own
// fixes; the core shows its Java and Groovy findings as one rule of the
// Inspections view and adds one fix — the word into the team's committed
// `cspell.json`. The core owns no spelling data (§5.1).
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { Core } from "../extension";
import { log } from "../log";
import { wire } from "../wire";
import type { Row } from "./rules";

export const CSPELL = "streetsidesoftware.code-spell-checker";
export const CODE = "spelling/unknownWord";
const SOURCE = "cSpell";
const LANGUAGES = ["java", "groovy"];
/** The configuration files cspell reads at a folder's root; the first found is the team's. */
const CONFIGS = ["cspell.json", ".cspell.json", "cSpell.json"];

/** cspell's diagnostics → the view's rows; the word is the diagnostic's range text (§6.1). */
export function toRows(
  diags: {
    source?: string;
    severity: number;
    word: string;
    range: Row["range"];
  }[],
): Row[] {
  const sev = ["error", "warning", "info", "hint"] as const;
  return diags
    .filter((d) => d.source === SOURCE)
    .map((d) => ({
      ruleId: "unknownWord",
      area: "spelling",
      code: CODE,
      message: `Unknown word "${d.word}"`,
      severity: sev[d.severity] ?? "info",
      range: d.range,
    }));
}

/**
 * The quick fix's edit (§4.2): the word appended to `words`, through
 * jsonc-parser, comments kept. No file: one is created with `version`,
 * `language`, the word, and the build directories in `ignorePaths` — the
 * one moment those are written. Already there: unchanged. Unparseable:
 * throws, and the fix is not offered.
 */
export function addWord(text: string | undefined, word: string): string {
  if (text === undefined)
    return `${JSON.stringify({ version: "0.2", language: "en", words: [word], ignorePaths: ["target/**", "build/**"] }, null, 2)}\n`;
  const errors: ParseError[] = [];
  const doc = parse(text, errors, { allowTrailingComma: true }) as
    { words?: unknown } | undefined;
  if (errors.length || !doc || typeof doc !== "object")
    throw new Error("cspell configuration is not valid JSON");
  const words = Array.isArray(doc.words) ? (doc.words as unknown[]) : undefined;
  if (words?.includes(word)) return text;
  const fmt = {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  };
  return applyEdits(
    text,
    words
      ? modify(text, ["words", words.length], word, {
          ...fmt,
          isArrayInsertion: true,
        })
      : modify(text, ["words"], [word], fmt),
  );
}

export type SpellingState = "bridged" | "not available" | "disabled by you";

/** §4.3's row states, from what is installed and what the user set. */
export function spellingState(f: {
  installed: boolean;
  enabled: boolean | undefined;
  fileTypes: Record<string, boolean> | undefined;
}): SpellingState {
  if (!f.installed) return "not available";
  if (f.enabled === false || f.fileTypes?.java === false)
    return "disabled by you";
  return "bridged";
}

/** The team's cspell configuration at the first folder's root, if any. */
function configPath(folder: vscode.WorkspaceFolder): {
  file: string;
  exists: boolean;
} {
  for (const n of CONFIGS) {
    const f = path.join(folder.uri.fsPath, n);
    if (fs.existsSync(f)) return { file: f, exists: true };
  }
  return { file: path.join(folder.uri.fsPath, CONFIGS[0]!), exists: false };
}

export class Spelling implements vscode.Disposable {
  readonly rows = new Map<string, Row[]>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  private logged = "";

  constructor(private readonly core: Core) {
    this.subs.push(
      vscode.languages.onDidChangeDiagnostics((e) => this.collect(e.uris)),
      vscode.extensions.onDidChange(() => this.detect()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("cSpell")) this.changed.fire();
      }),
    );
    this.detect();
  }

  version(): string | undefined {
    return vscode.extensions.getExtension<unknown>(CSPELL)?.packageJSON
      ?.version as string | undefined;
  }

  state(): SpellingState {
    const c = vscode.workspace.getConfiguration("cSpell");
    return spellingState({
      installed: !!vscode.extensions.getExtension(CSPELL),
      enabled: c.get<boolean>("enabled"),
      fileTypes: c.get<Record<string, boolean>>("enabledFileTypes"),
    });
  }

  private detect(): void {
    const s = this.state();
    const line =
      s === "bridged"
        ? `spelling: cspell ${this.version()} detected, bridged`
        : `spelling: ${s}`;
    if (line !== this.logged) log.info((this.logged = line));
    this.collect(vscode.languages.getDiagnostics().map(([u]) => u));
  }

  private collect(uris: readonly vscode.Uri[]): void {
    // Untrusted: cspell keeps its own restriction; the core bridges nothing before trust.
    if (!this.core.trusted()) return;
    let any = false;
    for (const uri of uris) {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === uri.toString(),
      );
      const lang =
        doc?.languageId ??
        (/\.(java)$/.test(uri.path)
          ? "java"
          : /\.(groovy|gradle)$/.test(uri.path)
            ? "groovy"
            : "");
      if (!LANGUAGES.includes(lang)) continue;
      const rows = toRows(
        vscode.languages.getDiagnostics(uri).map((d) => ({
          source: d.source,
          severity: d.severity,
          word: doc?.getText(d.range) ?? /"([^"]+)"/.exec(d.message)?.[1] ?? "",
          range: {
            start: {
              line: d.range.start.line,
              character: d.range.start.character,
            },
            end: { line: d.range.end.line, character: d.range.end.character },
          },
        })),
      );
      const key = uri.toString();
      if (rows.length) this.rows.set(key, rows);
      else if (!this.rows.delete(key)) continue;
      any = true;
    }
    if (any) this.changed.fire();
  }

  /** `Add "<word>" to project dictionary (cspell.json)` — the one writer of the file (decision 9). */
  async addWord(word: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !this.core.trusted()) return;
    const { file, exists } = configPath(folder);
    const text = exists ? fs.readFileSync(file, "utf8") : undefined;
    fs.writeFileSync(file, addWord(text, word));
    log.info(
      `spelling: "${word}" added to ${path.basename(file)}${exists ? "" : " (created)"}`,
    );
  }

  async openConfig(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const { file, exists } = configPath(folder);
    if (exists) await vscode.window.showTextDocument(vscode.Uri.file(file));
    else
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Java: no cspell.json yet — the quick fix "Add to project dictionary" creates it.',
        ),
      );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.changed.dispose();
  }
}

/** The core's one fix: the word into the team's dictionary; cspell's own fixes stand beside it. */
class AddToDictionary implements vscode.CodeActionProvider {
  provideCodeActions(
    doc: vscode.TextDocument,
    _range: vscode.Range,
    ctx: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const folder =
      vscode.workspace.getWorkspaceFolder(doc.uri) ??
      vscode.workspace.workspaceFolders?.[0];
    if (!folder) return [];
    const { file, exists } = configPath(folder);
    // §4.3: a configuration that does not parse gets no fix; cspell shows its own error.
    if (exists)
      try {
        addWord(fs.readFileSync(file, "utf8"), "x");
      } catch {
        return [];
      }
    return ctx.diagnostics
      .filter((d) => d.source === SOURCE)
      .map((d) => {
        const word = doc.getText(d.range);
        const a = new vscode.CodeAction(
          vscode.l10n.t(
            'Add "{0}" to project dictionary ({1})',
            word,
            path.basename(file),
          ),
          vscode.CodeActionKind.QuickFix,
        );
        a.diagnostics = [d];
        a.command = {
          command: "batlehub.java.spelling.addWord",
          title: a.title,
          arguments: [word],
        };
        return a;
      });
  }
}

let spelling: Spelling | undefined;
export const spellingOf = () => spelling;

wire((core: Core) => {
  spelling = new Spelling(core);
  core.context.subscriptions.push(
    spelling,
    vscode.languages.registerCodeActionsProvider(
      LANGUAGES.map((language) => ({ language })),
      new AddToDictionary(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.commands.registerCommand(
      "batlehub.java.spelling.addWord",
      (word: string) => spelling!.addWord(word),
    ),
    vscode.commands.registerCommand("batlehub.java.spelling.openConfig", () =>
      spelling!.openConfig(),
    ),
    vscode.commands.registerCommand("batlehub.java.spelling.install", () =>
      vscode.commands.executeCommand("extension.open", CSPELL),
    ),
  );
});

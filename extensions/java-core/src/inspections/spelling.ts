// Spell checking in code (RFC 0013 phases 1–3): a bridge to cspell, not a
// checker. cspell owns the words, the dictionaries, the level and its own
// fixes; the core shows its Java and Groovy findings as one rule of the
// Inspections view and adds one fix — the word into the team's committed
// `cspell.json`. The core owns no spelling data (§5.1). One thing reaches
// cspell: the profile's `off`, as `cSpell.enabledFileTypes` (phase 2). And
// one fix of the core's own on an identifier: JDT.LS's rename to cspell's
// corrections, re-joined in the identifier's case (phase 3).
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { Core } from "../extension";
import { readSettings } from "../config";
import { log } from "../log";
import {
  readManifest,
  undoForeignSetting,
  writeForeignSetting,
} from "../manifest";
import { wire } from "../wire";
import { targetOf } from "../written";
import { mergeSeverities } from "@batlehub/java-rules/profile";
import type { Row } from "@batlehub/java-rules/rules";

export const CSPELL = "streetsidesoftware.code-spell-checker";
export const CODE = "spelling/unknownWord";
const SOURCE = "cSpell";
const LANGUAGES = ["java", "groovy"];
const FILE_TYPES = "cSpell.enabledFileTypes";
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

/**
 * §4.2 "`off`, and only `off`, reaches cspell": `off` → the workspace's
 * `enabledFileTypes` with `java` and `groovy` false, its other keys kept;
 * any other level → nothing, cspell's `diagnosticLevel` being one level for
 * every file type (decision 3).
 */
export function severityToCspell(
  level: string | undefined,
  fileTypes: Record<string, boolean> | undefined,
): Record<string, boolean> | undefined {
  if (level !== "off") return undefined;
  return {
    ...fileTypes,
    ...Object.fromEntries(LANGUAGES.map((l) => [l, false])),
  };
}

/** The rule's level for Java: the developer's override over the team's profile, by full or bare id. */
export function spellingLevel(
  project: Record<string, string>,
  overrides: Record<string, string>,
): string | undefined {
  const m = mergeSeverities(project as never, overrides);
  return m[CODE] ?? m[CODE.split("/")[1]!];
}

/** The view's words for a level that is not `off` (§4.2): it is not applied. */
export function levelNote(diagnosticLevel: string | undefined): string {
  const l = { Error: "error", Warning: "warning", Hint: "hint" }[
    diagnosticLevel ?? ""
  ];
  return `level is cspell's (${l ?? "info"}) — a per-language level does not exist yet`;
}

/**
 * §5.2 (decision 18): cspell's corrections for one diagnostic, from the
 * suggestions its server attaches to it — `data.suggestions`, `{ word,
 * isPreferred }[]`, what cspell's own client reads for its `Replace with`
 * fixes. The preferred one, else the first; undefined when the shape is not
 * that, so a change in cspell turns the fix off rather than wrong.
 */
export function suggestionOf(data: unknown): string | undefined {
  const list = (data as { suggestions?: unknown } | undefined)?.suggestions;
  if (!Array.isArray(list)) return undefined;
  const words = list.filter(
    (x): x is { word: string; isPreferred?: boolean } =>
      typeof (x as { word?: unknown })?.word === "string",
  );
  return (words.find((x) => x.isPreferred) ?? words[0])?.word;
}

/**
 * The identifier with each misspelt part replaced by its correction in that
 * part's case — `recieveMesage` + receive, Message → `receiveMessage`,
 * `RECIEVE_MESAGE` → `RECEIVE_MESSAGE`. Undefined when a part has no
 * correction or is not found in order: then no fix is offered.
 */
export function correctedIdentifier(
  identifier: string,
  parts: { word: string; suggestion: string | undefined }[],
): string | undefined {
  let out = "";
  let at = 0;
  for (const { word, suggestion } of parts) {
    const i = identifier.indexOf(word, at);
    if (i < 0 || !suggestion) return undefined;
    const fixed =
      word === word.toUpperCase()
        ? suggestion.toUpperCase()
        : word[0] === word[0]!.toUpperCase()
          ? suggestion[0]!.toUpperCase() + suggestion.slice(1).toLowerCase()
          : suggestion.toLowerCase();
    out += identifier.slice(at, i) + fixed;
    at = i + word.length;
  }
  return out + identifier.slice(at);
}

export type SpellingState = "bridged" | "not available" | "disabled by you";

/** §4.3's row states, from what is installed and what the user set. */
export function spellingState(f: {
  installed: boolean;
  enabled: boolean | undefined;
  fileTypes: Record<string, boolean> | undefined;
  /** `java: false` is the profile's, written by the core: not the developer's doing. */
  ours?: boolean;
}): SpellingState {
  if (!f.installed) return "not available";
  if (f.enabled === false || (f.fileTypes?.java === false && !f.ours))
    return "disabled by you";
  return "bridged";
}

/** Whether the core's manifest holds the `enabledFileTypes` write: then it is the profile's. */
const written = () =>
  readManifest().entries.some((e) => targetOf(e) === `setting:${FILE_TYPES}`);

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
  private applying: Promise<void> = Promise.resolve();
  private project: Record<string, string> | undefined;

  constructor(private readonly core: Core) {
    this.subs.push(
      vscode.languages.onDidChangeDiagnostics((e) => this.collect(e.uris)),
      vscode.extensions.onDidChange(() => {
        this.detect();
        void this.apply();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("cSpell")) this.changed.fire();
        if (e.affectsConfiguration("batlehub.java.inspections"))
          void this.apply();
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
      ours: written(),
    });
  }

  /** The team's levels, from the bridge each time it reads the profile: until then, nothing is applied. */
  setProject(merged: Record<string, string>): Promise<void> {
    this.project = merged;
    return this.apply();
  }

  /** The profile's level reaches cspell (§4.2), one change at a time. */
  apply(): Promise<void> {
    return (this.applying = this.applying
      .then(() => this.sync())
      .catch((e) => log.warn(`spelling: ${(e as Error).message}`)));
  }

  private async sync(): Promise<void> {
    if (
      !this.project ||
      !this.core.trusted() ||
      !vscode.extensions.getExtension(CSPELL)
    )
      return;
    const level = spellingLevel(
      this.project,
      readSettings().inspections.severityOverrides,
    );
    const i = vscode.workspace
      .getConfiguration("cSpell")
      .inspect<Record<string, boolean>>("enabledFileTypes");
    const next = severityToCspell(level, i?.workspaceValue);
    if (!next) {
      if (written() && (await undoForeignSetting(FILE_TYPES)))
        log.info(
          `spelling: ${CODE} is ${level ?? "cspell's"} again — java and groovy back to cspell`,
        );
      return;
    }
    if (written()) return;
    // §7.1's default-on rule: never over a java or groovy the developer set.
    if (
      [i?.globalValue, i?.workspaceValue, i?.workspaceFolderValue].some(
        (v) => v && LANGUAGES.some((l) => l in v),
      )
    )
      return;
    await writeForeignSetting("cSpell", "enabledFileTypes", next);
    log.info(
      `spelling: ${CODE} off in the profile — cspell off for java and groovy`,
    );
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

/**
 * `Rename to "<corrected>"` (§4.2, §5.2): cspell's correction for every
 * misspelt part of the identifier, then JDT.LS's rename. Not offered on a
 * comment — JDT has no symbol to rename there — nor when a part has no
 * correction.
 */
class RenameFix implements vscode.CodeActionProvider {
  async provideCodeActions(
    doc: vscode.TextDocument,
    _range: vscode.Range,
    ctx: vscode.CodeActionContext,
  ): Promise<vscode.CodeAction[]> {
    const first = ctx.diagnostics.find((d) => d.source === SOURCE);
    if (!first) return [];
    const id = doc.getWordRangeAtPosition(
      first.range.start,
      /[A-Za-z_$][\w$]*/,
    );
    if (!id) return [];
    const target = await vscode.commands
      .executeCommand<unknown>("vscode.prepareRename", doc.uri, id.start)
      .then(
        (r) => r,
        () => undefined,
      );
    if (!target) return [];
    // The diagnostics as cspell published them, `data` included: one
    // extension host, the same objects (decision 18).
    const fixed = vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => d.source === SOURCE && id.contains(d.range))
      .sort((a, b) => a.range.start.compareTo(b.range.start))
      .map((d) => ({
        word: doc.getText(d.range),
        suggestion: suggestionOf((d as { data?: unknown }).data),
      }));
    const from = doc.getText(id);
    const to = correctedIdentifier(from, fixed);
    if (!to || to === from) {
      log.debug(
        `spelling: no rename for ${from}: ${fixed.map((f) => `${f.word} → ${f.suggestion ?? "no correction"}`).join(", ")}`,
      );
      return [];
    }
    const a = new vscode.CodeAction(
      vscode.l10n.t('Rename to "{0}"', to),
      vscode.CodeActionKind.QuickFix,
    );
    a.diagnostics = [first];
    a.command = {
      command: "batlehub.java.spelling.rename",
      title: a.title,
      arguments: [doc.uri, id.start, to],
    };
    return [a];
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
    vscode.languages.registerCodeActionsProvider(
      { language: "java" },
      new RenameFix(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    // JDT.LS's rename, every reference; one undoable edit.
    vscode.commands.registerCommand(
      "batlehub.java.spelling.rename",
      async (uri: vscode.Uri, at: vscode.Position, to: string) => {
        const edit = await vscode.commands.executeCommand<
          vscode.WorkspaceEdit | undefined
        >("vscode.executeDocumentRenameProvider", uri, at, to);
        if (
          edit &&
          (await vscode.workspace.applyEdit(edit, { isRefactoring: true }))
        )
          log.info(`spelling: renamed to ${to} (${edit.size} file(s))`);
      },
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

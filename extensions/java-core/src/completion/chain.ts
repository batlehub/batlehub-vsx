// Chained-call completion (RFC 0012). JDT.LS already ships
// `ChainCompletionProposalComputer` — a port of JDT UI's Code Recommenders
// chain finder — behind `java.completion.chain.enabled`, off by default and
// buried under thirty `java.completion.*` keys. Appendix A.6 recorded "VS
// Code today: none", which was right about the experience and wrong about the
// mechanism. So phase 1 was one settings write and one measurement; phase 2
// is the bundle delegate the measurement earned (`batlehub.completion.chain`:
// the same `ChainFinder`, with `int`/`String` results, a budget and a rank),
// behind `batlehub.java.completion.chain`, whose default is `"auto"`.
//
// One source of chains at a time (decision 4): in `"shortcut"` the server's
// computer, turned on by the default-on write below; in `"auto"` the
// delegate, and the core takes its own write back so the server's key is
// absent (its default, `false`); in `"off"` neither.
//
// The write is a *default-on* write (RFC 0001 §7.1), and every clause of that
// rule is in `chainPlan` below rather than spread through the caller:
// workspace scope, through the manifest with the previous state recorded,
// announced once with its undo, and never written over a value the user set —
// `true` as much as `false`. A user's `true` is left as unrecorded as a
// user's `false`, so `Remove BatleHub settings` can never delete a value the
// user chose.
import * as vscode from "vscode";
import { readSettings } from "../config";
import type { Core } from "../extension";
import { log } from "../log";
import {
  readManifest,
  undoForeignSetting,
  writeForeignSetting,
} from "../manifest";
import { targetOf } from "../written";

export const CHAIN_KEY = "java.completion.chain.enabled";
export const CHAIN_COMMAND = "batlehub.completion.chain";
export type ChainMode = "auto" | "shortcut" | "off";

/** `workspaceState` key: the user's `Undo`, remembered per workspace. */
const UNDONE = "batlehub.java.chain.undone";
/** `workspaceState` key: the user read the line and kept the setting. */
const ACKNOWLEDGED = "batlehub.java.chain.acknowledged";

/** The scopes `inspect()` reports; `defaultValue` is not one of them — it is the server's own `false`. */
export interface ChainInspect {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

export interface ChainPlan {
  write: boolean;
  /** Take the core's own write back: the delegate (or nothing) replaces the server's computer. */
  unwrite?: boolean;
  /** Whether the Java panel shows the line right now. */
  notice: boolean;
  /** For the channel: why, in the words the guide uses. */
  reason: string;
}

/**
 * Pure. `coreWrote` is "the manifest already has this entry" — the one thing
 * that tells a value the core wrote apart from a value the user set, once
 * both look the same in `inspect()`.
 */
export function chainPlan(o: {
  mode: ChainMode;
  inspected: ChainInspect | undefined;
  coreWrote: boolean;
  undone: boolean;
  acknowledged: boolean;
  trusted: boolean;
}): ChainPlan {
  if (!o.trusted)
    return { write: false, notice: false, reason: "untrusted workspace" };
  if (o.mode !== "shortcut")
    return o.coreWrote
      ? {
          write: false,
          unwrite: true,
          notice: false,
          reason: `batlehub.java.completion.chain is "${o.mode}": the server's computer is not the source of chains`,
        }
      : {
          write: false,
          notice: false,
          reason: `batlehub.java.completion.chain is "${o.mode}"`,
        };
  if (o.undone)
    return {
      write: false,
      notice: false,
      reason: "you undid it in this workspace",
    };
  if (o.coreWrote)
    return {
      write: false,
      notice: !o.acknowledged,
      reason: "already written by BatleHub Java",
    };
  const i = o.inspected;
  const set =
    i?.globalValue !== undefined ||
    i?.workspaceValue !== undefined ||
    i?.workspaceFolderValue !== undefined;
  if (set)
    return {
      write: false,
      notice: false,
      reason: `${CHAIN_KEY} is set by you — a value BatleHub Java did not write is not its to manage`,
    };
  return { write: true, notice: true, reason: "absent at every scope" };
}

const coreWrote = (): boolean =>
  readManifest().entries.some((e) => targetOf(e) === `setting:${CHAIN_KEY}`);

/**
 * The panel line, computed on every push rather than latched when the write
 * happened. A flag set at write time is lost the moment the window reloads —
 * which the newcomer's first minute does, right after this very write — and
 * the one announcement of a setting the core turned on would never be seen.
 */
export function chainNotice(context: vscode.ExtensionContext): boolean {
  return chainPlan({
    mode: readSettings().completion.chain,
    inspected: vscode.workspace.getConfiguration().inspect<boolean>(CHAIN_KEY),
    coreWrote: coreWrote(),
    undone: context.workspaceState.get<boolean>(UNDONE) === true,
    acknowledged: context.workspaceState.get<boolean>(ACKNOWLEDGED) === true,
    trusted: vscode.workspace.isTrusted,
  }).notice;
}

/** The activation write. Idempotent: after the first one `coreWrote` is true. */
export async function applyChainDefault(
  context: vscode.ExtensionContext,
  trusted: boolean,
): Promise<ChainPlan> {
  const plan = chainPlan({
    mode: readSettings().completion.chain,
    inspected: vscode.workspace.getConfiguration().inspect<boolean>(CHAIN_KEY),
    coreWrote: coreWrote(),
    undone: context.workspaceState.get<boolean>(UNDONE) === true,
    acknowledged: context.workspaceState.get<boolean>(ACKNOWLEDGED) === true,
    trusted,
  });
  if (plan.write) {
    await writeForeignSetting("java", "completion.chain.enabled", true);
    log.info(
      `wrote ${CHAIN_KEY} (chain completion on the completion shortcut) — ${plan.reason}`,
    );
  } else if (plan.unwrite) {
    // Not an Undo: switching back to "shortcut" writes it again.
    await undoForeignSetting(CHAIN_KEY);
    log.info(`${CHAIN_KEY} taken back — ${plan.reason}`);
  } else {
    log.debug(`${CHAIN_KEY} not written: ${plan.reason}`);
  }
  return plan;
}

/** `Keep it`: the line has been read. The setting stays; the line does not come back. */
export async function keepChainDefault(
  context: vscode.ExtensionContext,
): Promise<void> {
  await context.workspaceState.update(ACKNOWLEDGED, true);
  log.info(`${CHAIN_KEY}: kept`);
}

/** The panel line's `Undo`: the manifest's removal of that one entry, and never again here. */
export async function undoChainDefault(
  context: vscode.ExtensionContext,
): Promise<void> {
  const undone = await undoForeignSetting(CHAIN_KEY);
  await context.workspaceState.update(UNDONE, true);
  log.info(
    undone
      ? `${CHAIN_KEY} undone: restored to what it was, and not written again in this workspace`
      : `${CHAIN_KEY} was not written by BatleHub Java: nothing to undo`,
  );
}

// ---------------------------------------------------------------- phase 2

/** A row of `batlehub.completion.chain`, already ranked by the bundle. */
export interface ChainRow {
  label: string;
  insertText: string;
  depth: number;
  locality: number;
  kind: "method" | "field";
  rank: number;
}

export interface ChainAnswer {
  rows: ChainRow[];
  truncated: boolean;
  cached?: boolean;
  ms?: number;
}

export type DelegateDecision =
  "delegate" | "not-auto" | "server-key-true" | "absent";

/**
 * Pure. Whether the core's provider answers. A `true` server key means the
 * server's computer is on — the user's own `true` stands (§4.2), so "auto"
 * degrades to "shortcut" rather than doubling the chains.
 */
export function delegateDecision(o: {
  mode: ChainMode;
  commands: string[] | undefined;
  serverKey: unknown;
}): DelegateDecision {
  if (o.mode !== "auto") return "not-auto";
  if (o.serverKey === true) return "server-key-true";
  if (!o.commands?.includes(CHAIN_COMMAND)) return "absent";
  return "delegate";
}

/** §4.3: below 30 ms no depth-2 chain resolves on a real project; 0 is the server's own 3 s. */
export function clampBudget(ms: number): number {
  return ms > 0 && ms < 30 ? 30 : ms;
}

const LOCALITY = ["local", "field", "inherited or static"];

export interface ChainItem {
  label: string;
  insertText: string;
  kind: "method" | "field";
  sortText: string;
  detail: string;
}

/**
 * Pure. The bundle's rank as `sortText`, behind every proposal of JDT's own:
 * those are nine digits (`999999979` for the server's chains), so the prefix
 * `999999999` sorts a chain after any of them of equal fuzzy score —
 * decision 11, a chain never outranks a plain local — and the rank orders
 * the chains among themselves.
 */
export function toItems(answer: ChainAnswer, budgetMs: number): ChainItem[] {
  const items = answer.rows.map((r) => ({
    label: r.label,
    insertText: r.insertText,
    kind: r.kind,
    sortText: `999999999${String(r.rank).padStart(4, "0")}`,
    detail: `chain · ${r.depth} · ${LOCALITY[r.locality] ?? "static"}`,
  }));
  const last = items[items.length - 1];
  if (answer.truncated && last)
    last.detail += ` · chains truncated at ${budgetMs} ms`;
  return items;
}

/** The core's `CompletionItemProvider` for `java`: registered always, answering only in "auto". */
export function registerChainProvider(core: Core): vscode.Disposable {
  const said = new Set<DelegateDecision | "clamped">();
  const once = (k: DelegateDecision | "clamped", line: string) => {
    if (said.has(k)) return;
    said.add(k);
    log.info(line, "JDT");
  };
  return vscode.languages.registerCompletionItemProvider(
    { language: "java", scheme: "file" },
    {
      async provideCompletionItems(doc, pos) {
        const s = readSettings(doc.uri).completion;
        const decision = delegateDecision({
          mode: s.chain,
          commands: core.bundle?.commands,
          serverKey: vscode.workspace
            .getConfiguration(undefined, doc.uri)
            .get(CHAIN_KEY),
        });
        if (decision === "server-key-true")
          once(
            decision,
            `chain completion: ${CHAIN_KEY} is true, so the server's computer answers on the shortcut; batlehub.java.completion.chain "auto" stands down`,
          );
        if (decision === "absent" && core.bundle)
          once(
            decision,
            `chain completion: delegate absent (bundle not loaded, or the server not Standard); set batlehub.java.completion.chain to "shortcut" for the server's computer`,
          );
        if (decision !== "delegate") return [];
        const budget = clampBudget(s.chainBudgetMs);
        if (budget !== s.chainBudgetMs)
          once(
            "clamped",
            `chain completion: chainBudgetMs ${s.chainBudgetMs} raised to 30`,
          );
        const t = Date.now();
        try {
          const answer = await vscode.commands.executeCommand<ChainAnswer>(
            "java.execute.workspaceCommand",
            CHAIN_COMMAND,
            doc.uri.toString(),
            pos.line,
            pos.character,
            budget,
            s.chainMaxDepth,
          );
          if (!answer?.rows) return new vscode.CompletionList([], true);
          log.debug(
            `chain delegate ${Date.now() - t} ms (bundle ${answer.ms ?? "?"} ms${answer.cached ? ", cached" : ""}${answer.truncated ? ", truncated" : ""}): ${answer.rows.length} chain(s)`,
            "JDT",
          );
          const items = toItems(answer, budget).map((i) => {
            const item = new vscode.CompletionItem(
              i.label,
              i.kind === "method"
                ? vscode.CompletionItemKind.Method
                : vscode.CompletionItemKind.Field,
            );
            item.insertText = i.insertText;
            item.sortText = i.sortText;
            item.detail = i.detail;
            return item;
          });
          // Incomplete, so the editor asks again on the next keystroke
          // instead of only refiltering: the bundle's cache is keyed for it.
          return new vscode.CompletionList(items, true);
        } catch (e) {
          // §4.3: a failing delegate means no chain items, never a broken list.
          log.debug(`chain delegate failed: ${(e as Error).message}`, "JDT");
          return [];
        }
      },
    },
    // redhat.java's own space trigger opens the session at `int p = `; a
    // provider not in it is never asked when the `g` arrives — only the
    // session's incomplete ones are.
    " ",
  );
}

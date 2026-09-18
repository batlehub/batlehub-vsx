// Chained-call completion (RFC 0012 phase 1). JDT.LS already ships
// `ChainCompletionProposalComputer` — a port of JDT UI's Code Recommenders
// chain finder — behind `java.completion.chain.enabled`, off by default and
// buried under thirty `java.completion.*` keys. Appendix A.6 recorded "VS
// Code today: none", which was right about the experience and wrong about the
// mechanism. So phase 1 is one settings write and one measurement; the bundle
// delegate of phase 2 is only built if the measurement earns it.
//
// The write is a *default-on* write (RFC 0001 §7.1), and every clause of that
// rule is in `chainPlan` below rather than spread through the caller:
// workspace scope, through the manifest with the previous state recorded,
// announced once with its undo, and never written over a value the user set —
// `true` as much as `false`. A user's `true` is left as unrecorded as a
// user's `false`, so `Remove BatleHub settings` can never delete a value the
// user chose.
import * as vscode from "vscode";
import { log } from "../log";
import {
  readManifest,
  undoForeignSetting,
  writeForeignSetting,
} from "../manifest";
import { targetOf } from "../written";

export const CHAIN_KEY = "java.completion.chain.enabled";

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
  inspected: ChainInspect | undefined;
  coreWrote: boolean;
  undone: boolean;
  acknowledged: boolean;
  trusted: boolean;
}): ChainPlan {
  if (!o.trusted)
    return { write: false, notice: false, reason: "untrusted workspace" };
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

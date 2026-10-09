// RFC 0019 §5.1, §6.4. Activation, in the order of the diagram: restore what a
// previous run left behind, *then* work out what today is.
//
// That ordering is the whole correctness argument. The extension never has to
// reason about whether its last run finished, because it begins by assuming it
// did not: an overlay left behind by a killed pod is removed by the next
// window whatever the date, and an overlay that is still in season is simply
// re-applied a moment later from the same inputs.

import * as vscode from "vscode";
import { activeSeason, dayKey, parseAll, type Season } from "./calendar";
import { apply, describe, readSaved, restore } from "./settings";

/**
 * The six shipped names, as literals so `task ext:l10n:check` can see them.
 * A user's own entry is their own string and is not translated.
 */
const label = (season: Season): string => {
  switch (season.key) {
    case "season.halloween":
      return vscode.l10n.t("Halloween");
    case "season.christmas":
      return vscode.l10n.t("Christmas");
    case "season.newyear":
      return vscode.l10n.t("New Year");
    case "season.aprilfools":
      return vscode.l10n.t("April Fools");
    case "season.musique":
      return vscode.l10n.t("Fête de la Musique");
    case "season.nationale":
      return vscode.l10n.t("Fête Nationale");
    default:
      return season.name;
  }
};

// Only `subscriptions` is used, and saying so is what lets the test call this
// with the mock rather than a whole ExtensionContext.
export async function activate(
  context: Pick<vscode.ExtensionContext, "subscriptions">,
): Promise<void> {
  const log = vscode.window.createOutputChannel("BatleHub Seasons");
  const item = vscode.window.createStatusBarItem(
    "batlehub.seasons",
    vscode.StatusBarAlignment.Right,
    100,
  );
  item.name = "BatleHub Seasons";
  item.command = "batlehub.seasons.disable";
  context.subscriptions.push(log, item);

  const state = readSaved();

  // The one condition that stops the extension acting: a record it cannot
  // trust. Guessing here is how a user's own window.title gets destroyed.
  if ("bad" in state) {
    log.appendLine(
      `batlehub.seasons._saved is unusable (${state.bad}); nothing applied, nothing restored`,
    );
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        "BatleHub Seasons did nothing: the batlehub.seasons._saved setting is unusable, so what to put back is unknown. Fix or delete that setting.",
      ),
    );
    return;
  }

  if ("saved" in state) await restore(state.saved);

  const run = async (): Promise<void> => {
    const config = vscode.workspace.getConfiguration("batlehub.seasons");
    if (!config.get<boolean>("enabled", true)) {
      item.hide();
      return;
    }

    const { seasons: own, errors } = parseAll(config.get<unknown>("events"));
    for (const error of errors) log.appendLine(`skipped: ${error}`);
    if (errors.length)
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "BatleHub Seasons skipped {0} entry/entries of batlehub.seasons.events. See the BatleHub Seasons output for why.",
          errors.length,
        ),
      );

    // The clock, read once (decision 14): no timer, no refocus hook. A season
    // appears the next time the window reloads, and nothing rewrites the
    // user's settings while they work.
    const season = activeSeason(dayKey(new Date()), own);
    if (!season) {
      log.appendLine("no window covers today");
      item.hide();
      return;
    }

    await apply(season, config.get<boolean>("title", true));
    item.text = `${season.glyph} ${label(season)}`;
    item.tooltip = vscode.l10n.t(
      "{0}, until {1}. Click to turn seasons off.",
      label(season),
      season.to,
    );
    item.show();
    log.appendLine(`${season.key} (${season.from} → ${season.to}) applied`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("batlehub.seasons.remove", async () => {
      const current = readSaved();
      if (!("saved" in current)) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t("BatleHub Seasons has nothing written to remove."),
        );
        return;
      }
      const yes = vscode.l10n.t("Remove");
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t("Put back what BatleHub Seasons replaced?"),
        { modal: true, detail: describe(current.saved).join("\n") },
        yes,
      );
      if (answer !== yes) return;
      await restore(current.saved);
      item.hide();
    }),
    vscode.commands.registerCommand("batlehub.seasons.disable", async () => {
      await vscode.workspace
        .getConfiguration("batlehub.seasons")
        .update("enabled", false, vscode.ConfigurationTarget.Global);
      const current = readSaved();
      if ("saved" in current) await restore(current.saved);
      item.hide();
    }),
    // Bounded to the three settings a person edits, and deliberately NOT to
    // `_saved`: re-running on any change would react to this extension's own
    // writes and loop. These three are only ever written by a human or by the
    // command above, whose intent is the same.
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      const mine = ["enabled", "events", "title"].some((k) =>
        event.affectsConfiguration(`batlehub.seasons.${k}`),
      );
      if (!mine) return;
      const current = readSaved();
      if ("saved" in current) await restore(current.saved);
      await run();
    }),
  );

  await run();
}

// Deliberately empty. A reload would flicker the overlay off and on, and the
// startup restore above already covers every case this would have — including
// the ones where it is never called (RFC 0019 §6.4).
export function deactivate(): void {}

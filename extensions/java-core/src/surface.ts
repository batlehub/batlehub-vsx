// The surface of v0.2–v0.3 (RFC 0001 §12 phases 3–4), wired after the
// newcomer core of `activate`: the panel, the menus, the task provider, the
// coexistence prompt, `Report a problem`, the run-configuration editor and
// the flagged IntelliJ import.
import * as vscode from "vscode";
import { JavaTaskProvider, runGoal } from "./build/tasks";
import { proposeCoexistence } from "./coexistence";
import { readSettings } from "./config";
import type { Core } from "./extension";
import { wire } from "./wire";
import { registerGenerate } from "./generate/menu";
import { importIdea, requireTrust } from "./idea/import";
import { registerPanel } from "./panel/panel";
import { registerRefactor } from "./refactor/menu";
import { reportProblem } from "./report/report";
import { editConfigs, newConfig, startConfig } from "./run/editor";
import "./inspections/bridge";

wire((core: Core) => {
  core.context.subscriptions.push(
    ...registerPanel(core),
    ...registerGenerate(core),
    ...registerRefactor(core),
    vscode.tasks.registerTaskProvider(
      JavaTaskProvider.type,
      new JavaTaskProvider(core),
    ),
    vscode.commands.registerCommand("batlehub.java.runGoal", () =>
      runGoal(core),
    ),
    vscode.commands.registerCommand("batlehub.java.report", () =>
      reportProblem(core),
    ),
    vscode.commands.registerCommand("batlehub.java.run.new", () =>
      newConfig(core),
    ),
    vscode.commands.registerCommand("batlehub.java.run.edit", (name?: string) =>
      editConfigs(core, name),
    ),
    vscode.commands.registerCommand(
      "batlehub.java.run.start",
      (name: string, debug?: boolean) => startConfig(name, !debug),
    ),
    vscode.commands.registerCommand("batlehub.java.importIdea", async () => {
      // Trust before the flag prompt: turning the flag on is itself a write.
      if (!(await requireTrust())) return;
      if (!readSettings().experimental.intellijImport) {
        const on = vscode.l10n.t("Turn it on");
        const r = await vscode.window.showInformationMessage(
          vscode.l10n.t(
            "Java: the IntelliJ import is experimental — enable batlehub.java.experimental.intellijImport first.",
          ),
          on,
        );
        if (r !== on) return;
        await vscode.workspace
          .getConfiguration("batlehub.java")
          .update(
            "experimental",
            { ...readSettings().experimental, intellijImport: true },
            vscode.ConfigurationTarget.Workspace,
          );
      }
      await importIdea();
    }),
  );
  // Once per workspace, after the first detection found a build.
  const once = core.onDidDetect((snap) => {
    if (snap.folders.some((f) => f.tool)) {
      once.dispose();
      void proposeCoexistence();
    }
  });
  core.context.subscriptions.push(once);
});

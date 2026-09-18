// Coexistence with the stock Java extensions (RFC 0001 §4.2): once per
// workspace, propose to quiet what they duplicate — through their own
// settings, never by disabling them — remember the answer in
// `batlehub.java.coexistence`, and let the panel's Build tab show what was
// changed and put it back (the manifest records every write).
import * as vscode from "vscode";
import { readSettings, writeWorkspace } from "./config";
import { log } from "./log";
import { writeExtSetting } from "./manifest";

/**
 * What can actually be quieted. The stock extensions expose no setting that
 * hides a view — a view is hidden by the user from its title menu — so what
 * a setting can switch off is what is switched off: the duplicate context
 * menu entries and the explorer sync.
 */
export const STOCK: {
  id: string;
  name: string;
  writes: { section: string; key: string; value: unknown }[];
}[] = [
  {
    id: "vscjava.vscode-maven",
    name: "Maven for Java",
    writes: [
      { section: "maven", key: "showInExplorerContextMenu", value: false },
    ],
  },
  {
    id: "vscjava.vscode-java-dependency",
    name: "Project Manager for Java",
    writes: [
      {
        section: "java.dependency",
        key: "syncWithFolderExplorer",
        value: false,
      },
    ],
  },
  {
    id: "vscjava.vscode-gradle",
    name: "Gradle for Java",
    writes: [{ section: "gradle", key: "showStoppedDaemons", value: false }],
  },
];

export function installedStock(): typeof STOCK {
  return STOCK.filter((s) => !!vscode.extensions.getExtension(s.id));
}

export async function proposeCoexistence(): Promise<void> {
  const present = installedStock();
  const answer = readSettings().coexistence as {
    asked?: boolean;
    quiet?: string[];
  };
  if (!present.length || answer.asked) return;
  const yes = vscode.l10n.t("Quiet them");
  const no = vscode.l10n.t("Keep everything");
  const r = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Java: {0} also installed. BatleHub Java can quiet what they duplicate (context menu entries, explorer sync) through their own settings — reversible from the Java panel.",
      present.map((p) => p.name).join(", "),
    ),
    yes,
    no,
  );
  if (!r) return;
  const quiet: string[] = [];
  if (r === yes) {
    for (const s of present) {
      for (const w of s.writes)
        await writeExtSetting(w.section, w.key, w.value);
      quiet.push(s.id);
    }
    log.info(`coexistence: quieted ${quiet.join(", ")}`);
  }
  await writeWorkspace("coexistence", { asked: true, quiet });
}

/** Undo for one extension, from the panel. */
export async function restoreStock(id: string): Promise<void> {
  const s = STOCK.find((x) => x.id === id);
  if (!s) return;
  for (const w of s.writes)
    await vscode.workspace
      .getConfiguration(w.section)
      .update(w.key, undefined, vscode.ConfigurationTarget.Workspace);
  const cur = readSettings().coexistence as {
    asked?: boolean;
    quiet?: string[];
  };
  await writeWorkspace("coexistence", {
    asked: true,
    quiet: (cur.quiet ?? []).filter((x) => x !== id),
  });
}

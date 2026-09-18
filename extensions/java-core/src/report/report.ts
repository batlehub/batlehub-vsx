// `Java: Report a problem` (RFC 0001 §4.2): one zip built locally —
// versions, the detection snapshot with home paths and user names redacted,
// the container limits, the channels, the workspace-scope `java.*` and
// `batlehub.java.*` settings — never tokens, never source. Then a prefilled
// issue the user reads before submitting; nothing is uploaded without that
// click. `batlehub.java.report.url` overrides the target.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { readSettings } from "../config";
import { redactSnapshot } from "../detect";
import { formatSize } from "../detect/resources";
import type { Core } from "../extension";
import { linesOf } from "../log";
import { anonymise, redact } from "../redact";
import { zip } from "./zip";

const DEFAULT_ISSUES = "https://github.com/batleforc/batlehub-vsx/issues/new";

export function versions(): Record<string, string> {
  const v = (id: string) =>
    String(
      (
        vscode.extensions.getExtension(id)?.packageJSON as
          { version?: string } | undefined
      )?.version ?? "absent",
    );
  return {
    editor: `${vscode.env.appName} ${vscode.version} (${vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop"}, ${vscode.env.remoteName ?? "local"})`,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    "batlehub.java-core": v("batlehub.java-core"),
    "batlehub.java-groovy": v("batlehub.java-groovy"),
    "batlehub.batlehub-vsx": v("batlehub.batlehub-vsx"),
    "redhat.java": v("redhat.java"),
    "vscjava.vscode-java-debug": v("vscjava.vscode-java-debug"),
    "vscjava.vscode-java-test": v("vscjava.vscode-java-test"),
  };
}

/** Workspace-scope values of the two prefixes, redacted. */
export function workspaceSettings(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const section of ["java", "batlehub.java"]) {
    const c = vscode.workspace.getConfiguration(section);
    const walk = (obj: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === "object" && !Array.isArray(v))
          walk(v as Record<string, unknown>, `${prefix}${k}.`);
        else {
          const i = c.inspect(`${prefix}${k}`);
          if (i?.workspaceValue !== undefined)
            out[`${section}.${prefix}${k}`] = JSON.parse(
              redact(JSON.stringify(i.workspaceValue)),
            );
        }
      }
    };
    walk(JSON.parse(JSON.stringify(c)) as Record<string, unknown>, "");
  }
  return out;
}

/** Pure enough to test: the issue URL with title and body (issue forms take them as query params). */
export function issueUrl(base: string, title: string, body: string): string {
  const u = new URL(base || DEFAULT_ISSUES);
  if (!base) u.searchParams.set("template", "java-problem.yml");
  u.searchParams.set("title", title);
  u.searchParams.set("body", body);
  return u.toString();
}

export async function reportProblem(core: Core): Promise<void> {
  const snap = core.snapshot();
  const home = os.homedir();
  const user = os.userInfo().username;
  const anon = (s: string) => anonymise(redact(s), home, user);
  const ver = versions();
  const summary = [
    ...Object.entries(ver).map(([k, v]) => `${k}: ${v}`),
    `container limit: ${snap?.resources.limit ? formatSize(snap.resources.limit) : "none"}; planned: ${snap ? formatSize(snap.resources.planned) : "?"}`,
    `runtimes: ${snap?.runtimes.map((r) => `${r.name} (${r.source})`).join(", ") || "none"}`,
    `folders: ${snap?.folders.map((f) => `${f.tool ?? "plain"}${f.required ? ` wants ${f.required.min}` : ""} → ${f.resolution.runtime?.name ?? "none"}`).join("; ") || "none"}`,
    `server mode: ${core.server.mode ?? "unknown"}; trusted: ${core.trusted()}`,
  ].join("\n");
  const entries = [
    { name: "versions.json", data: JSON.stringify(ver, null, 2) },
    {
      name: "snapshot.json",
      data: snap ? redactSnapshot(snap, home, user) : "{}",
    },
    {
      name: "settings.workspace.json",
      data: anon(JSON.stringify(workspaceSettings(), null, 2)),
    },
    ...Object.entries(linesOf()).map(([c, lines]) => ({
      name: `log-${c}.txt`,
      data: anon(lines.join("\n")),
    })),
  ];
  const dir = path.join(os.tmpdir(), "batlehub-java");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(
    dir,
    `report-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`,
  );
  fs.writeFileSync(file, zip(entries), { mode: 0o600 });
  const body = `<!-- Prefilled by Java: Report a problem. Read it before submitting; attach ${path.basename(file)} if you want. -->\n\n**What happened**\n\n\n**Environment**\n\`\`\`\n${anon(summary)}\n\`\`\`\n`;
  const url = issueUrl(readSettings().reportUrl, "Java: ", body);
  const open = vscode.l10n.t("Open the issue");
  const reveal = vscode.l10n.t("Show the zip");
  const r = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Java: report written to {0} (versions, redacted snapshot, logs — no token, no source). Nothing is sent until you submit the issue.",
      file,
    ),
    open,
    reveal,
  );
  if (r === open) await vscode.env.openExternal(vscode.Uri.parse(url));
  if (r === reveal)
    await vscode.commands
      .executeCommand("revealFileInOS", vscode.Uri.file(file))
      .then(undefined, () => vscode.window.showInformationMessage(file));
}

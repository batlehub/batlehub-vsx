// Import from IntelliJ (RFC 0001 decision 33, RFC 0007, behind
// `experimental.intellijImport`). Two kinds so far: run configurations
// (`.idea/runConfigurations/*.xml` and `workspace.xml`'s RunManager →
// `launch.json`) and the code style (`.idea/codeStyles/` → an Eclipse
// formatter profile plus the settings `redhat.java` reads).
//
// The rules that hold for every kind, now and as the others land:
//   - **trust first**. `.idea/` is workspace-controlled input and every
//     target changes what the editor does, so an untrusted workspace stops
//     the whole command before a single file is read (RFC 0007 §4.3);
//   - **the plan is a diff**. `planDiffs` is pure and returns, per target,
//     the file's current content against what `Write` would leave. Nothing
//     is on disk until the user says so;
//   - **every write goes through the manifest**, under one timestamp, so
//     `Remove BatleHub settings` undoes an import as one thing;
//   - **`.idea/` is opened read-only.** There is no path here that writes
//     under it.
// The converters are pure and live beside this file; this module is the only
// one that touches the file system.
import * as fs from "node:fs";
import * as path from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import * as vscode from "vscode";
import { log } from "../log";
import { splitKey, writeForeignSetting, writeOwnedFile } from "../manifest";
import type { JavaLaunch } from "../run/configs";
import { upsertConfig } from "../run/configs";
import { writeAll } from "../run/editor";
import {
  convertCodeStyle,
  parseProjectXml,
  PROFILE_NAME,
  PROFILE_PATH,
  settings as codeStyleSettings,
  type Skipped,
  toEclipseProfile,
  usesPerProjectSettings,
} from "./codestyle";

export interface ImportPlan {
  configs: JavaLaunch[];
  skipped: { name: string; type: string; reason: string }[];
}

const attr = (xml: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1];
const option = (xml: string, name: string): string | undefined =>
  new RegExp(`<option\\s+name="${name}"\\s+value="([^"]*)"`).exec(xml)?.[1];
const unescape = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Every `<configuration …>…</configuration>` of a file (a run configuration file holds one; workspace.xml several). */
export function configurationsOf(xml: string): string[] {
  return [
    ...xml.matchAll(
      /<configuration\b[^>]*?(?:\/>|>[\s\S]*?<\/configuration>)/g,
    ),
  ]
    .map((m) => m[0])
    .filter((c) => !/\bdefault="true"/.test(c.slice(0, c.indexOf(">"))));
}

export function convert(xml: string): {
  config?: JavaLaunch;
  skipped?: { name: string; type: string; reason: string };
} {
  const head = xml.slice(0, xml.indexOf(">"));
  const name = unescape(attr(head, "name") ?? "unnamed");
  const type = attr(head, "type") ?? "?";
  const env = Object.fromEntries(
    [...xml.matchAll(/<env\s+name="([^"]*)"\s+value="([^"]*)"/g)].map((m) => [
      unescape(m[1]!),
      unescape(m[2]!),
    ]),
  );
  const module =
    attr(xml, "MODULE_NAME") ?? /<module\s+name="([^"]*)"/.exec(xml)?.[1];
  const cwd = option(xml, "WORKING_DIRECTORY")
    ?.replace(/\$PROJECT_DIR\$/g, "${workspaceFolder}")
    .replace(/\$MODULE_DIR\$/g, "${workspaceFolder}");
  const vm = option(xml, "VM_PARAMETERS");
  const args = option(xml, "PROGRAM_PARAMETERS");
  const base: Partial<JavaLaunch> = { batlehub: { template: `idea:${type}` } };
  if (Object.keys(env).length) base.env = env;
  if (cwd) base.cwd = cwd;
  if (vm) base.vmArgs = unescape(vm);
  if (args) base.args = unescape(args);
  if (module) base.projectName = module;
  if (type === "Application") {
    const mainClass = option(xml, "MAIN_CLASS_NAME");
    if (!mainClass)
      return { skipped: { name, type, reason: "no MAIN_CLASS_NAME" } };
    return {
      config: {
        type: "java",
        name,
        request: "launch",
        mainClass,
        ...base,
      } as JavaLaunch,
    };
  }
  if (type === "JUnit") {
    // The stock debugger has no JUnit launch; the test runner runs tests.
    // A JUnit configuration becomes a launch of the JUnit console launcher
    // only when it names a class, which the test runner can then run; the
    // rest is reported.
    const cls = option(xml, "MAIN_CLASS_NAME");
    if (!cls)
      return {
        skipped: {
          name,
          type,
          reason:
            "JUnit configuration without a class (package/pattern scope): run it from the Test view",
        },
      };
    return {
      config: {
        type: "java",
        name,
        request: "launch",
        mainClass: "org.junit.platform.console.ConsoleLauncher",
        args: `--select-class ${cls}`,
        ...base,
        batlehub: { template: `idea:JUnit` },
      } as JavaLaunch,
    };
  }
  if (type === "Remote") {
    const host = option(xml, "HOST") ?? "localhost";
    const port = Number(option(xml, "PORT") ?? 5005);
    return {
      config: {
        type: "java",
        name,
        request: "attach",
        hostName: host,
        port,
        ...base,
      } as JavaLaunch,
    };
  }
  return {
    skipped: {
      name,
      type,
      reason: `type ${type} has no launch.json equivalent in this phase`,
    },
  };
}

export function plan(files: { path: string; xml: string }[]): ImportPlan {
  const out: ImportPlan = { configs: [], skipped: [] };
  for (const f of files) {
    for (const c of configurationsOf(f.xml)) {
      const r = convert(c);
      if (r.config) out.configs.push(r.config);
      else if (r.skipped) out.skipped.push(r.skipped);
    }
  }
  return out;
}

export function readIdea(root: string): { path: string; xml: string }[] {
  const out: { path: string; xml: string }[] = [];
  const dir = path.join(root, ".idea", "runConfigurations");
  try {
    for (const n of fs.readdirSync(dir).filter((n) => n.endsWith(".xml")))
      out.push({
        path: path.join(dir, n),
        xml: fs.readFileSync(path.join(dir, n), "utf8"),
      });
  } catch {
    /* no directory */
  }
  try {
    const ws = fs.readFileSync(
      path.join(root, ".idea", "workspace.xml"),
      "utf8",
    );
    const rm = /<component\s+name="RunManager"[^>]*>[\s\S]*?<\/component>/.exec(
      ws,
    )?.[0];
    if (rm)
      out.push({ path: path.join(root, ".idea", "workspace.xml"), xml: rm });
  } catch {
    /* no workspace.xml */
  }
  return out;
}

// --- the plan --------------------------------------------------------------

export type ScopeId = "runs" | "codestyle";

export interface CodeStylePlan {
  /** The IDEA scheme's name, for the report; the profile is always PROFILE_NAME. */
  scheme: string;
  profileXml: string;
  settings: Record<string, unknown>;
  mapped: string[];
  skipped: Skipped[];
}

export interface FullPlan {
  runs?: ImportPlan;
  codestyle?: CodeStylePlan;
  /** A kind that could not be read at all: it is skipped, the others proceed (§4.3). */
  errors: { scope: ScopeId; reason: string }[];
}

/** One target of the plan: what is there now against what `Write` would leave. */
export interface Diff {
  /** Workspace-relative, as the diff tab's title shows it. */
  target: string;
  before: string;
  after: string;
}

/**
 * `.idea/codeStyles/` → the profile and the settings. Pure over the two files'
 * text; `undefined` for `configXml` means the file is absent, which IDEA reads
 * as "use the project style".
 */
export function planCodeStyle(
  projectXml: string,
  configXml: string | undefined,
): CodeStylePlan | { error: string } {
  // IDEA itself ignores a project style that is switched off; importing it
  // would enforce a style the IDEA users do not see (§4.3).
  if (usesPerProjectSettings(configXml) === false)
    return {
      error:
        "codeStyleConfig.xml says USE_PER_PROJECT_SETTINGS=false — IDEA ignores this project style, so importing it would enforce a style your IDEA users do not have",
    };
  let style;
  try {
    style = parseProjectXml(projectXml);
  } catch (e) {
    return { error: `.idea/codeStyles/Project.xml: ${(e as Error).message}` };
  }
  const converted = convertCodeStyle(style);
  return {
    scheme: style.name,
    profileXml: toEclipseProfile(converted.profile, PROFILE_NAME),
    settings: codeStyleSettings(style, PROFILE_NAME),
    mapped: converted.mapped,
    skipped: converted.skipped,
  };
}

const SETTINGS_PATH = ".vscode/settings.json";
const LAUNCH_PATH = ".vscode/launch.json";
const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

/**
 * The plan as a diff per target — pure, so the modal, the diff editors and
 * the write all read the same strings. `current` maps each target to what is
 * on disk (absent → undefined, shown as an empty left-hand side).
 *
 * The settings file is *simulated* here with the same jsonc edits the editor
 * would make. The write itself goes through the configuration API (it holds
 * the lock and records the previous value), so the values land exactly as
 * shown while the file's own formatting stays the editor's business.
 */
export function planDiffs(
  plan: FullPlan,
  current: Record<string, string | undefined>,
): Diff[] {
  const out: Diff[] = [];
  if (plan.runs?.configs.length) {
    let after = current[LAUNCH_PATH];
    for (const c of plan.runs.configs) after = upsertConfig(after, c);
    out.push({
      target: LAUNCH_PATH,
      before: current[LAUNCH_PATH] ?? "",
      after: after ?? "",
    });
  }
  if (plan.codestyle) {
    out.push({
      target: PROFILE_PATH,
      before: current[PROFILE_PATH] ?? "",
      after: plan.codestyle.profileXml,
    });
    let text = current[SETTINGS_PATH]?.trim()
      ? current[SETTINGS_PATH]!
      : "{}\n";
    for (const [k, v] of Object.entries(plan.codestyle.settings))
      text = applyEdits(text, modify(text, [k], v, FORMAT));
    out.push({
      target: SETTINGS_PATH,
      before: current[SETTINGS_PATH] ?? "",
      after: text,
    });
  }
  return out;
}

/** The modal's body: a header line per kind with its counts, then the `+`/`-` lines. */
export function summary(plan: FullPlan): string[] {
  const lines: string[] = [];
  if (plan.runs) {
    lines.push(
      `run configurations   ${plan.runs.configs.length} imported, ${plan.runs.skipped.length} skipped`,
    );
    for (const c of plan.runs.configs)
      lines.push(
        `  + ${c.name} (${c.request}${c.mainClass ? ` ${c.mainClass}` : ""})`,
      );
    for (const s of plan.runs.skipped)
      lines.push(`  - ${s.name} [${s.type}]: ${s.reason}`);
  }
  const cs = plan.codestyle;
  if (cs) {
    const total = cs.mapped.length + cs.skipped.length;
    lines.push(
      `code style           ${cs.mapped.length} of ${total} options mapped, from scheme "${cs.scheme}"`,
    );
    lines.push(`  → ${PROFILE_PATH}`);
    for (const k of Object.keys(cs.settings)) lines.push(`  → ${k}`);
    for (const s of cs.skipped) lines.push(`  - ${s.option}: ${s.reason}`);
  }
  for (const e of plan.errors) lines.push(`! ${e.scope}: ${e.reason}`);
  return lines;
}

// --- reading `.idea/`, and writing everywhere else --------------------------

const readIfPresent = (p: string): string | undefined => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

export function readPlan(root: string, scopes: Set<ScopeId>): FullPlan {
  const out: FullPlan = { errors: [] };
  if (scopes.has("runs")) out.runs = plan(readIdea(root));
  if (scopes.has("codestyle")) {
    const dir = path.join(root, ".idea", "codeStyles");
    const projectXml = readIfPresent(path.join(dir, "Project.xml"));
    if (!projectXml)
      out.errors.push({
        scope: "codestyle",
        reason: "no .idea/codeStyles/Project.xml",
      });
    else {
      const r = planCodeStyle(
        projectXml,
        readIfPresent(path.join(dir, "codeStyleConfig.xml")),
      );
      if ("error" in r)
        out.errors.push({ scope: "codestyle", reason: r.error });
      else out.codestyle = r;
    }
  }
  return out;
}

const empty = (p: FullPlan) =>
  !p.runs?.configs.length && !p.runs?.skipped.length && !p.codestyle;

/** The right-hand side of every diff, served from memory: nothing is on disk before `Write`. */
const SCHEME = "batlehub-java-idea-import";
class Proposed implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  // No `onDidChange`: the content is set before the diff opens and never
  // changes while it is open — an emitter nothing ever fires is a leak with
  // a comment on it.
  set(diffs: Diff[]): void {
    this.texts.clear();
    for (const d of diffs) this.texts.set(d.target, d.after);
  }
  uri(target: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: `/${target}` });
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.path.replace(/^\//, "")) ?? "";
  }
}
const proposed = new Proposed();
let registered: vscode.Disposable | undefined;

async function showDiffs(
  folder: vscode.WorkspaceFolder,
  diffs: Diff[],
): Promise<void> {
  registered ??= vscode.workspace.registerTextDocumentContentProvider(
    SCHEME,
    proposed,
  );
  proposed.set(diffs);
  for (const d of diffs)
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(path.join(folder.uri.fsPath, d.target)),
      proposed.uri(d.target),
      `${d.target} ← IntelliJ import`,
      { preview: false },
    );
}

async function writePlan(
  folder: vscode.WorkspaceFolder,
  plan: FullPlan,
  diffs: Diff[],
): Promise<void> {
  const launch = diffs.find((d) => d.target === LAUNCH_PATH);
  if (launch) writeAll(folder, launch.after);
  if (plan.codestyle) {
    writeOwnedFile(
      path.join(folder.uri.fsPath, ...PROFILE_PATH.split("/")),
      plan.codestyle.profileXml,
    );
    for (const [key, value] of Object.entries(plan.codestyle.settings)) {
      const { section, leaf } = splitKey(key);
      await writeForeignSetting(section, leaf, value);
    }
  }
}

/**
 * §4.3: the gate is the editor's, and it stops the whole command — not one
 * kind. It runs before anything else the command does, including the
 * experimental-flag prompt, because that prompt *writes a setting*: a gate
 * that lets a write happen first is not a gate.
 */
export async function requireTrust(): Promise<boolean> {
  if (vscode.workspace.isTrusted) return true;
  const manage = vscode.l10n.t("Manage Workspace Trust");
  const r = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      "Java: the IntelliJ import reads .idea/, which this workspace controls, and writes settings that change what the editor does. Trust this workspace first.",
    ),
    manage,
  );
  if (r === manage)
    await vscode.commands.executeCommand("workbench.trust.manage");
  return false;
}

export async function importIdea(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  if (!(await requireTrust())) return;
  const KINDS: { id: ScopeId; label: string }[] = [
    { id: "runs", label: vscode.l10n.t("Run configurations") },
    { id: "codestyle", label: vscode.l10n.t("Code style") },
  ];
  const picked = await vscode.window.showQuickPick(
    KINDS.map((k) => ({ ...k, picked: true })),
    {
      canPickMany: true,
      title: vscode.l10n.t("Import from IntelliJ: what to read from .idea/"),
    },
  );
  if (!picked?.length) return;
  const plan = readPlan(folder.uri.fsPath, new Set(picked.map((p) => p.id)));
  if (empty(plan) && !plan.errors.length) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Java: nothing to import from .idea/ for the kinds you picked.",
      ),
    );
    return;
  }
  const current: Record<string, string | undefined> = {};
  for (const t of [LAUNCH_PATH, SETTINGS_PATH, PROFILE_PATH])
    current[t] = readIfPresent(path.join(folder.uri.fsPath, ...t.split("/")));
  const diffs = planDiffs(plan, current);
  const lines = summary(plan);
  const show = vscode.l10n.t("Show diff");
  const go = vscode.l10n.t("Write");
  for (;;) {
    const r = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Java: IntelliJ import plan\n\n{0}\n\nNothing in .idea/ is modified.",
        lines.join("\n"),
      ),
      { modal: true },
      ...(diffs.length ? [show, go] : [go]),
    );
    if (r === show) {
      await showDiffs(folder, diffs);
      continue; // the plan comes back, so the diff is a look and not a choice
    }
    if (r !== go) return;
    break;
  }
  await writePlan(folder, plan, diffs);
  log.info(`IntelliJ import:\n${lines.join("\n")}`);
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Java: imported from IntelliJ — {0} target(s) written. See the BatleHub Java log for what was skipped.",
      diffs.length,
    ),
  );
}

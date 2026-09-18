// Import from IntelliJ (RFC 0001 §4.2, decision 33, behind
// `experimental.intellijImport`): `.idea/runConfigurations/*.xml` and
// `workspace.xml`'s RunManager → `launch.json` entries of type `java`
// (Application, JUnit, Remote). Nothing in `.idea/` is modified; a report
// lists what was skipped. The parser is pure.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { log } from "../log";
import type { JavaLaunch } from "../run/configs";
import { upsertConfig } from "../run/configs";
import { readAll, writeAll } from "../run/editor";

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

export async function importIdea(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const p = plan(readIdea(folder.uri.fsPath));
  if (!p.configs.length && !p.skipped.length) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Java: no .idea/runConfigurations or RunManager entries found.",
      ),
    );
    return;
  }
  const lines = [
    ...p.configs.map(
      (c) =>
        `+ ${c.name} (${c.request}${c.mainClass ? ` ${c.mainClass}` : ""})`,
    ),
    ...p.skipped.map((s) => `- ${s.name} [${s.type}]: ${s.reason}`),
  ];
  const go = vscode.l10n.t("Write {0} to launch.json", p.configs.length);
  const r = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Java: IntelliJ import plan\n\n{0}\n\nNothing in .idea/ is modified.",
      lines.join("\n"),
    ),
    { modal: true },
    go,
  );
  if (r !== go) return;
  let text = readAll(folder).text;
  for (const c of p.configs) text = upsertConfig(text, c);
  writeAll(folder, text!);
  log.info(
    `IntelliJ import: ${p.configs.length} written, ${p.skipped.length} skipped\n${lines.join("\n")}`,
  );
  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      "Java: {0} run configuration(s) imported; {1} skipped (see the log).",
      p.configs.length,
      p.skipped.length,
    ),
  );
}

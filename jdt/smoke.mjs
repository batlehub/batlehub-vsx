#!/usr/bin/env node
// The proof for the bundle (RFC 0001 §12 phase 6): a headless JDT.LS — the
// pinned redhat.java's own server, from the VSIX `jdt/deps.sh` unpacked —
// started with our jar in `initializationOptions.bundles`, then
// `batlehub.ping`, `batlehub.inspections.list` on Greeter.java and
// `batlehub.generate.accessors` on Person.java of the maven-multi fixture,
// and `batlehub.completion.chain` on Main.java (RFC 0012 use case 6).
// Prints what came back; exits non-zero when any of the three is missing.
// The server itself is started by `engine/launch.ts` (RFC 0002 phase 1).
//
//   node jdt/smoke.mjs        (JDK 21 as `java` on PATH; `task jdt:smoke` wraps mise)
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileUri as uri, launch } from "../engine/launch.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = process.env.REDHAT_JAVA_VERSION ?? "1.56.0";
const CACHE = process.env.HEAVY_CACHE ?? path.join(process.env.HOME, ".cache", "batlehub-heavy");
const SERVER = path.join(CACHE, `redhat.java-${VERSION}`, "extension", "server");
const JAR = path.resolve(REPO, "extensions/java-core/jdt/batlehub-jdt-core.jar");
if (!existsSync(SERVER)) throw new Error(`no unpacked redhat.java at ${SERVER}: run 'task jdt:deps'`);
if (!existsSync(JAR)) throw new Error(`no ${JAR}: run 'task jdt:build'`);

const work = mkdtempSync(path.join(tmpdir(), "batlehub-jdt-smoke-"));
const ws = path.join(work, "maven-multi");
cpSync(path.join(REPO, "tests/heavy/fixtures/maven-multi"), ws, { recursive: true });
const server = await launch({
  server: SERVER,
  workspace: ws,
  data: path.join(work, "data"),
  bundles: [JAR],
  settings: { java: { import: { gradle: { enabled: false } }, configuration: { updateBuildConfiguration: "automatic" } } },
});
const { request, notify } = server;

let ok = true;
try {
  const commands = server.init.capabilities?.executeCommandProvider?.commands ?? [];
  console.log(`initialize: ${commands.length} commands advertised; batlehub.* = ${JSON.stringify(commands.filter((c) => c.startsWith("batlehub.")))}`);
  // Wait for the service to be ready (import done) — status notifications carry it.
  const ready = await server.ready(300000);
  console.log(`status after ${Math.round(ready.ms / 1000)} s: ${ready.statuses.join(", ")}`);

  const ping = await request("workspace/executeCommand", { command: "batlehub.ping", arguments: [] });
  console.log("batlehub.ping →", JSON.stringify(ping));
  if (!ping?.version) ok = false;

  const greeter = path.join(ws, "core/src/main/java/com/acme/core/Greeter.java");
  notify("textDocument/didOpen", { textDocument: { uri: uri(greeter), languageId: "java", version: 1, text: readFileSync(greeter, "utf8") } });
  const list = await request("workspace/executeCommand", { command: "batlehub.inspections.list", arguments: [uri(greeter)] });
  console.log(`batlehub.inspections.list(Greeter.java) → ${list.length} finding(s):`);
  for (const f of list) console.log(`  ${f.code} @${f.range.start.line + 1}:${f.range.start.character + 1} ${f.message}${f.fixTitle ? ` [fix: ${f.fixTitle}]` : ""}`);
  if (!list.some((f) => f.code === "unused/privateField") || !list.some((f) => f.code === "collections/sizeIsZero") || !list.some((f) => f.code === "performance/stringConcatInLoop")) ok = false;

  const fix = await request("workspace/executeCommand", { command: "batlehub.inspections.fixAll", arguments: [uri(greeter), "sizeIsZero"] });
  const fixEdits = fix?.changes?.[uri(greeter)] ?? [];
  console.log(`batlehub.inspections.fixAll(Greeter.java, sizeIsZero) → ${fixEdits.length} edit(s): ${JSON.stringify(fixEdits)}`);
  if (!fixEdits.some((e) => /isEmpty/.test(e.newText))) ok = false;

  // RFC 0002 §5.3: `batlehub.rename` through JDT.LS's own RenameHandler — the
  // spike of open question 1. Greeter#all is declared at 14:19 and called
  // from Main.java (another module) and MainTest.java.
  const renamed = await request("workspace/executeCommand", { command: "batlehub.rename", arguments: [uri(greeter), 13, 18, "everyone"] });
  const renamedFiles = Object.keys(renamed?.changes ?? {}).map((u) => path.relative(ws, fileURLToPath(u))).sort();
  console.log(`batlehub.rename(Greeter#all → everyone) → ${renamedFiles.length} file(s): ${renamedFiles.join(", ")}${renamed?.documentChanges ? " (documentChanges)" : ""}`);
  if (renamedFiles.length !== 3 || !renamedFiles.some((f) => f.endsWith("app/Main.java"))) ok = false;
  // Phase 4: the symbol form resolves in the Java model; a file's primary
  // type is refused (its rename moves the file); an unknown type is named.
  const bySymbol = await request("workspace/executeCommand", { command: "batlehub.rename", arguments: ["com.acme.core.Greeter#all", "everyone"] });
  const symbolFiles = Object.keys(bySymbol?.changes ?? {}).map((u) => path.relative(ws, fileURLToPath(u))).sort();
  console.log(`batlehub.rename(com.acme.core.Greeter#all → everyone) → ${symbolFiles.length} file(s): ${symbolFiles.join(", ")}`);
  if (JSON.stringify(symbolFiles) !== JSON.stringify(renamedFiles)) ok = false;
  const refusal = async (args) => request("workspace/executeCommand", { command: "batlehub.rename", arguments: args }).then(() => "no refusal", (e) => e.message);
  const typeRefused = await refusal(["com.acme.core.Greeter", "Hello"]);
  const unknown = await refusal(["com.acme.core.Nope#x", "y"]);
  console.log(`batlehub.rename(com.acme.core.Greeter → Hello) → ${typeRefused}`);
  console.log(`batlehub.rename(com.acme.core.Nope#x) → ${unknown}`);
  if (!/moves its file \(Greeter\.java\)/.test(typeRefused) || !/no type com\.acme\.core\.Nope/.test(unknown)) ok = false;

  const person = path.join(ws, "core/src/main/java/com/acme/core/Person.java");
  const params = { textDocument: { uri: uri(person) }, range: { start: { line: 4, character: 4 }, end: { line: 4, character: 4 } }, context: { diagnostics: [] }, kind: 0 };
  const gen = await request("workspace/executeCommand", { command: "batlehub.generate.accessors", arguments: [params, JSON.stringify({ getterPrefix: "get", booleanPrefix: "is", fluentSetters: false, finalFields: "keepSetters", kind: 0 })] });
  const edits = gen?.changes?.[uri(person)] ?? [];
  console.log(`batlehub.generate.accessors(Person.java) → ${edits.length} edit(s); newText:\n${edits.map((e) => e.newText).join("")}`);
  const all = edits.map((e) => e.newText).join("");
  if (!/getName\(\)/.test(all) || !/setAge\(int age\)/.test(all)) ok = false;

  // RFC 0012 use case 6: the chain delegate, on an unsaved Main.java (the
  // working copy is what the command reads). An `int` and a `String` — the two
  // expected types the stock computer refuses — reached from a field.
  const main = path.join(ws, "app/src/main/java/com/acme/app/Main.java");
  const probe = ["package com.acme.app;", "", "public class Main {", "    private final Config config = new Config();", "", "    void m() {", "        int fallback = 1;", "        int port = get", "        String host = ", "    }", "}", ""];
  notify("textDocument/didOpen", { textDocument: { uri: uri(main), languageId: "java", version: 1, text: probe.join("\n") } });
  const chains = async (line, character) => request("workspace/executeCommand", { command: "batlehub.completion.chain", arguments: [uri(main), line, character, 2000, 3] });
  const intChains = await chains(7, probe[7].length);
  console.log(`batlehub.completion.chain(int port = get|) → ${JSON.stringify(intChains)}`);
  const strChains = await chains(8, probe[8].length);
  console.log(`batlehub.completion.chain(String host = |) → ${JSON.stringify(strChains)}`);
  if (intChains?.rows?.[0]?.label !== "config.getServer().getPort()" || intChains.truncated) ok = false;
  if (!strChains?.rows?.some((r) => r.label === "config.getServer().getHost()")) ok = false;
  if (!ping?.commands?.includes("batlehub.completion.chain")) ok = false;
  // The heavy half's document: `config` a local of a static `main`, the caret
  // mid-block with the next statement unterminated below it. `String[] args`
  // once filled the finder's cap with chains no row can use.
  const local = ["package com.acme.app;", "", "public class Main {", "    public static void main(String[] args) {", "        Config config = new Config();", "        int p0 = g", "        Config other = new Config();", "    }", "}", ""];
  notify("textDocument/didChange", { textDocument: { uri: uri(main), version: 2 }, contentChanges: [{ text: local.join("\n") }] });
  const localChains = await chains(5, local[5].length);
  console.log(`batlehub.completion.chain(local; int p0 = g|) → ${JSON.stringify(localChains)}`);
  if (localChains?.rows?.[0]?.label !== "config.getServer().getPort()") ok = false;

} catch (e) {
  ok = false;
  console.error("smoke failed:", e.message);
  console.error(server.stderr().split("\n").filter((l) => /batlehub|Exception|ERROR|resolv/i.test(l)).slice(0, 40).join("\n"));
} finally {
  await server.stop();
  rmSync(work, { recursive: true, force: true });
}
console.log(ok ? "SMOKE-OK" : "SMOKE-FAILED");
process.exit(ok ? 0 : 1);

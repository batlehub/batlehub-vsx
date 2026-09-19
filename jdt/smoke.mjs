#!/usr/bin/env node
// The proof for the bundle (RFC 0001 §12 phase 6): a headless JDT.LS — the
// pinned redhat.java's own server, from the VSIX `jdt/deps.sh` unpacked —
// started with our jar in `initializationOptions.bundles`, then
// `batlehub.ping`, `batlehub.inspections.list` on Greeter.java and
// `batlehub.generate.accessors` on Person.java of the maven-multi fixture.
// Prints what came back; exits non-zero when any of the three is missing.
//
//   node jdt/smoke.mjs        (JDK 21 as `java` on PATH; `task jdt:smoke` wraps mise)
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = process.env.REDHAT_JAVA_VERSION ?? "1.56.0";
const CACHE = process.env.HEAVY_CACHE ?? path.join(process.env.HOME, ".cache", "batlehub-heavy");
const SERVER = path.join(CACHE, `redhat.java-${VERSION}`, "extension", "server");
const JAR = path.resolve(REPO, "extensions/java-core/jdt/batlehub-jdt-core.jar");
if (!existsSync(SERVER)) throw new Error(`no unpacked redhat.java at ${SERVER}: run 'task jdt:deps'`);
if (!existsSync(JAR)) throw new Error(`no ${JAR}: run 'task jdt:build'`);
const launcher = readdirSync(path.join(SERVER, "plugins")).find((f) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(f));

const work = mkdtempSync(path.join(tmpdir(), "batlehub-jdt-smoke-"));
const ws = path.join(work, "maven-multi");
cpSync(path.join(REPO, "tests/heavy/fixtures/maven-multi"), ws, { recursive: true });
const data = path.join(work, "data");

const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", "java") : "java";
const proc = spawn(java, [
  "-Declipse.application=org.eclipse.jdt.ls.core.id1",
  "-Dosgi.bundles.defaultStartLevel=4",
  "-Declipse.product=org.eclipse.jdt.ls.core.product",
  "-Dlog.level=ALL",
  "-Xmx1G",
  "-jar", path.join(SERVER, "plugins", launcher),
  "-configuration", path.join(SERVER, "config_linux"),
  "-data", data,
], { stdio: ["pipe", "pipe", "pipe"] });
const stderr = [];
proc.stderr.on("data", (d) => stderr.push(String(d)));

// Minimal JSON-RPC over stdio.
let buf = Buffer.alloc(0);
const pending = new Map();
const notes = [];
let id = 0;
proc.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const i = buf.indexOf("\r\n\r\n");
    if (i < 0) return;
    const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, i).toString())?.[1]);
    if (buf.length < i + 4 + len) return;
    const msg = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString());
    buf = buf.subarray(i + 4 + len);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method && msg.id !== undefined) {
      // A server → client request (client/registerCapability, workspace/configuration…): answer empty.
      send({ jsonrpc: "2.0", id: msg.id, result: msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map(() => null) : null });
    } else notes.push(msg);
  }
});
const send = (o) => {
  const s = JSON.stringify(o);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
};
const request = (method, params, timeout = 120000) =>
  new Promise((resolve, reject) => {
    const my = ++id;
    const t = setTimeout(() => reject(new Error(`${method} timed out`)), timeout);
    pending.set(my, (m) => {
      clearTimeout(t);
      m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result);
    });
    send({ jsonrpc: "2.0", id: my, method, params });
  });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uri = (p) => pathToFileURL(p).href;

let ok = true;
try {
  const init = await request("initialize", {
    processId: process.pid,
    rootUri: uri(ws),
    workspaceFolders: [{ uri: uri(ws), name: "maven-multi" }],
    capabilities: { workspace: { executeCommand: { dynamicRegistration: false } }, textDocument: {} },
    initializationOptions: {
      bundles: [JAR],
      workspaceFolders: [uri(ws)],
      settings: { java: { import: { gradle: { enabled: false } }, configuration: { updateBuildConfiguration: "automatic" } } },
      extendedClientCapabilities: { classFileContentsSupport: false },
    },
  });
  notify("initialized", {});
  const commands = init.capabilities?.executeCommandProvider?.commands ?? [];
  console.log(`initialize: ${commands.length} commands advertised; batlehub.* = ${JSON.stringify(commands.filter((c) => c.startsWith("batlehub.")))}`);
  // Wait for the service to be ready (import done) — status notifications carry it.
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    if (notes.some((n) => n.method === "language/status" && /ServiceReady/.test(n.params?.type))) break;
    await sleep(1000);
  }
  console.log(`status after ${Math.round((Date.now() - t0) / 1000)} s: ${[...new Set(notes.filter((n) => n.method === "language/status").map((n) => n.params.type))].join(", ")}`);

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

  const person = path.join(ws, "core/src/main/java/com/acme/core/Person.java");
  const params = { textDocument: { uri: uri(person) }, range: { start: { line: 4, character: 4 }, end: { line: 4, character: 4 } }, context: { diagnostics: [] }, kind: 0 };
  const gen = await request("workspace/executeCommand", { command: "batlehub.generate.accessors", arguments: [params, JSON.stringify({ getterPrefix: "get", booleanPrefix: "is", fluentSetters: false, finalFields: "keepSetters", kind: 0 })] });
  const edits = gen?.changes?.[uri(person)] ?? [];
  console.log(`batlehub.generate.accessors(Person.java) → ${edits.length} edit(s); newText:\n${edits.map((e) => e.newText).join("")}`);
  const all = edits.map((e) => e.newText).join("");
  if (!/getName\(\)/.test(all) || !/setAge\(int age\)/.test(all)) ok = false;

  await request("shutdown", null, 30000).catch(() => {});
  notify("exit", null);
} catch (e) {
  ok = false;
  console.error("smoke failed:", e.message);
  console.error(stderr.join("").split("\n").filter((l) => /batlehub|Exception|ERROR|resolv/i.test(l)).slice(0, 40).join("\n"));
} finally {
  proc.kill();
  rmSync(work, { recursive: true, force: true });
}
console.log(ok ? "SMOKE-OK" : "SMOKE-FAILED");
process.exit(ok ? 0 : 1);

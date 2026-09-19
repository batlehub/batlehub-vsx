#!/usr/bin/env node
// Decision 7's condition, run for real: the bundled Prominic server starts
// on a JDK and answers LSP over stdio. `task groovy:smoke` — not vitest.
//   node test/smoke.mjs [java-binary] [fixture-dir]
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const java = process.argv[2] ?? `${process.env.HOME}/.local/share/mise/installs/java/temurin-21.0.11+10.0.LTS/bin/java`;
const fixture = path.resolve(process.argv[3] ?? path.join(here, "..", "..", "..", "tests", "heavy", "fixtures", "groovy-project"));
const jar = path.join(here, "..", "server", "groovy-language-server-all.jar");
const file = path.join(fixture, "src", "main", "groovy", "com", "acme", "Hello.groovy");

const p = spawn(java, ["-jar", jar], { stdio: ["pipe", "pipe", "inherit"] });
let buf = Buffer.alloc(0);
const pending = new Map();
let id = 0;
p.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf("\r\n\r\n");
    if (h < 0) return;
    const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, h).toString())[1]);
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString());
    buf = buf.subarray(h + 4 + len);
    if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
    else if (msg.method) console.log("<- notification", msg.method, JSON.stringify(msg.params).slice(0, 200));
  }
});
const send = (method, params, wait = true) => {
  const m = { jsonrpc: "2.0", method, params, ...(wait ? { id: ++id } : {}) };
  const s = JSON.stringify(m);
  p.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  return wait ? new Promise((r) => pending.set(m.id, r)) : undefined;
};
const t0 = Date.now();
const init = await send("initialize", { processId: process.pid, rootUri: `file://${fixture}`, capabilities: {}, workspaceFolders: [{ uri: `file://${fixture}`, name: "groovy-project" }] });
console.log(`initialize in ${Date.now() - t0} ms:`, JSON.stringify(init.result?.capabilities ?? init.error).slice(0, 400));
send("initialized", {}, false);
send("workspace/didChangeConfiguration", { settings: { groovy: { classpath: [] } } }, false);
send("textDocument/didOpen", { textDocument: { uri: `file://${file}`, languageId: "groovy", version: 1, text: readFileSync(file, "utf8") } }, false);
await new Promise((r) => setTimeout(r, 2500));
const hover = await send("textDocument/hover", { textDocument: { uri: `file://${file}` }, position: { line: 5, character: 12 } });
console.log("hover on greet():", JSON.stringify(hover.result ?? hover.error));
// Completion the way an editor asks for it: a member access being typed.
const typed = readFileSync(file, "utf8").replace("println new Hello().greet()", "println new Hello().greet()\n        new Hello().gr");
send("textDocument/didChange", { textDocument: { uri: `file://${file}`, version: 2 }, contentChanges: [{ text: typed }] }, false);
await new Promise((r) => setTimeout(r, 1500));
const completion = await send("textDocument/completion", { textDocument: { uri: `file://${file}` }, position: { line: 10, character: 22 } });
const items = completion.result?.items ?? completion.result ?? [];
console.log(`completion at "new Hello().gr|" : ${items.length} items, e.g. ${items.slice(0, 6).map((i) => i.label).join(", ")}`);
const c2 = await send("textDocument/completion", { textDocument: { uri: `file://${file}` }, position: { line: 9, character: 30 } });
const items2 = c2.result?.items ?? c2.result ?? [];
console.log(`completion inside "greet" of the original line: ${items2.length} items, e.g. ${items2.slice(0, 6).map((i) => i.label).join(", ")}`);
send("textDocument/didChange", { textDocument: { uri: `file://${file}`, version: 3 }, contentChanges: [{ text: readFileSync(file, "utf8") }] }, false);
await new Promise((r) => setTimeout(r, 1000));
const symbols = await send("textDocument/documentSymbol", { textDocument: { uri: `file://${file}` } });
console.log("symbols:", (symbols.result ?? []).map((s) => s.name).join(", "));
await send("shutdown", null);
send("exit", null, false);
const ok = !!init.result && !!hover.result && (items.length > 0 || items2.length > 0);
console.log(ok ? "SMOKE-OK" : "SMOKE-FAILED");
process.exit(ok ? 0 : 1);

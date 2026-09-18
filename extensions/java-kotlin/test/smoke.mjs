#!/usr/bin/env node
// RFC 0008 phase 0: decision 7's gate, measured, on the pinned JetBrains
// Kotlin LSP. Nothing ships from this file — it prints the numbers §11
// records. `task kotlin:smoke` — not vitest.
//   node test/smoke.mjs [server-dir] [fixture-dir]
//
// What it answers, in order: does the server start and initialize inside the
// budget; does it answer before its import is done and after; does hover,
// completion and a diagnostic come back on the fixture's Kotlin, and *how
// long each takes* — the latencies are the gate, not just the yes/no; what it
// costs in RSS; and — §11 open question 1 — what it does with a Maven
// project, with a mise shim on PATH and with a real Maven on PATH.
//
// One thing this client does on purpose, learned the hard way: it waits
// minutes, not seconds, for a diagnostic. Hover answers in ~3s and the first
// diagnostic after an edit in ~60s, whether the change is sent whole or as a
// range; a client that gives up at 30s reports "no diagnostics" and fails the
// gate on its own budget rather than on the server.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = `${process.env.HOME}/.cache/batlehub-heavy`;
const serverDir = process.argv[2] ?? path.join(here, "..", "server");
const fixtures = path.join(here, "..", "..", "..", "tests", "heavy", "fixtures");
const fixture = path.resolve(process.argv[3] ?? path.join(fixtures, "kotlin-project"));
const XMX = process.env.KOTLIN_XMX ?? "1g";
const INITIALIZE_BUDGET_MS = 10_000;
// Measured, not guessed: on this fixture the first diagnostic after an edit
// lands around 60s while hover answers in 3s. The old 30s loop read that gap
// as "no diagnostics at all" and failed the gate on the client's impatience.
const DIAGNOSTIC_BUDGET_MS = Number(process.env.KOTLIN_DIAGNOSTIC_BUDGET_MS ?? 180_000);
const IMPORT_BUDGET_MS = Number(process.env.KOTLIN_IMPORT_BUDGET_MS ?? 600_000);

// --- the process tree's peak RSS, from /proc: VmHWM is per process and
// already a peak, so the sum over the tree is an upper bound, not a snapshot.
const childrenOf = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
};
const treePeakKb = (root) => {
  let total = 0;
  const seen = new Set();
  const walk = (pid) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    try {
      const hwm = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      if (hwm) total += Number(hwm[1]);
    } catch {
      /* gone */
    }
    for (const c of childrenOf(pid)) walk(c);
  };
  walk(String(root));
  return total;
};

// --- one LSP session over stdio against the pinned server.
const session = (root, label, env = {}) => {
  const systemPath = path.join(cache, "kotlin-lsp-system", label);
  rmSync(systemPath, { recursive: true, force: true });
  mkdirSync(systemPath, { recursive: true });
  const p = spawn(path.join(serverDir, "bin", "intellij-server"), ["--stdio", "--system-path", systemPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, IJ_JAVA_OPTIONS: `-Xmx${XMX}`, ...env },
  });
  p.stderr.on("data", (d) => {
    if (process.env.KOTLIN_SMOKE_VERBOSE) process.stderr.write(d);
  });
  const state = { proc: p, diagnostics: new Map(), logs: [], import: [], peakKb: 0, systemPath, root };
  const pending = new Map();
  let buf = Buffer.alloc(0);
  let id = 0;
  const write = (m) => {
    const s = JSON.stringify(m);
    p.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  };
  p.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const h = buf.indexOf("\r\n\r\n");
      if (h < 0) return;
      const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, h).toString())[1]);
      if (buf.length < h + 4 + len) return;
      const msg = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString());
      buf = buf.subarray(h + 4 + len);
      if (msg.id !== undefined && msg.method === undefined) {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
      } else if (msg.id !== undefined) {
        // a server → client request: answer, or the server waits forever.
        write({ jsonrpc: "2.0", id: msg.id, result: msg.method === "workspace/configuration" ? (msg.params?.items ?? []).map(() => null) : null });
      } else if (msg.method === "textDocument/publishDiagnostics") {
        state.diagnostics.set(msg.params.uri, msg.params.diagnostics);
      } else if (msg.method === "window/logMessage") {
        state.logs.push(msg.params.message);
      } else if (msg.method === "intellij/importLog") {
        // Not LSP: how this server says the build model is ready. A plain
        // vscode-languageclient sees it only through onNotification.
        state.import.push({ at: Date.now(), ...msg.params });
      }
    }
  });
  state.send = (method, params) =>
    new Promise((r) => {
      const m = { jsonrpc: "2.0", id: ++id, method, params };
      pending.set(m.id, r);
      write(m);
    });
  state.notify = (method, params) => write({ jsonrpc: "2.0", method, params });
  state.sample = () => {
    state.peakKb = Math.max(state.peakKb, treePeakKb(p.pid));
  };
  state.serverLog = () => {
    try {
      return readFileSync(path.join(systemPath, "system", "log", "intellij-server.log"), "utf8");
    } catch {
      return "";
    }
  };
  // The import is over when intellij/importLog says succeeded or failed.
  state.awaitImport = async (budgetMs) => {
    const t = Date.now();
    while (Date.now() - t < budgetMs) {
      const done = state.import.find((e) => e.succeeded || e.failed);
      if (done) return { ms: done.at - t, succeeded: !!done.succeeded, message: done.message };
      state.sample();
      await sleep(1000);
    }
    return { ms: Date.now() - t, succeeded: false, message: "timed out" };
  };
  state.stop = async () => {
    state.sample();
    await state.send("shutdown", null);
    state.notify("exit", null);
    await sleep(1500);
    p.kill("SIGKILL");
  };
  return state;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIENT_CAPS = {
  textDocument: {
    publishDiagnostics: { relatedInformation: true },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    hover: { contentFormat: ["markdown", "plaintext"] },
    completion: { completionItem: { snippetSupport: false } },
  },
  window: { workDoneProgress: true },
};
const posOf = (text, needle, offset = 0) => {
  const idx = text.indexOf(needle) + offset;
  const before = text.slice(0, idx);
  return { line: before.split("\n").length - 1, character: idx - (before.lastIndexOf("\n") + 1) };
};
const hoverText = (h) => {
  const c = h?.result?.contents;
  if (!c) return "";
  return (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x.value ?? x).join(" ") : (c.value ?? "")).replace(/\s+/g, " ").trim();
};
const uriOf = (f) => `file://${f}`;
const openFile = (s, f, version = 1) => {
  const text = readFileSync(f, "utf8");
  s.notify("textDocument/didOpen", { textDocument: { uri: uriOf(f), languageId: f.endsWith(".java") ? "java" : "kotlin", version, text } });
  return text;
};
// The capability list says diagnosticProvider: ask (pull), and take what was
// pushed if the server prefers that.
const diagnosticsOf = async (s, f) => {
  const pulled = await s.send("textDocument/diagnostic", { textDocument: { uri: uriOf(f) } });
  const items = pulled.result?.items ?? [];
  return items.length ? items : (s.diagnostics.get(uriOf(f)) ?? []);
};
// Poll until the analyser says something. An empty pull report is not proof
// of a clean file — the server answers {kind:"full",items:[]} long before it
// has analysed anything — so emptiness only means "nothing yet".
const diagnosticsUntil = async (s, f, budgetMs) => {
  const t = Date.now();
  for (;;) {
    const diags = await diagnosticsOf(s, f);
    if (diags.length) return { diags, ms: Date.now() - t };
    if (Date.now() - t > budgetMs) return { diags: [], ms: Date.now() - t };
    s.sample();
    await sleep(2500);
  }
};
// Hover, retried until it resolves the symbol. This is the positive proof the
// cross-module and external-dependency checks need: an empty diagnostic list
// would be the same whether the reference resolved or was never looked at.
const hoverUntil = async (s, f, pos, needle, budgetMs) => {
  const t = Date.now();
  for (;;) {
    const text = hoverText(await s.send("textDocument/hover", { textDocument: { uri: uriOf(f) }, position: pos }));
    if (text.includes(needle)) return { text, ms: Date.now() - t, resolved: true };
    if (Date.now() - t > budgetMs) return { text, ms: Date.now() - t, resolved: false };
    s.sample();
    await sleep(2000);
  }
};
const shortDiag = (d) => `${d.severity}:${d.source ?? "?"}:${(d.message ?? "").replace(/\s+/g, " ").slice(0, 90)}@${d.range?.start?.line}`;

const results = {};

// =====================================================================
// The Gradle fixture: the gate proper.
// =====================================================================
const greeterFile = path.join(fixture, "lib", "src", "main", "kotlin", "com", "acme", "Greeter.kt");
const bannerFile = path.join(fixture, "app", "src", "main", "kotlin", "com", "acme", "app", "Banner.kt");
const testFile = path.join(fixture, "app", "src", "test", "kotlin", "com", "acme", "app", "BannerTest.kt");
const s = session(fixture, "gradle");

const t0 = Date.now();
const init = await s.send("initialize", {
  processId: process.pid,
  rootUri: uriOf(fixture),
  capabilities: CLIENT_CAPS,
  workspaceFolders: [{ uri: uriOf(fixture), name: path.basename(fixture) }],
});
results.initializeMs = Date.now() - t0;
if (!init.result) {
  console.error("initialize failed:", JSON.stringify(init.error));
  process.exit(1);
}
results.capabilities = Object.keys(init.result.capabilities ?? {}).length;
s.notify("initialized", {});

// Hover on the module's own code: answered by the standalone analysis, before
// any build import has finished. This is the number a user feels first.
const greeterSource = openFile(s, greeterFile);
const greetPos = posOf(greeterSource, "fun greet", 4);
const firstHover = await hoverUntil(s, greeterFile, greetPos, "greet", 48_000);
results.firstHoverMs = firstHover.ms;
results.hover = firstHover.text.slice(0, 160);

// A file opened before the import finishes is analysed for hover but not for
// diagnostics, and stays silent until it changes — measured, because a
// satellite that opens the first file eagerly would ship that silence.
results.diagnosticsBeforeImport = (await diagnosticsOf(s, greeterFile)).length;

const imported = await s.awaitImport(IMPORT_BUDGET_MS);
results.importMs = imported.ms;
results.importSucceeded = imported.succeeded;
results.importedWith = s.import.find((e) => e.started)?.tool ?? "?";

// Cross-module (app → lib) and external (app → junit) resolution: the build
// model, neither of them guessable from a file alone.
const bannerSource = openFile(s, bannerFile);
const testSource = openFile(s, testFile);
// app -> lib, across modules: only the build model can resolve this.
const bannerHover = await hoverUntil(s, bannerFile, posOf(bannerSource, "Greeter().greet", 2), "Greeter", 60_000);
// app -> junit, an external jar: likewise.
const testHover = await hoverUntil(s, testFile, posOf(testSource, "assertEquals(\"HELLO", 2), "assertEquals", 60_000);
results.crossModuleResolved = bannerHover.resolved;
results.crossModuleHover = bannerHover.text.slice(0, 120);
results.externalDepResolved = testHover.resolved;
results.externalDepHover = testHover.text.slice(0, 120);
const bannerDiags = await diagnosticsOf(s, bannerFile);
const testDiags = await diagnosticsOf(s, testFile);
results.bannerDiagnostics = bannerDiags.map(shortDiag);
results.testDiagnostics = testDiags.map(shortDiag);
const importLog = s.serverLog();
results.importErrors = [...importLog.matchAll(/\[IMPORT ERR\]: (.+)/g)].map((m) => m[1].trim()).slice(0, 6);

// Completion, the way an editor asks for it: a member access being typed.
const typed = greeterSource.replace(
  'fun greet(name: String): String = "Hello, $name$punctuation"',
  'fun greet(name: String): String = "Hello, $name$punctuation"\n\n    fun ping() { Greeter().gr }',
);
s.notify("textDocument/didChange", { textDocument: { uri: uriOf(greeterFile), version: 2 }, contentChanges: [{ text: typed }] });
await sleep(4000);
const completion = await s.send("textDocument/completion", { textDocument: { uri: uriOf(greeterFile) }, position: posOf(typed, "Greeter().gr", 12) });
const items = completion.result?.items ?? completion.result ?? [];
results.completionItems = items.length;
results.completionHasGreet = items.some((i) => i.label === "greet" || String(i.label).startsWith("greet("));
results.completionSample = items.slice(0, 6).map((i) => i.label);

// The type mismatch of use case 2.
const broken = greeterSource.replace("class Greeter(", 'val wrong: Int = "no"\n\nclass Greeter(');
s.diagnostics.delete(uriOf(greeterFile));
s.notify("textDocument/didChange", { textDocument: { uri: uriOf(greeterFile), version: 3 }, contentChanges: [{ text: broken }] });
const diagnosed = await diagnosticsUntil(s, greeterFile, DIAGNOSTIC_BUDGET_MS);
results.diagnosticMs = diagnosed.ms;
results.diagnostics = diagnosed.diags.map(shortDiag);
results.diagnosticOnWrongLine = diagnosed.diags.some((d) => d.range?.start?.line === posOf(broken, "val wrong").line);

s.sample();
results.peakRssMb = Math.round(s.peakKb / 1024);
results.xmx = XMX;
results.dataSharing = /dataSharing=(\w+)/.exec(s.logs.join("\n"))?.[1] ?? "?";
results.serverJdk = /java\.version: = ([^\n]+)/.exec(s.logs.join("\n"))?.[1] ?? "?";
results.serverJavaHome = /java\.home: ([^\n]+)/.exec(s.logs.join("\n"))?.[1] ?? "?";
await s.stop();

// =====================================================================
// The Maven twin: §11 open question 1. Twice — with the PATH a mise
// workspace really has (a shim), and with a real Maven on it.
// =====================================================================
const mavenBin = process.env.KOTLIN_MAVEN_BIN ?? `${process.env.HOME}/.local/share/mise/installs/maven/3.9.16/apache-maven-3.9.16/bin`;
const mavenRuns = [{ label: "maven-shim", env: {} }];
if (existsSync(path.join(mavenBin, "mvn"))) mavenRuns.push({ label: "maven-real", env: { PATH: `${mavenBin}:${process.env.PATH}` } });
results.maven = {};
if (!process.env.KOTLIN_SMOKE_SKIP_MAVEN) {
  const mvnRoot = path.join(fixtures, "kotlin-maven");
  const mvnFile = path.join(mvnRoot, "src", "main", "kotlin", "com", "acme", "Greeter.kt");
  for (const run of mavenRuns) {
    const m = session(mvnRoot, run.label, run.env);
    const r = {};
    const tm0 = Date.now();
    const mi = await m.send("initialize", { processId: process.pid, rootUri: uriOf(mvnRoot), capabilities: CLIENT_CAPS, workspaceFolders: [{ uri: uriOf(mvnRoot), name: "kotlin-maven" }] });
    r.initializeMs = Date.now() - tm0;
    r.initialized = !!mi.result;
    m.notify("initialized", {});
    const mvnSource = openFile(m, mvnFile);
    const mvnGreet = posOf(mvnSource, "fun greet", 4);
    const tm = Date.now();
    let mh = null;
    for (let i = 0; i < 24; i++) {
      mh = await m.send("textDocument/hover", { textDocument: { uri: uriOf(mvnFile) }, position: mvnGreet });
      if (hoverText(mh).includes("greet")) break;
      m.sample();
      await sleep(5000);
    }
    r.firstHoverMs = Date.now() - tm;
    r.hover = hoverText(mh).slice(0, 120);
    const mImport = await m.awaitImport(Number(process.env.KOTLIN_MAVEN_BUDGET_MS ?? 240_000));
    r.importMs = mImport.ms;
    r.importSucceeded = mImport.succeeded;
    r.importMessage = (mImport.message ?? "").slice(0, 120);
    // A file opened before the import: change it, so the analyser speaks.
    m.notify("textDocument/didChange", { textDocument: { uri: uriOf(mvnFile), version: 2 }, contentChanges: [{ text: `${mvnSource}\nval mavenProbe: Int = "no"\n` }] });
    const mvnDiagnosed = await diagnosticsUntil(m, mvnFile, DIAGNOSTIC_BUDGET_MS);
    r.diagnosticMs = mvnDiagnosed.ms;
    r.diagnostics = mvnDiagnosed.diags.map(shortDiag);
    const log = m.serverLog();
    r.importedWith = [...log.matchAll(/Trying to import using (\w+)/g)].map((x) => x[1]);
    r.importFailed = /Failed to import Maven project/.test(log);
    r.importErrors = [...log.matchAll(/\[IMPORT ERR\]: (.+)/g)].map((x) => x[1].trim()).slice(0, 4);
    r.usingMaven = /Using Maven: ([^\n]+)/.exec(log)?.[1]?.trim() ?? "?";
    m.sample();
    r.peakRssMb = Math.round(m.peakKb / 1024);
    await m.stop();
    results.maven[run.label] = r;
  }
}

// =====================================================================
// What a bundled server would cost a VSIX (§11 decision 7).
// =====================================================================
const du = (dir) => {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!e.isFile()) continue;
      try {
        total += readFileSync(path.join(e.parentPath ?? e.path, e.name)).length;
      } catch {
        /* unreadable */
      }
    }
  } catch {
    /* absent */
  }
  return Math.round(total / 1024 / 1024);
};
results.serverDirMb = du(serverDir);
results.serverJbrMb = du(path.join(serverDir, "jbr"));
results.serverVersion = readFileSync(path.join(serverDir, "build.txt"), "utf8").trim();

console.log(JSON.stringify(results, null, 2));
const ok =
  results.initializeMs < INITIALIZE_BUDGET_MS &&
  results.hover.includes("greet") &&
  results.completionHasGreet &&
  results.diagnosticOnWrongLine &&
  results.crossModuleResolved &&
  results.externalDepResolved;
console.log(ok ? "SMOKE-OK" : "SMOKE-FAILED");
process.exit(ok ? 0 : 1);

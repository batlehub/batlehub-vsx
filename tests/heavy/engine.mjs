#!/usr/bin/env node
// The engine half of RFC 0002 §10: the command line against maven-multi with
// a real server — no editor, no browser — so it runs in CI's `check` job
// after `jdt:smoke`. Phase 2: use case 5 (`status`) and use case 1 (the CI
// gate on inspections, in its three formats). Phase 3: use cases 2 (`fix`)
// and 4 (`generate accessors`), judged by git on the copy. Phase 4: use
// case 3's rename through the command line. Phase 5: use case 3 as MCP
// calls, through a minimal stdio client. The no-JDK half of use case 5
// is a unit test (`engine/test`): a machine with no JDK cannot be faked here
// without root, as /usr/lib/jvm cannot be hidden.
//
//   node tests/heavy/engine.mjs        (`task heavy:engine`)
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "engine", "cli.ts");
const work = mkdtempSync(path.join(tmpdir(), "batlehub-engine-"));
const ws = path.join(work, "maven-multi");
cpSync(path.join(REPO, "tests/heavy/fixtures/maven-multi"), ws, { recursive: true });

const log = (l) => console.log(`[engine] ${l}`);
let failures = 0;
const check = (ok, label, detail) => {
  if (ok) log(label);
  else {
    failures++;
    log(`FAIL: ${label.replace(/-OK.*/, "")} — ${detail}`);
  }
};
const run = (...args) => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ws, encoding: "utf8", timeout: 600_000 });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), ms: Date.now() - t0 };
};

// Use case 1's proof, as the fixture is today: RFC 0002 named Greeter.java's
// four; Person.java's `active` has joined them since.
const EXPECTED = [
  "core/src/main/java/com/acme/core/Greeter.java:8:17 unused/privateField Private field 'unused' is never used [fix]",
  "core/src/main/java/com/acme/core/Greeter.java:11:9 style/redundantThis 'this.' is redundant: nothing shadows 'people' [fix]",
  "core/src/main/java/com/acme/core/Greeter.java:17:13 performance/stringConcatInLoop String concatenation in a loop: use a StringBuilder",
  "core/src/main/java/com/acme/core/Greeter.java:23:16 collections/sizeIsZero Use isEmpty() instead of size() == 0 [fix]",
  "core/src/main/java/com/acme/core/Person.java:7:27 unused/privateField Private field 'active' is never used [fix]",
];

try {
  const st = run("status");
  const jdk = st.out.split("\n")[0] ?? "";
  check(
    st.code === 0 && /^JDK: JavaSE-2\d \(2\d[\d.]*, (mise|sdkman|env|wellKnown)\)$/.test(jdk),
    `ENGINE-STATUS-OK (${jdk}; ${st.out.split("\n")[1]} — RFC 0002 case 5)`,
    `exit ${st.code}: ${st.out} ${st.err}`,
  );

  const warn = run("inspect", "--fail-on", "warning", "--verbose", ".");
  const lines = warn.out.split("\n").filter(Boolean);
  check(
    warn.code === 1 && JSON.stringify(lines) === JSON.stringify(EXPECTED),
    `ENGINE-INSPECT-OK (${lines.length} findings, one per line, exit 1 at --fail-on warning in ${Math.round(warn.ms / 1000)} s; ${warn.err.split("\n").filter((l) => /peak RSS|source root|downloading/.test(l)).join("; ")} — RFC 0002 case 1)`,
    `exit ${warn.code}\n${warn.out}\n${warn.err}`,
  );

  const err = run("inspect", "--fail-on", "error", ".");
  check(
    err.code === 0 && err.out === warn.out,
    "ENGINE-FAIL-ON-OK (the same lines and exit 0 at --fail-on error)",
    `exit ${err.code}\n${err.out}\n${err.err}`,
  );

  const js = run("inspect", "--format", "json", ".");
  let d;
  try {
    d = JSON.parse(js.out);
  } catch {
    d = undefined;
  }
  const keys = d?.findings?.[0] ? Object.keys(d.findings[0]).sort().join(",") : "";
  check(
    js.code === 1 && d?.exit === 1 && d.findings.length === EXPECTED.length && keys === "area,code,fixTitle,message,path,range,ruleId,severity",
    "ENGINE-JSON-OK (--format json: the bundle's rows unchanged — ruleId, area, code, range, fixTitle — plus path, and { exit })",
    `exit ${js.code}: ${js.out.slice(0, 400)} ${js.err}`,
  );

  const sf = run("inspect", "--format", "sarif", "core");
  let s;
  try {
    s = JSON.parse(sf.out);
  } catch {
    s = undefined;
  }
  const results = s?.runs?.[0]?.results ?? [];
  check(
    s?.version === "2.1.0" && results.length === EXPECTED.length && results.every((r) => r.locations[0].physicalLocation.artifactLocation.uri.startsWith("core/")),
    `ENGINE-SARIF-OK (SARIF 2.1.0 on core/: ${results.length} results, ${s?.runs?.[0]?.tool?.driver?.rules?.length ?? 0} rules)`,
    `exit ${sf.code}: ${sf.out.slice(0, 400)} ${sf.err}`,
  );

  // Phase 3. Use case 2: one rule's fix over a module, dry run then --write,
  // judged by git — the copy is a repository of its own.
  const git = (...a) => spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.email=engine@heavy", "-c", "user.name=engine", ...a], { cwd: ws, encoding: "utf8" }).stdout.trim();
  git("init", "-q");
  // What the server's import and auto-build write is not the change under test.
  writeFileSync(path.join(ws, ".gitignore"), "target/\nbin/\n.project\n.classpath\n.settings/\n.factorypath\n");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  const GREETER = "core/src/main/java/com/acme/core/Greeter.java";
  const dry = run("fix", "--rule", "collections/sizeIsZero", "core/");
  check(
    dry.code === 0 && /^-        return people\.size\(\) == 0;$/m.test(dry.out) && /^\+        return people\.isEmpty\(\);$/m.test(dry.out) && git("diff", "--stat") === "",
    "ENGINE-FIX-DRY-OK (fix without --write: the unified diff on stdout, the tree untouched)",
    `exit ${dry.code}\n${dry.out}\n${dry.err}\n${git("diff", "--stat")}`,
  );
  const wrote = run("fix", "--rule", "collections/sizeIsZero", "--write", "core/");
  const changed = git("diff", "--name-only");
  const diffLines = git("diff", "-U0").split("\n").filter((l) => /^[-+] /.test(l));
  const again = run("fix", "--rule", "collections/sizeIsZero", "--write", "core/");
  check(
    wrote.code === 0 && wrote.out === "1 file, 1 edit" && changed === GREETER && JSON.stringify(diffLines) === JSON.stringify(["-        return people.size() == 0;", "+        return people.isEmpty();"]) && again.code === 0 && again.out === "0 files",
    `ENGINE-FIX-OK (--write: '${wrote.out}', git diff names ${changed} and that one line; a second run '${again.out}', exit 0 — RFC 0002 case 2)`,
    `write exit ${wrote.code} '${wrote.out}' ${wrote.err}; changed ${changed}; ${JSON.stringify(diffLines)}; again exit ${again.code} '${again.out}' ${again.err}`,
  );

  // Use case 4: accessors with options, no prompt.
  const PERSON = "core/src/main/java/com/acme/core/Person.java";
  const gj = run("generate", "accessors", `${PERSON}:5`, "--getter-prefix", "get", "--fluent", "--format", "json");
  let g;
  try {
    g = JSON.parse(gj.out);
  } catch {
    g = undefined;
  }
  const untouched = git("diff", "--stat", "--", PERSON) === "";
  const gw = run("generate", "accessors", `${PERSON}:5`, "--getter-prefix", "get", "--fluent", "--write");
  const added = git("diff", "-U0", "--", PERSON);
  check(
    gj.code === 0 && g?.written === false && Object.keys(g?.edit?.changes ?? {}).length === 1 && untouched &&
      gw.code === 0 && gw.out === "1 file, 1 edit" &&
      /^\+    public String getName\(\) \{$/m.test(added) && /^\+    public Person setName\(String name\) \{$/m.test(added) && /^\+        return this;$/m.test(added) && /^\+    public boolean isActive\(\) \{$/m.test(added),
    "ENGINE-GENERATE-OK (generate accessors Person.java:5 --fluent: the WorkspaceEdit in JSON with nothing written, then --write: getName(), setName() returning this, isActive(), the file's 4-space indent — RFC 0002 case 4)",
    `json exit ${gj.code} untouched ${untouched} ${gj.err}; write exit ${gw.code} '${gw.out}' ${gw.err}\n${added.slice(0, 600)}`,
  );

  // Phase 4. Use case 3's rename through the command line: a symbol, across
  // modules; a type, refused (its rename moves the file). The fix and the
  // generator above are committed first, so git judges the rename alone.
  git("add", "-A");
  git("commit", "-qm", "phase 3");
  const MAIN = "app/src/main/java/com/acme/app/Main.java";
  const rdry = run("rename", "com.acme.core.Greeter#all", "everyone");
  const rdryUntouched = git("diff", "--stat") === "";
  const rw = run("rename", "com.acme.core.Greeter#all", "everyone", "--write");
  const renamed = git("diff", "--name-only").split("\n").filter(Boolean).sort();
  const mainLine = git("diff", "-U0", "--", MAIN).split("\n").find((l) => l.startsWith("+ "));
  const rtype = run("rename", "com.acme.core.Greeter", "Hello");
  check(
    rdry.code === 0 && rdryUntouched && rw.code === 0 && rw.out === "3 files, 3 edits" &&
      JSON.stringify(renamed) === JSON.stringify(["app/src/main/java/com/acme/app/Main.java", "app/src/test/java/com/acme/app/MainTest.java", GREETER]) &&
      mainLine === "+        System.out.print(g.everyone());" && rtype.code === 1 && /moves its file \(Greeter\.java\)/.test(rtype.err),
    `ENGINE-RENAME-OK (rename com.acme.core.Greeter#all everyone: a dry run that touches nothing, then --write '${rw.out}' — Greeter.java and the callers in app/, the other module; a type rename refused, exit 1 — RFC 0002 case 3, command line)`,
    `dry exit ${rdry.code} untouched ${rdryUntouched} ${rdry.err}; write exit ${rw.code} '${rw.out}' ${rw.err}; ${JSON.stringify(renamed)}; main ${mainLine}; type exit ${rtype.code} ${rtype.err}`,
  );

  // Phase 5. Use case 3 as MCP calls: `mcp` over stdio, played by a minimal
  // client — one server for the whole session. The working tree is put back
  // to the last commit first, so the rename starts from `all()`.
  git("checkout", "-q", "--", ".");
  const mcp = spawn(process.execPath, [CLI, "mcp"], { cwd: ws, stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map();
  let buf = "";
  mcp.stdout.setEncoding("utf8").on("data", (d) => {
    buf += d;
    for (let nl; (nl = buf.indexOf("\n")) >= 0; ) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      replies.get(m.id)?.(m);
    }
  });
  let mcpErr = "";
  mcp.stderr.setEncoding("utf8").on("data", (d) => (mcpErr += d));
  let id = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const t = setTimeout(() => reject(new Error(`${method}: no answer in 300 s`)), 300_000);
      replies.set(n, (m) => (clearTimeout(t), resolve(m)));
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
  const t0 = Date.now();
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "engine-heavy", version: "0" } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = (await rpc("tools/list", {})).result.tools;
    const required = Object.fromEntries(listed.map((x) => [x.name, x.inputSchema.required]));
    const dry = await call("java_rename", { symbol: "com.acme.core.Greeter#all", newName: "everyone" });
    const dryUntouched = git("diff", "--stat") === "";
    const applied = await call("java_rename", { symbol: "com.acme.core.Greeter#all", newName: "everyone", dryRun: false });
    const renamedFiles = git("diff", "--name-only").split("\n").filter(Boolean).sort();
    // The server must see its session's own writes: the new name resolves,
    // and a written fix is gone from the next inspection.
    const back = await call("java_rename", { symbol: "com.acme.core.Greeter#everyone", newName: "all" });
    const fixed = await call("java_fix", { paths: [GREETER], rule: "style/redundantThis", dryRun: false });
    const after = await call("java_inspect", { paths: [GREETER] });
    const codes = (after?.structuredContent?.findings ?? []).map((f) => f.code);
    const typeRefused = await call("java_rename", { symbol: "com.acme.core.Greeter", newName: "Hello" });
    const sc = dry?.structuredContent;
    check(
      JSON.stringify(listed.map((x) => x.name)) === JSON.stringify(["java_status", "java_inspect", "java_fix", "java_generate", "java_rename"]) &&
        JSON.stringify(required.java_rename) === JSON.stringify(["symbol", "newName"]) &&
        JSON.stringify(required.java_generate) === JSON.stringify(["what", "file", "line"]) &&
        sc?.applied === false && dryUntouched &&
        Object.keys(sc?.edit?.changes ?? {}).sort().join(",") === ["app/src/main/java/com/acme/app/Main.java", "app/src/test/java/com/acme/app/MainTest.java", GREETER].join(",") &&
        Object.values(sc.edit.changes).every((l) => l.every((e) => e.range && typeof e.newText === "string")) &&
        applied?.structuredContent?.applied === true && renamedFiles.length === 3 &&
        back?.isError !== true && back?.structuredContent?.files === 3 &&
        fixed?.structuredContent?.applied === true && !codes.includes("style/redundantThis") && codes.includes("unused/privateField") &&
        typeRefused?.isError === true && /moves its file/.test(typeRefused.content[0].text),
      `ENGINE-MCP-OK (batlehub java mcp over stdio, one server for ${Math.round((Date.now() - t0) / 1000)} s: tools/list the five tools, required matching the CLI; java_rename dryRun by default — one WorkspaceEdit over Greeter.java, Main.java and MainTest.java, nothing written — then dryRun false wrote ${renamedFiles.length} files; the server saw its own writes — Greeter#everyone resolved, and java_fix then java_inspect saw redundantThis gone; a type rename refused — RFC 0002 case 3)`,
      `tools ${JSON.stringify(listed.map((x) => x.name))} required ${JSON.stringify(required)}; dry ${JSON.stringify(sc).slice(0, 300)} untouched ${dryUntouched}; applied ${JSON.stringify(applied).slice(0, 200)} files ${renamedFiles}; back ${JSON.stringify(back).slice(0, 300)}; fixed ${JSON.stringify(fixed).slice(0, 200)}; after ${codes}; type ${JSON.stringify(typeRefused).slice(0, 200)}\n${mcpErr.slice(-800)}`,
    );
  } catch (e) {
    check(false, "ENGINE-MCP-OK", `${e.message}\n${mcpErr.slice(-800)}`);
  } finally {
    mcp.stdin.end();
    await new Promise((r) => mcp.once("exit", r));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
log(failures ? `ENGINE-FAILED (${failures})` : "ENGINE-OK");
process.exit(failures ? 1 : 0);

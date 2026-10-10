#!/usr/bin/env node
// The browser half of the `quarkus` heavy half (RFC 0011 §6.4, §10): a real
// VS Code web workbench with java-core, java-quarkus and — unless
// `--degraded` — the Red Hat pair, the quarkus fixture open. One JSON line
// per measurement; view.sh asserts.
//
//   node quarkus.mjs --url <workbench> --shots <dir> --cdp <http://host:port>
//        --workspace <dir> [--degraded 1]
//
//   detect      the "BatleHub Java: Quarkus" channel: detection, the bridge write
//   completion  case 1: `quarkus.http.` in application.properties, the rows offered
//   dev         case 2: dev mode started, /q/health/ready, the status bar, the resources sum, the tab
//   stop        case 3: a second start refused, then Stop: the port free, the console, the tab
//   debug       case 4: Debug dev mode, a breakpoint in GreetingResource.hello hit by GET /hello
//   extensions  case 5: Add quarkus-jackson from the offline catalogue, then Remove it
//   (--degraded 1: no Red Hat pair, cases 2–3; --gradle 1: the Gradle fixture, cases 2–3)
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "..", "extensions", "batlehub-vsx", "package.json"));
const puppeteer = require("puppeteer-core");

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const need = (k) => {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
  return args[k];
};
const URL_ = need("url");
const SHOTS = need("shots");
const CDP = need("cdp");
const WS = need("workspace");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Puppeteer takes one key per press: a chord is modifier down, key, modifier up. */
async function chord(page, modifier, key) {
  await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  await page.keyboard.up(modifier);
}
/** `--stop-after <phase>` ends the run once that phase is emitted: the second
 * session of the suite (the desktop case) needs the first four phases and
 * none of the minutes that follow them. */
class StopSuite extends Error {}
const emit = (o) => {
  console.log(JSON.stringify(o));
  if (o.phase && o.phase === args["stop-after"]) throw new StopSuite();
};
let shot = 0;
const snap = (page, name) => page.screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, "0")}-quarkus${DEGRADED ? "-degraded" : ""}-${name}.png`) }).catch(() => {});
/**
 * A file's content, or `null` when it is not there — `null`, not `undefined`,
 * because JSON.stringify drops an undefined property and the assertions read
 * "the file was absent" as a value, not as a missing key.
 */
const readIfPresent = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const norm = (s) => (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
/** A shell hook: its output goes to stderr, never into the JSON stream. */
const hook = (cmd) => execSync(cmd, { stdio: ["ignore", process.stderr, "inherit"] });

async function dismissDialogs(page, extra = /^(Yes|Trust|OK|Restore)/) {
  const clicked = [];
  for (const b of await page.$$(".monaco-dialog-box .dialog-buttons .monaco-button, .monaco-dialog-box .dialog-buttons a")) {
    const t = norm(await b.evaluate((e) => e.textContent));
    if (extra.test(t)) {
      clicked.push(t);
      await b.click();
      await sleep(800);
    }
  }
  return clicked;
}

/**
 * A notification's action button. `dismissDialogs` only reaches modal
 * dialogs; a `showInformationMessage(msg, action)` without `{modal:true}` is
 * a toast, and its buttons live in a different part of the DOM.
 */
async function clickNotificationAction(page, re) {
  for (const b of await page.$$(
    ".notifications-toasts .monaco-button, .notifications-toasts .monaco-button-dropdown .monaco-button, .notifications-list-container .monaco-button",
  )) {
    const t = norm(await b.evaluate((e) => e.textContent));
    if (re.test(t)) {
      await b.click();
      await sleep(800);
      return t;
    }
  }
  return null;
}

async function notifications(page) {
  return page
    .$$eval(".notifications-toasts .notification-list-item-message, .notifications-list-container .notification-list-item-message", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean))
    .catch(() => []);
}

async function statusItems(page, re) {
  return page
    .$$eval(".statusbar-item", (els) => els.map((e) => ({ id: e.id, text: e.innerText.replace(/\s+/g, " ").trim(), label: e.getAttribute("aria-label") || "" })))
    .then((items) => items.filter((i) => re.test(i.id) || re.test(i.label)))
    .catch(() => []);
}
/** Our status bar item: id `batlehub.java` (the workbench prefixes it with the extension id). */
const javaStatus = (page) => statusItems(page, /batlehub\.java-core\.batlehub\.java$|^BatleHub Java:/);

async function settle(fn, ok, timeout, every = 700) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (ok(last)) return { value: last, ms: Date.now() - t0 };
    await sleep(every);
  }
  return { value: last, ms: Date.now() - t0, timedOut: true };
}

/** Run a palette command by its exact title: the palette's fuzzy ranking puts other commands first for a prefix, so the matching row is clicked, not the first one. */
async function runCommand(page, title, enter = true) {
  await page.keyboard.press("F1");
  const input = await page.waitForSelector(".quick-input-widget input", { timeout: 20000 });
  await input.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type(`>${title}`);
  // Poll for the row rather than trust one fixed sleep, and throw when none
  // matches: pressing Enter anyway ran whatever the palette ranked first, and
  // a wrong title (`View: Revert File`) then failed silently for months.
  const match = (r) => r === title || r === `${title}…` || r.startsWith(`${title} `) || r.startsWith(`${title}…`);
  let rows = [];
  for (let t0 = Date.now(); Date.now() - t0 < 5000; await sleep(300)) {
    rows = await page.$$eval(".quick-input-widget .monaco-list-row", (els) => els.map((e) => (e.querySelector(".label-name") ?? e).textContent.replace(/\s+/g, " ").trim())).catch(() => []);
    if (rows.some(match)) break;
  }
  if (enter) {
    const i = rows.findIndex(match);
    if (i < 0) {
      await page.keyboard.press("Escape");
      throw new Error(`runCommand: no palette row is "${title}" — rows: ${JSON.stringify(rows.slice(0, 5))}`);
    }
    if (i > 0) (await page.$$(".quick-input-widget .monaco-list-row"))[i]?.click();
    else await page.keyboard.press("Enter");
    await sleep(800);
  }
  return rows;
}

async function quickPickRows(page) {
  await sleep(1200);
  const rows = await page.$$eval(".quick-input-widget .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/ /g, " ").replace(/\s+/g, " ").trim())).catch(() => []);
  const title = norm(await page.$eval(".quick-input-widget .quick-input-title", (e) => e.innerText).catch(() => ""));
  return { title, rows };
}

/** Every line of an output channel: the editor is virtualised, so it is read page by page from the top. */
async function outputLines(page, command = "Java: Show log") {
  await runCommand(page, command);
  await sleep(1500);
  const editor = await page.$(".part.panel .monaco-editor");
  if (!editor) return [];
  await editor.click();
  await chord(page, "Control", "Home");
  await sleep(300);
  const seen = [];
  const read = () => page.$$eval(".part.panel .monaco-editor .view-lines .view-line", (els) => els.map((e) => e.innerText.replace(/ /g, " ").replace(/\s+$/, "")).filter(Boolean)).catch(() => []);
  let last = "";
  for (let i = 0; i < 40; i++) {
    const lines = await read();
    for (const l of lines) if (!seen.includes(l)) seen.push(l);
    const tail = lines.at(-1) ?? "";
    if (tail === last && i > 0) break;
    last = tail;
    await page.keyboard.press("PageDown");
    await sleep(250);
  }
  return seen;
}

/** The current editor's text, as the DOM renders it (long files: the visible part plus what Ctrl+End reveals). */
async function editorText(page) {
  const read = () => page.$$eval(".editor-instance .monaco-editor .view-lines .view-line", (els) => els.map((e) => e.innerText.replace(/ /g, " "))).catch(() => []);
  await chord(page, "Control", "Home");
  await sleep(200);
  const a = await read();
  await chord(page, "Control", "End");
  await sleep(200);
  const b = await read();
  return [...new Set([...a, ...b])].join("\n");
}

async function trustWorkspace(page) {
  const restricted = await page.$$eval(".statusbar-item", (els) => els.some((e) => /Restricted Mode/.test(e.innerText))).catch(() => false);
  if (!restricted) return "already trusted";
  await runCommand(page, "Workspaces: Manage Workspace Trust");
  const btn = await page.waitForSelector(".workspace-trust-editor .monaco-button, .workspace-trust-editor button", { timeout: 20000 }).catch(() => null);
  if (!btn) return "no trust editor";
  for (const b of await page.$$(".workspace-trust-editor .monaco-button, .workspace-trust-editor button")) {
    const t = norm(await b.evaluate((e) => e.textContent));
    if (/^Trust\b/.test(t)) {
      await b.click();
      await sleep(1500);
      await chord(page, "Control", "w").catch(() => {});
      return `clicked ${t}`;
    }
  }
  return "no Trust button";
}

async function openWorkbench(page) {
  await page.goto(URL_, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await sleep(2000);
  await dismissDialogs(page);
}

/** Ctrl+P → a file of the workspace. */
async function openFile(page, name) {
  await chord(page, "Control", "p");
  const input = await page.waitForSelector(".quick-input-widget input", { timeout: 20000 });
  await input.focus();
  // A file the driver has just written is not in Quick Open's index yet:
  // pressing Enter on "No matching results" leaves the query open and the
  // next keystrokes land in it. Retype until the file is listed.
  for (let i = 0; i < 15; i++) {
    await chord(page, "Control", "a");
    await page.keyboard.type(name);
    await sleep(1200);
    const listed = await page
      .$$eval(".quick-input-list .monaco-list-row", (els, n) => els.some((e) => e.innerText.includes(n)), name.split("/").pop())
      .catch(() => false);
    if (listed) break;
  }
  await page.keyboard.press("Enter");
  await sleep(1500);
}

async function clickActivity(page, labelPrefix) {
  const el = await page.waitForSelector(`.activitybar [aria-label^="${labelPrefix}"]`, { timeout: 30000 });
  const active = await el.evaluate((e) => !!e.closest(".action-item")?.classList.contains("checked"));
  if (!active) await el.click();
  await sleep(1200);
}

/** The Java panel's webview lives in a nested iframe: the frame that has our tablist. */
async function panelFrame(page) {
  for (let i = 0; i < 20; i++) {
    for (const f of page.frames()) {
      const has = await f.$('[role="tablist"][aria-label="Java panel tabs"]').catch(() => null);
      if (has) return f;
    }
    await sleep(500);
  }
  return null;
}


const DEGRADED = !!args.degraded;
/** The Gradle fixture: detection, dev mode and its stop — the kind's Gradle goal. */
const GRADLE = !!args.gradle;
const DEV_PORT = 8081;
const PROPS = path.join(WS, "src", "main", "resources", "application.properties");

const portFree = (port) =>
  new Promise((r) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), r(false)));
    s.once("error", () => r(true));
  });
const health = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${DEV_PORT}/q/health/ready`);
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  } catch (e) {
    return { status: 0, body: e.message };
  }
};
const quarkusItem = async () => (await statusItems(page, /quarkus\.dev/)).map((i) => i.text).join(" ");
const replLines = async () => {
  await runCommand(page, "Debug Console: Focus on Debug Console View");
  await sleep(600);
  return page.$$eval(".repl .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
};
/** The Quarkus tab of the Java panel: its text. */
const quarkusTab = async () => {
  await clickActivity(page, "Java");
  await sleep(1500);
  const frame = await panelFrame(page);
  if (!frame) return "";
  const tab = await frame.$$('[role="tab"]').then(async (ts) => {
    for (const t of ts) if ((await t.evaluate((e) => e.textContent.trim())) === "Quarkus") return t;
    return null;
  });
  if (!tab) return "";
  await tab.click();
  await sleep(800);
  return frame.$eval('[role="tabpanel"]:not([hidden])', (e) => e.innerText.replace(/\s+/g, " ").trim()).catch(() => "");
};

const browser = await puppeteer.connect({ browserURL: CDP });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1360, height: 900 });

try {
  // Restricted Mode shows only once the workbench has settled: trust after the
  // core's item is there, and until the editor stops saying "Restricted".
  const trust = async () => {
    await settle(() => javaStatus(page), (s) => s.length > 0, 90000);
    // A click on a button that re-renders mid-click throws: the next round retries it.
    for (let i = 0; i < 10 && (await trustWorkspace(page).catch(() => "retry")) !== "already trusted"; i++) await sleep(1500);
  };
  await openWorkbench(page);
  await trust();
  // The newcomer: the core writes java.jdt.ls.java.home and asks for a reload.
  const core = await outputLines(page);
  if (/wrote java\.jdt\.ls\.java\.home/.test(core.join(" "))) {
    await dismissDialogs(page, /^(Reload|Yes|OK)/);
    await openWorkbench(page);
    await trust();
  }
  const detected = await settle(() => outputLines(page, "Quarkus: Show the Quarkus log").catch(() => []), (l) => l.some((x) => /detected Quarkus|no Quarkus module/.test(x)), 90000, 2000);
  await snap(page, "detect");
  // Toasts come and go: the notification center keeps them all.
  await runCommand(page, "Notifications: Show Notifications");
  await sleep(800);
  emit({ phase: "detect", lines: detected.value ?? [], notifications: await notifications(page) });

  if (!DEGRADED && !GRADLE) {
    // Case 1: the MicroProfile server started at load, before the bridge wrote
    // its JDK, and does not retry: the reload is the RFC's own step.
    if ((detected.value ?? []).join(" ").includes("wrote java.home")) {
      await openWorkbench(page);
      await trust();
    }
    // Case 1: the MicroProfile server, on the bridged JDK, knows the project's
    // Quarkus keys — its diagnostics accept the real ones and flag a made-up
    // one — and completes them. Completion is asked once the diagnostics show
    // the server has the project's info (RFC 0011 §11, phase 2 finding 4).
    const before = readIfPresent(PROPS);
    writeFileSync(PROPS, `${before ?? ""}quarkus.http.nope=1\n`);
    await openFile(page, "src/main/resources/application.properties");
    const diag = await settle(
      async () => {
        await runCommand(page, "View: Focus Problems");
        await sleep(1500);
        return page.$$eval(".markers-panel .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
      },
      (r) => r.some((x) => /Unrecognized property 'quarkus\.http\.nope'/.test(x)),
      300000,
      5000,
    );
    await snap(page, "diagnostics");
    await openFile(page, "src/main/resources/application.properties");
    await chord(page, "Control", "End");
    await page.keyboard.type("quarkus.http.");
    await chord(page, "Control", " ");
    await sleep(4000);
    const rows = await page.$$eval(".suggest-widget .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim())).catch(() => []);
    await snap(page, "completion");
    await page.keyboard.press("Escape");
    emit({ phase: "completion", problems: diag.value ?? [], timedOut: !!diag.timedOut, ms: diag.ms, rows: rows.slice(0, 8) });
    await runCommand(page, "File: Revert File");
    if (before !== null) writeFileSync(PROPS, before);
  }

  // Case 2: dev mode as a managed process.
  await runCommand(page, "Quarkus: Start dev mode");
  const up = await settle(health, (h) => h.status === 200 && /"UP"/.test(h.body), 420000, 3000);
  await sleep(1500);
  await snap(page, "dev");
  const resources = (await outputLines(page, "Java: Show the container's resources")).join(" ");
  const coreLog = (await outputLines(page)).join(" ");
  const tab = await quarkusTab();
  emit({
    phase: "dev",
    health: up.value,
    timedOut: !!up.timedOut,
    ms: up.ms,
    status: await quarkusItem(),
    started: /started run:Quarkus dev mode:1 \(pid \d+, 1024 MiB declared\)/.test(coreLog),
    inSum: /run:Quarkus dev mode:1 \(declared\): (1024 MiB|1 GiB)/.test(resources),
    resources: resources.slice(-500),
    tab,
  });

  // Case 3: a second start is refused, naming pid and port; then Stop.
  await runCommand(page, "Quarkus: Start dev mode");
  await sleep(2000);
  const refused = await notifications(page);
  await snap(page, "refused");
  await runCommand(page, "Quarkus: Stop dev mode");
  const freed = await settle(() => portFree(DEV_PORT), (f) => f, 60000, 1000);
  await sleep(1500);
  const console_ = await replLines();
  emit({
    phase: "stop",
    refused,
    portFree: !freed.timedOut,
    ms: freed.ms,
    console: console_,
    statusAfter: await quarkusItem(),
    tabAfter: await quarkusTab(),
  });

  if (!DEGRADED && !GRADLE) {
    // Case 4: Debug — the same run step with debug: true, the core attaches.
    await openFile(page, "GreetingResource.java");
    await chord(page, "Control", "g");
    await sleep(500);
    await page.keyboard.type("14");
    await page.keyboard.press("Enter");
    await sleep(500);
    await runCommand(page, "Debug: Toggle Breakpoint");
    await runCommand(page, "Quarkus: Debug dev mode");
    const dbgUp = await settle(health, (h) => h.status === 200, 420000, 3000);
    // The attach follows the probe; a request before it would not stop.
    await sleep(8000);
    let body = null;
    const request = fetch(`http://127.0.0.1:${DEV_PORT}/hello`).then((r) => r.text()).then((t) => (body = t), (e) => (body = `error: ${e.message}`));
    const paused = await settle(async () => !!(await page.$(".debug-toolbar .codicon-debug-continue")), (p) => p, 120000, 1000);
    await runCommand(page, "View: Show Run and Debug");
    await sleep(1000);
    const stack = await page.$$eval(".debug-call-stack .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
    await snap(page, "debug-paused");
    await runCommand(page, "Debug: Continue");
    await Promise.race([request, sleep(15000)]);
    await runCommand(page, "Remove All Breakpoints");
    await runCommand(page, "Quarkus: Stop dev mode");
    const dbgFree = await settle(() => portFree(DEV_PORT), (f) => f, 60000, 1000);
    emit({ phase: "debug", up: !dbgUp.timedOut, paused: !paused.timedOut, stack: stack.slice(0, 12), body, portFree: !dbgFree.timedOut });

    // Case 5: the offline catalogue, add then remove, the POM after each.
    const POM = path.join(WS, "pom.xml");
    const pick = async (command, id) => {
      await runCommand(page, command);
      await page.waitForSelector(".quick-input-widget input", { timeout: 20000 });
      await sleep(1500);
      await page.keyboard.type(id);
      await sleep(1000);
      const rows = await quickPickRows(page);
      await page.keyboard.press("Enter");
      return rows;
    };
    const addRows = await pick("Quarkus: Add an extension…", "quarkus-jackson");
    const added = await settle(() => readIfPresent(POM), (t) => /quarkus-jackson/.test(t ?? ""), 240000, 2000);
    await sleep(3000);
    const tabAdded = await quarkusTab();
    const removeRows = await pick("Quarkus: Remove an extension…", "quarkus-jackson");
    const removed = await settle(() => readIfPresent(POM), (t) => t !== null && !/quarkus-jackson/.test(t), 240000, 2000);
    await sleep(3000);
    const qlog = (await outputLines(page, "Quarkus: Show the Quarkus log").catch(() => [])).join(" ");
    emit({
      phase: "extensions",
      addRows: addRows.rows.slice(0, 4),
      added: !added.timedOut,
      tabAdded,
      removeRows: removeRows.rows.slice(0, 4),
      removed: !removed.timedOut,
      reimported: /add extension quarkus-jackson: done/.test(qlog) && /remove extension quarkus-jackson: done/.test(qlog),
    });
  }
} catch (e) {
  console.error(e);
  await snap(page, "error");
  process.exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
  await browser.disconnect();
}

#!/usr/bin/env node
// The browser half of the `kotlin` heavy half (RFC 0008 §2.1, phase 3): a
// real VS Code web workbench with java-core, redhat.java and java-kotlin, the
// kotlin-project fixture open, JetBrains' server from the heavy cache
// (`task kotlin:fetch`, through batlehub.java.kotlin.server.home). One JSON
// line per measurement; view.sh asserts.
//
//   node kotlin.mjs --url <workbench> --shots <dir> --cdp <http://host:port> --workspace <dir>
//
//   untrusted  case 5: Greeter.kt open before trust — the server not started
//   server     case 1: trusted — the channel's start and initialize lines, hover on greet
//   diagnostic case 2: a type mismatch typed into Greeter.kt, reported by the server
//   kts        case 3: build.gradle.kts opens as Kotlin, the same server
//   tab        case 7: the Java panel's Kotlin tab; the resources sum holds kotlin-ls
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
const snap = (page, name) => page.screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, "0")}-kotlin-${name}.png`) }).catch(() => {});
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
  // One in-page find-and-click: the trust editor re-renders while it opens,
  // and a handle taken a moment earlier can be detached by the click.
  for (let i = 0; i < 5; i++) {
    const t = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".workspace-trust-editor .monaco-button, .workspace-trust-editor button")].find((e) => /^Trust\b/.test(e.textContent.replace(/\s+/g, " ").trim()));
      if (!b) return null;
      b.click();
      return b.textContent.replace(/\s+/g, " ").trim();
    });
    if (t) {
      await sleep(1500);
      await chord(page, "Control", "w").catch(() => {});
      return `clicked ${t}`;
    }
    await sleep(1000);
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


const GREETER = path.join(WS, "lib", "src", "main", "kotlin", "com", "acme", "Greeter.kt");
const kotlinLog = async (page) => (await outputLines(page, "Java: Show the Kotlin log")).join("\n");
/** The Java panel's Kotlin tab: its text. */
const kotlinTab = async (page) => {
  await clickActivity(page, "Java");
  await sleep(1500);
  const frame = await panelFrame(page);
  if (!frame) return "";
  const clicked = await frame
    .evaluate(() => {
      const t = [...document.querySelectorAll('[role="tab"]')].find((e) => e.textContent.trim() === "Kotlin");
      t?.click();
      return !!t;
    })
    .catch(() => false);
  if (!clicked) return "";
  await sleep(800);
  return frame.$eval('[role="tabpanel"]:not([hidden])', (e) => e.innerText.replace(/\s+/g, " ").trim()).catch(() => "");
};
/** Hover at a 1-based line:col of the active editor. */
async function hoverAt(page, line, col) {
  await chord(page, "Control", "g");
  await sleep(300);
  await page.keyboard.type(`${line}:${col}`);
  await page.keyboard.press("Enter");
  await sleep(400);
  await runCommand(page, "Show or Focus Hover");
  await sleep(1500);
  // Only a visible hover: the widget stays in the page, hidden, with the
  // previous file's text once closed.
  const text = await page
    .$$eval(".monaco-hover", (els) => els.filter((e) => e.offsetParent !== null && !e.classList.contains("hidden")).map((e) => e.innerText).join("\n"))
    .catch(() => "");
  await page.keyboard.press("Escape");
  return text;
}
const problems = async (page) => {
  await runCommand(page, "View: Focus Problems");
  await sleep(1200);
  return page.$$eval(".markers-panel .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
};
const languageMode = (page) =>
  page.$$eval(".statusbar-item", (els) => els.map((e) => e.getAttribute("aria-label") ?? "").find((a) => /^Select Language Mode|Language Mode/i.test(a) || /\bKotlin\b/.test(a)) ?? "").catch(() => "");

const browser = await puppeteer.connect({ browserURL: CDP });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1360, height: 900 });
try {
  await openWorkbench(page);
  // Case 5: before trust, Greeter.kt opens, nothing starts.
  await openFile(page, "Greeter.kt");
  await sleep(4000);
  const before = await kotlinLog(page);
  emit({ phase: "untrusted", log: before.slice(-1200), started: /starting: kotlin-server/.test(before) });
  // Case 1: trusted, the core starts the server through the satellite.
  emit({ phase: "trust", how: await trustWorkspace(page) });
  await openFile(page, "Greeter.kt");
  const up = await settle(() => kotlinLog(page), (l) => /initialize succeeded|failed to start|has expired|no server/.test(l), 180000, 3000);
  await snap(page, "server");
  let hover = "";
  if (/initialize succeeded/.test(up.value ?? "")) {
    await openFile(page, "Greeter.kt");
    hover = (await settle(() => hoverAt(page, 4, 10), (h) => /fun greet/.test(h), 180000, 5000)).value ?? "";
  }
  emit({ phase: "server", log: (up.value ?? "").slice(-2000), timedOut: !!up.timedOut, hover: hover.slice(0, 300) });
  // Case 2: a type mismatch, reported by the server — the first diagnostic of
  // a session is the slow one (RFC 0008 §11 Measured: up to 76 s).
  await openFile(page, "Greeter.kt");
  await chord(page, "Control", "g");
  await sleep(300);
  await page.keyboard.type("4:1");
  await page.keyboard.press("Enter");
  await page.keyboard.type('    val broken: Int = "no"\n');
  const t0 = Date.now();
  const diag = await settle(() => problems(page), (rows) => rows.some((r) => /mismatch|String/.test(r) && /Greeter|Ln 4/.test(r)), 240000, 5000);
  await snap(page, "diagnostic");
  emit({ phase: "diagnostic", rows: (diag.value ?? []).slice(0, 10), ms: Date.now() - t0, timedOut: !!diag.timedOut });
  await runCommand(page, "File: Revert File");
  // Case 3: the Kotlin DSL is the same language, the same server.
  await openFile(page, "app/build.gradle.kts");
  await sleep(3000);
  const mode = await languageMode(page);
  const logAfter = await kotlinLog(page);
  // The server's own log: its Gradle import read the Kotlin DSL scripts.
  const serverLog = readIfPresent(path.join(args["server-log"] ?? "", "")) ?? "";
  emit({
    phase: "kts",
    mode,
    starts: (logAfter.match(/starting: kotlin-server/g) ?? []).length,
    imported: /Apply build file 'app\/build\.gradle\.kts' to project ':app' succeeded/.test(serverLog),
  });
  // Case 7: the panel tab, and the server's cap in the container's sum.
  const tab = await kotlinTab(page);
  await runCommand(page, "Java: Show the container's resources");
  await sleep(1500);
  const resources = (await outputLines(page)).join(" ");
  await snap(page, "tab");
  emit({ phase: "tab", tab, inSum: /kotlin-ls \(declared\)/.test(resources), resources: resources.slice(-600) });
} catch (e) {
  if (!(e instanceof StopSuite)) {
    await snap(page, "error");
    console.error(e);
    process.exitCode = 1;
  }
} finally {
  await ctx.close().catch(() => {});
  await browser.disconnect();
}

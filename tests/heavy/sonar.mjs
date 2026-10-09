#!/usr/bin/env node
// The browser half of the `sonar` heavy half (RFC 0016 phase 1): a real VS
// Code web workbench with redhat.java, java-core and — unless `--absent` —
// SonarLint, the maven-multi fixture plus a TODO. One JSON line per
// measurement; view.sh asserts.
//
//   node sonar.mjs --url <workbench> --shots <dir> --cdp <http://host:port> --workspace <dir> [--absent 1]
//
//   view       the Inspections view's rows and the Problems panel's
//   resources  "Java: Show the container's resources"
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
const snap = (page, name) => page.screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, "0")}-sonar${ABSENT ? "-absent" : ""}-${name}.png`) }).catch(() => {});
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
      .$$eval(".quick-input-list .monaco-list-row", (els, n) => els.some((e) => e.innerText.includes(n)), name)
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


const ABSENT = !!args.absent;
const browser = await puppeteer.connect({ browserURL: CDP });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1360, height: 900 });

/** Every row of the Inspections view: the list is virtualised, so it is paged through from the top. */
const inspectionsView = async () => {
  await runCommand(page, "Java: Focus on Inspections View");
  await sleep(1200);
  const read = () => page.$$eval('.pane:has(.pane-header[aria-label*="Inspections"]) .monaco-list-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
  await page.keyboard.press("Home");
  await sleep(300);
  const seen = [];
  // Rows repeat (a file's name under several rules): stop after three pages with nothing new.
  for (let i = 0, idle = 0; i < 20 && idle < 3; i++) {
    const before = seen.length;
    for (const r of await read()) if (!seen.includes(r)) seen.push(r);
    idle = seen.length === before ? idle + 1 : 0;
    await page.keyboard.press("PageDown");
    await sleep(300);
  }
  return seen;
};
const problems = async () => {
  await runCommand(page, "View: Focus Problems");
  await sleep(1500);
  return page.$$eval(".markers-panel .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
};

try {
  const trust = async () => {
    await settle(() => javaStatus(page), (s) => s.length > 0, 90000);
    for (let i = 0; i < 10 && (await trustWorkspace(page).catch(() => "retry")) !== "already trusted"; i++) await sleep(1500);
  };
  await openWorkbench(page);
  await trust();
  const core = await outputLines(page).catch(() => []);
  if (/wrote java\.jdt\.ls\.java\.home/.test(core.join(" "))) {
    await dismissDialogs(page, /^(Reload|Yes|OK)/);
    await openWorkbench(page);
    await trust();
  }
  await settle(() => javaStatus(page), (s) => s.some((i) => /Server mode: Standard/.test(i.label)), 300000, 3000);
  await openFile(page, "Greeter.java");
  await openFile(page, "Todo.java");
  // The bundle's rows and, when installed, SonarLint's.
  const view = await settle(
    inspectionsView,
    (rows) => rows.some((r) => /collections\/sizeIsZero/.test(r)) && (ABSENT ? rows.some((r) => /SonarLint is not installed/.test(r)) : rows.some((r) => /sonar\/java:S1135/.test(r))),
    300000,
    5000,
  );
  const probs = await problems();
  await snap(page, "view");
  emit({ phase: "view", rows: view.value ?? [], timedOut: !!view.timedOut, ms: view.ms, problems: probs.slice(0, 30) });
  const resources = (await outputLines(page, "Java: Show the container's resources").catch(() => [])).join(" ");
  emit({ phase: "resources", tail: resources.slice(-700) });
} catch (e) {
  console.error(e);
  await snap(page, "error");
  process.exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
  await browser.disconnect();
}

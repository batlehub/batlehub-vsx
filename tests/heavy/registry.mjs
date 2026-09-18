#!/usr/bin/env node
// The registry-link scenario of RFC 0001 phase 5 (decision 39 puts it with
// the BatleHub halves): batlehub-vsx signed in through BATLEHUB_TOKEN,
// java-core with `registry.enabled: true` pointing at the run's Maven
// registry, a Maven folder open. The driver trusts the folder and waits for
// the core's log to say the link was written with a token from batlehub-vsx;
// the shell then reads the files the core wrote and runs a real Maven
// through the mirror.
//
//   node registry.mjs --url <workbench> --shots <dir> --cdp <http://host:port>
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "..", "extensions", "batlehub-vsx", "package.json"));
const puppeteer = require("puppeteer-core");

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const URL_ = args.url;
const SHOTS = args.shots;
const CDP = args.cdp;
if (!URL_ || !SHOTS || !CDP) {
  console.error("usage: registry.mjs --url --shots --cdp");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log(JSON.stringify(o));
const norm = (s) => (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
let shot = 0;
const snap = (page, name) => page.screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, "0")}-registry-${name}.png`) }).catch(() => {});
async function chord(page, modifier, key) {
  await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  await page.keyboard.up(modifier);
}

async function runCommand(page, title) {
  await page.keyboard.press("F1");
  const input = await page.waitForSelector(".quick-input-widget input", { timeout: 20000 });
  await input.focus();
  await chord(page, "Control", "a");
  await page.keyboard.type(`>${title}`);
  await sleep(1200);
  const rows = await page.$$eval(".quick-input-widget .monaco-list-row", (els) => els.map((e) => (e.querySelector(".label-name") ?? e).textContent.replace(/\s+/g, " ").trim()));
  const i = rows.findIndex((r) => r === title || r.startsWith(`${title} `) || r.startsWith(`${title}…`));
  if (i > 0) (await page.$$(".quick-input-widget .monaco-list-row"))[i]?.click();
  else await page.keyboard.press("Enter");
  await sleep(800);
}

async function outputLines(page, command) {
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

async function trustWorkspace(page) {
  const restricted = await page.$$eval(".statusbar-item", (els) => els.some((e) => /Restricted Mode/.test(e.innerText))).catch(() => false);
  if (!restricted) return "already trusted";
  await runCommand(page, "Workspaces: Manage Workspace Trust");
  await page.waitForSelector(".workspace-trust-editor .monaco-button, .workspace-trust-editor button", { timeout: 20000 }).catch(() => null);
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

async function settle(fn, ok, timeout, every = 2000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (ok(last)) return { value: last, ms: Date.now() - t0 };
    await sleep(every);
  }
  return { value: last, ms: Date.now() - t0, timedOut: true };
}

const browser = await puppeteer.connect({ browserURL: CDP });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1360, height: 900 });
try {
  await page.goto(URL_, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await sleep(3000);
  const how = await trustWorkspace(page);
  // The link is applied on the first detection after trust; the log names the URL and whether a token came.
  const link = await settle(() => outputLines(page, "Java: Show log"), (l) => l.some((x) => /registry link (enabled|disabled)/.test(x)), 120000, 4000);
  await snap(page, "linked");
  const joined = link.value.join(" ");
  const status = await page.$$eval(".statusbar-item", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter((t) => /BatleHub|Java/.test(t))).catch(() => []);
  emit({ phase: "link", how, timedOut: !!link.timedOut, enabled: /registry link enabled/.test(joined), withToken: /token from batlehub-vsx/.test(joined), line: link.value.find((x) => /registry link/.test(x)) ?? "", status });
} finally {
  await page.close().catch(() => {});
  await ctx.close().catch(() => {});
  browser.disconnect();
}

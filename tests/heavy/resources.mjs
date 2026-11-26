#!/usr/bin/env node
// The browser half of the `resources` phase of tests/heavy/view.sh:
// che-resources in a real VS Code web build, what it shows read off the DOM.
//
//   node resources.mjs --url <workbench> --shots <dir> --cdp <http://host:port>
//
// The suite seeds `cheResources.memory.threshold: 1` in the Machine settings,
// so memory is over its threshold whatever the runner has, and a 2 s interval.
//
// Phases, one JSON line each:
//   status   our status bar item (text, background against the theme's
//            warning token) and the warning toast
//   view     the item clicked: the Che Resources view, its rows (label and
//            description) and the activity bar badge
//
// Selectors are the workbench's own class names (1.96–1.136): `.statusbar-item`,
// `.notification-list-item-message`, `.monaco-list-row`, `.activitybar`.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "..", "extensions", "batlehub-vsx", "package.json"));
const puppeteer = require("puppeteer-core");

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
for (const k of ["url", "shots", "cdp"])
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log(JSON.stringify(o));
let shot = 0;
const snap = (page, name) =>
  page
    .screenshot({ path: path.join(args.shots, `${String(++shot).padStart(2, "0")}-resources-${name}.png`) })
    .catch(() => {});

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

/** Our status bar item: the workbench prefixes the id with the extension id. */
const item = (page) =>
  page
    .$$eval(".statusbar-item", (els) => {
      const root = document.querySelector(".monaco-workbench") ?? document.documentElement;
      const warning = getComputedStyle(root).getPropertyValue("--vscode-statusBarItem-warningBackground").trim();
      return els
        .filter((e) => /che-resources/i.test(e.id))
        .map((e) => ({
          id: e.id,
          text: e.innerText.replace(/\s+/g, " ").trim(),
          background: getComputedStyle(e).backgroundColor,
          warning,
        }));
    })
    .then((xs) => xs[0])
    .catch(() => undefined);

const toasts = (page) =>
  page
    .$$eval(".notification-list-item-message", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()))
    .catch(() => []);

/** The rows of the view, wherever the sidebar put it. */
const rows = (page) =>
  page
    .$$eval('[id="workbench.view.extension.cheResources"] .monaco-list-row', (els) =>
      els.map((e) => ({
        label: (e.querySelector(".label-name")?.textContent ?? "").trim(),
        description: (e.querySelector(".label-description")?.textContent ?? "").trim(),
        warning: !!e.querySelector(".codicon-warning"),
      })),
    )
    .catch(() => []);

const badge = (page) =>
  page
    .$$eval(".activitybar .action-item", (els) =>
      els
        .filter((e) => /Che Resources/.test(e.querySelector("[aria-label]")?.getAttribute("aria-label") ?? ""))
        .map((e) => (e.querySelector(".badge-content")?.textContent ?? "").trim()),
    )
    .then((xs) => xs[0] ?? "")
    .catch(() => "");

const browser = await puppeteer.connect({ browserURL: args.cdp });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1360, height: 900 });

try {
  await page.goto(args.url, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });

  // CPU needs two samples, so wait for it rather than for the first paint.
  const s = await settle(() => item(page), (i) => !!i && /mem/.test(i.text) && /cpu/.test(i.text), 90000);
  const t = await settle(() => toasts(page), (xs) => xs.some((x) => x.startsWith("Che Resources: Memory")), 30000);
  await snap(page, "status");
  emit({ phase: "status", ms: s.ms, item: s.value, toasts: t.value, timedOut: !!(s.timedOut || t.timedOut) });

  // The path a person takes: the item opens the view.
  await page.click(`[id="${s.value.id}"] a, [id="${s.value.id}"]`);
  const v = await settle(() => rows(page), (rs) => rs.some((r) => r.label === "CPU"), 30000);
  await snap(page, "view");
  emit({ phase: "view", ms: v.ms, rows: v.value, badge: await badge(page), timedOut: !!v.timedOut });
} finally {
  await page.close().catch(() => {});
  await ctx.close().catch(() => {});
  browser.disconnect();
}

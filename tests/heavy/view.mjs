#!/usr/bin/env node
// The browser half of tests/heavy/view.sh: drives a real VS Code web
// workbench over the Chrome DevTools protocol and prints one JSON line per
// measurement. The shell suite owns the servers, the editor and the
// assertions; this file only looks and clicks.
//
//   node view.mjs --url <workbench> --shots <dir> --cdp <http://host:port>
//        --phase marketplace|broker [--match <text>] [--after-anon <cmd>]
//
// marketplace  (a stock build: the editor's gallery cannot be repointed)
//   welcome   the BatleHub view's welcome text, or the rows it lists
//   rows      the marketplace tree after it settled: name, description, actions
//   install   the row matching --match: its inline Install clicked, what the
//             editor said, the row's state after
//   installed the editor's own Extensions view asked for "@installed <match>"
//   status    the status bar item of the extension
//   log       the lines of the "BatleHub" output channel
//
// broker  (the editor's gallery is the local proxy; the extension brokers)
//   welcome   the Account view before any credential; the status bar
//   browse    the Extensions view unauthenticated: the sign-in entry alone
//   after-anon  --after-anon run (the suite gives the CLI a credential)
//   refresh   "BatleHub: Refresh the credential now" run from the palette
//   search    the Extensions view after the re-query: the real extension
//   status    the status bar item after
//
// Selectors are the workbench's own class names (1.96–1.136): `.activitybar`,
// `.sidebar .monaco-list-row`, `.welcome-view-content`, `.statusbar-item`,
// `.quick-input-widget`, `.extensions-viewlet`, `.notification-list-item-message`.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
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
const PHASE = need("phase");
const MATCH = args.match ?? "Weebo";
const SIGN_IN = "Sign in to BatleHub";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log(JSON.stringify(o));
let shot = 0;
const snap = (page, name) => page.screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, "0")}-${PHASE}-${name}.png`) }).catch(() => {});
const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();

async function dismissDialogs(page) {
  for (const b of await page.$$(".monaco-dialog-box .dialog-buttons .monaco-button, .monaco-dialog-box .dialog-buttons a")) {
    const t = norm(await b.evaluate((e) => e.textContent));
    if (/^(Yes|Trust|OK)/.test(t)) {
      await b.click();
      await sleep(800);
    }
  }
}

async function notifications(page) {
  return page
    .$$eval(".notifications-toasts .notification-list-item-message, .notifications-list-container .notification-list-item-message", (els) =>
      els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean),
    )
    .catch(() => []);
}

async function clickActivity(page, labelPrefix) {
  const el = await page.waitForSelector(`.activitybar [aria-label^="${labelPrefix}"]`, { timeout: 60000 });
  // Clicking the active item hides the side bar (a toggle): only click a
  // container that is not already the one shown.
  const active = await el.evaluate((e) => !!e.closest(".action-item")?.classList.contains("checked"));
  if (!active) await el.click();
  await sleep(1000);
}

/** The BatleHub side bar: its welcome text (if any) and its list rows. */
async function sideBar(page) {
  const welcome = await page
    .$$eval(".sidebar .welcome-view-content", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean))
    .catch(() => []);
  const rows = await page
    .$$eval(".sidebar .monaco-list-row", (els) =>
      els.map((e) => ({
        name: (e.querySelector(".monaco-icon-label .label-name, .monaco-icon-label-container .label-name")?.textContent ?? "").trim(),
        description: (e.querySelector(".label-description")?.textContent ?? "").trim(),
        actions: [...e.querySelectorAll(".actions .action-label")].map((a) => a.getAttribute("aria-label") || a.getAttribute("title") || a.className).filter(Boolean),
      })),
    )
    .catch(() => []);
  const title = norm(await page.$eval(".sidebar .composite.title", (e) => e.innerText).catch(() => ""));
  return { title, welcome, rows };
}

async function settleSideBar(page, ok, timeout = 60000) {
  const t0 = Date.now();
  let last = { title: "", welcome: [], rows: [] };
  while (Date.now() - t0 < timeout) {
    last = await sideBar(page);
    if (ok(last)) return last;
    await sleep(700);
  }
  return last;
}

async function statusBar(page) {
  return page
    .$$eval(".statusbar-item", (els) =>
      els.map((e) => ({ id: e.id, text: e.innerText.replace(/\s+/g, " ").trim(), title: e.getAttribute("aria-label") || e.title || "" })).filter((x) => /BatleHub/.test(x.text) || /BatleHub/.test(x.title)),
    )
    .catch(() => []);
}

async function settleStatus(page, ok, timeout = 60000) {
  const t0 = Date.now();
  let last = [];
  while (Date.now() - t0 < timeout) {
    last = await statusBar(page);
    if (ok(last)) return last;
    await sleep(700);
  }
  return last;
}

/** Run a command by its palette title. */
async function runCommand(page, title) {
  await page.keyboard.press("F1");
  const input = await page.waitForSelector(".quick-input-widget input", { timeout: 20000 });
  await input.focus();
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type(`>${title}`);
  await sleep(1200);
  const rows = await page.$$eval(".quick-input-widget .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));
  await page.keyboard.press("Enter");
  await sleep(800);
  return rows;
}

/** The lines of the "BatleHub" output channel, once "Show log" ran. */
async function outputLines(page) {
  await runCommand(page, "BatleHub: Show log");
  await sleep(1500);
  // The output editor is virtualised and word-wraps: take what is rendered; the
  // suite joins the lines before it looks for anything.
  const lines = await page
    .$$eval(".part.panel .monaco-editor .view-lines .view-line", (els) => els.map((e) => e.innerText.replace(/ /g, " ").replace(/\s+$/, "")).filter(Boolean))
    .catch(() => []);
  return lines;
}

/** The editor's own Extensions view asked for `query`. */
async function extensionsView(page, query, ok, timeout = 60000) {
  await clickActivity(page, "Extensions");
  await page.waitForSelector(".extensions-viewlet", { timeout: 30000 });
  // Type the query and check it landed: the workbench can move focus (the
  // welcome page, a notification) between the click and the keystrokes.
  for (let attempt = 0; attempt < 5; attempt++) {
    const box = await page.waitForSelector(".extensions-viewlet textarea", { timeout: 30000 });
    await box.click();
    await sleep(300);
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await sleep(300);
    if (query) await page.keyboard.type(query);
    await sleep(500);
    const value = await box.evaluate((e) => e.value);
    if (value === query) break;
    await sleep(1000);
  }
  const listed = () =>
    page.$$eval(".extensions-viewlet .extension-list-item", (els) =>
      els.map((e) => ({
        name: e.querySelector(".name")?.textContent?.trim() ?? "",
        publisher: e.querySelector(".publisher-name, .publisher")?.textContent?.trim() ?? "",
        actions: [...e.querySelectorAll(".extension-action")]
          .filter((a) => !a.classList.contains("hide") && a.offsetParent !== null)
          .map((a) => a.textContent.trim() || a.getAttribute("aria-label") || "")
          .filter(Boolean),
      })),
    );
  const t0 = Date.now();
  let rows = [];
  while (Date.now() - t0 < timeout) {
    rows = await listed().catch(() => []);
    if (ok(rows)) break;
    await sleep(700);
  }
  return rows;
}

const browser = await puppeteer.connect({ browserURL: CDP });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1360, height: 900 });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});

try {
  await page.goto(URL_, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await sleep(4000);
  await dismissDialogs(page);

  if (PHASE === "marketplace") {
    await clickActivity(page, "BatleHub");
    await snap(page, "view-opened");
    const first = await sideBar(page);
    emit({ phase: "welcome", ...first });

    const rows = await settleSideBar(page, (s) => s.rows.some((r) => r.name.includes(MATCH)));
    await snap(page, "rows");
    emit({ phase: "rows", rows: rows.rows, welcome: rows.welcome });

    // The inline Install of the matching row: hover reveals the actions.
    let clicked = false;
    for (const row of await page.$$(".sidebar .monaco-list-row")) {
      const name = await row.$eval(".label-name", (e) => e.textContent.trim()).catch(() => "");
      if (!name.includes(MATCH)) continue;
      await row.hover();
      await sleep(500);
      const btn = await row.$('.actions .action-label[aria-label="Install"], .actions .action-label[title="Install"]');
      if (btn) {
        await btn.click();
        clicked = true;
      }
      break;
    }
    if (!clicked) {
      // A row whose actions did not render on hover: the command palette route.
      await runCommand(page, `BatleHub: Install extension by id`);
    }
    const seen = new Set();
    const t0 = Date.now();
    let after = null;
    while (Date.now() - t0 < 120000) {
      await dismissDialogs(page);
      for (const n of await notifications(page)) seen.add(n);
      const s = await sideBar(page);
      after = s.rows.find((r) => r.name.includes(MATCH)) ?? null;
      if ([...seen].some((n) => /BatleHub: installed|failed|Not installed|not in/.test(n))) break;
      if (after && /installed/.test(after.description)) break;
      await sleep(800);
    }
    await snap(page, "installed");
    emit({ phase: "install", clicked, row: after, notifications: [...seen] });

    const inst = await extensionsView(page, `@installed ${MATCH.toLowerCase()}`, (r) => r.length > 0, 30000);
    await snap(page, "extensions-installed");
    emit({ phase: "installed", entries: inst });

    emit({ phase: "status", items: await statusBar(page) });
    const lines = await outputLines(page);
    await snap(page, "log");
    emit({ phase: "log", lines });
  } else if (PHASE === "broker") {
    await clickActivity(page, "BatleHub");
    await snap(page, "account-anon");
    const s0 = await settleSideBar(page, (s) => s.welcome.length > 0, 30000);
    const st0 = await settleStatus(page, (items) => items.some((i) => /sign in|expired/i.test(i.text)), 30000);
    emit({ phase: "welcome", ...s0, status: st0 });

    const browse = await extensionsView(page, MATCH.toLowerCase(), (r) => r.some((x) => x.name === SIGN_IN), 60000);
    await snap(page, "browse-anon");
    emit({ phase: "browse", entries: browse });

    if (args["after-anon"]) {
      execSync(args["after-anon"], { stdio: "inherit" });
      emit({ phase: "after-anon", ran: args["after-anon"] });
    }

    const palette = await runCommand(page, "BatleHub: Refresh the credential now");
    emit({ phase: "refresh", palette });
    const st1 = await settleStatus(page, (items) => items.some((i) => /BatleHub: (oidc|pat|kubernetes)/.test(i.text)), 60000);
    await snap(page, "status-signed");

    // The Extensions view still shows the query typed while unauthenticated.
    // Nothing is retyped: the same text again would be answered from the
    // view's own cache. What changes the list is the extension's re-query
    // after it wrote the contract file — the property under test.
    const listedNow = () =>
      page.$$eval(".extensions-viewlet .extension-list-item", (els) =>
        els.map((e) => ({
          name: e.querySelector(".name")?.textContent?.trim() ?? "",
          publisher: e.querySelector(".publisher-name, .publisher")?.textContent?.trim() ?? "",
          actions: [...e.querySelectorAll(".extension-action")]
            .filter((a) => !a.classList.contains("hide") && a.offsetParent !== null)
            .map((a) => a.textContent.trim() || a.getAttribute("aria-label") || "")
            .filter(Boolean),
        })),
      );
    let search = [];
    let viaViewRefresh = false;
    const tq = Date.now();
    while (Date.now() - tq < 90000) {
      search = await listedNow().catch(() => []);
      if (search.length > 0 && !search.some((x) => x.name === SIGN_IN)) break;
      if (Date.now() - tq > 45000 && !viaViewRefresh) {
        // The fallback a person has: the view's own Refresh. Recorded, so the
        // suite knows the extension's re-query did not do it alone.
        const btn = await page.$('.extensions-viewlet .action-label[aria-label="Refresh"], .extensions-viewlet .codicon-extensions-refresh');
        if (btn) {
          await btn.click();
          viaViewRefresh = true;
        }
      }
      await sleep(1000);
    }
    await snap(page, "search-signed");
    emit({ phase: "search", entries: search, viaViewRefresh });
    emit({ phase: "status", items: st1 });
    const lines = await outputLines(page);
    emit({ phase: "log", lines });
  } else {
    console.error(`unknown --phase ${PHASE}`);
    process.exit(2);
  }
  emit({ phase: "console", errors: consoleErrors.length, sample: consoleErrors.slice(0, 3) });
} finally {
  await page.close().catch(() => {});
  await ctx.close().catch(() => {});
  browser.disconnect();
}

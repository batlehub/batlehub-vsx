#!/usr/bin/env node
// The browser half of the `seasons` phase of tests/heavy/view.sh (RFC 0019
// §10): batlehub-seasons in a real VS Code web build, the chrome it painted
// read off the DOM, and the undo driven from the command palette.
//
//   node seasons.mjs --url <workbench> --shots <dir> --cdp <http://host:port>
//        --seed '<one-line json>' --background #rrggbb --glyph 🎃
//        --name "Heavy day" --title heavy-title-marker
//
// Phases, one JSON line each:
//   applied    the painted title bar, activity bar and status bar, the
//              workbench ground, the browser tab's title and our status bar
//              item, with a one-day window covering today
//   removed    the same, after `Seasons: Disable until next year` ran from the
//              palette
//   persisted  the same again after a window reload: nothing the extension
//              left behind reapplies, which is the claim `_saved` exists for
//
// Why the settings are typed rather than seeded into a file: every setting of
// this extension is `scope: "application"` (RFC 0019 §7), and in the web build
// user settings live in the browser, not in the server's data dir — a
// settings.json dropped on disk is read by nobody (the first two runs of this
// half seeded one and the editor ignored it). Typing them through
// `Preferences: Open User Settings (JSON)` is both the only way in and the
// path a person actually takes. The suite's Machine settings turn Monaco's
// auto-closing off so the typed text arrives literally, and the seed is one
// line so no auto-indent can touch it.
//
// Selectors are the workbench's own class names (1.96–1.136): `.monaco-workbench`,
// `.titlebar`, `.activitybar`, `.statusbar`, `.statusbar-item`, `.quick-input-widget`.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  path.join(here, "..", "..", "extensions", "batlehub-vsx", "package.json"),
);
const puppeteer = require("puppeteer-core");

const args = {};
for (let i = 2; i < process.argv.length; i += 2)
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
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
const SEED = need("seed");
const BACKGROUND = need("background").toLowerCase();
const GLYPH = need("glyph");
const NAME = need("name");
const TITLE = need("title");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (o) => console.log(JSON.stringify(o));
let shot = 0;
const snap = (page, name) =>
  page
    .screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, "0")}-seasons-${name}.png`) })
    .catch(() => {});
const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();

/** `rgb(122, 31, 107)` → `#7a1f6b`, so an assertion can compare to the manifest. */
function hexOf(value) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value ?? "");
  if (!m) return value ?? "";
  const hex = (n) => Number(n).toString(16).padStart(2, "0");
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

async function dismissDialogs(page) {
  for (const b of await page.$$(
    ".monaco-dialog-box .dialog-buttons .monaco-button, .monaco-dialog-box .dialog-buttons a",
  )) {
    if (/^(Yes|Trust|OK|Save)/.test(norm(await b.evaluate((e) => e.textContent)))) {
      await b.click();
      await sleep(800);
    }
  }
}

async function chord(page, modifier, key) {
  await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  await page.keyboard.up(modifier);
}

/** Run a palette command by its exact title (the ranking puts others first for a prefix). */
async function runCommand(page, title, enter = true) {
  await page.keyboard.press("F1");
  const input = await page.waitForSelector(".quick-input-widget input", { timeout: 20000 });
  await input.focus();
  await chord(page, "Control", "a");
  await page.keyboard.type(`>${title}`);
  await sleep(1500);
  const rows = await page.$$eval(".quick-input-widget .monaco-list-row", (els) =>
    els.map((e) => (e.querySelector(".label-name") ?? e).textContent.replace(/\s+/g, " ").trim()),
  );
  if (enter) {
    const i = rows.findIndex((r) => r === title || r.startsWith(`${title} `));
    if (i > 0) {
      const handles = await page.$$(".quick-input-widget .monaco-list-row");
      await handles[i]?.click();
    } else await page.keyboard.press("Enter");
    await sleep(1500);
  }
  return rows;
}

async function openWorkbench(page) {
  await page.goto(URL_, { waitUntil: "load", timeout: 60000 });
  await page.waitForSelector(".monaco-workbench", { timeout: 60000 });
  await sleep(2500);
  await dismissDialogs(page);
}

/** Replace the user settings with one line of JSON, through the editor itself. */
async function writeUserSettings(page, json) {
  await runCommand(page, "Preferences: Open User Settings (JSON)");
  await page.waitForSelector(".monaco-editor .view-lines", { timeout: 30000 });
  await sleep(1500);
  await page.click(".monaco-editor .view-lines");
  await chord(page, "Control", "a");
  await page.keyboard.type(json);
  await sleep(800);
  await chord(page, "Control", "s");
  await sleep(2500);
  await dismissDialogs(page);
}

/**
 * A real navigation, not `Developer: Reload Window`: that command left the
 * extension host alive (one `exthost1` in the server's logs for the whole
 * run) and so the extension never activated a second time.
 */
async function reloadWindow(page) {
  await openWorkbench(page);
  await sleep(3000);
}

/** What the editor painted, not what the setting says. */
const chrome = (page) =>
  page.evaluate(() => {
    // The editor declares --vscode-* on the workbench; custom properties
    // inherit, so reading them there works either way.
    const root = document.querySelector(".monaco-workbench") ?? document.documentElement;
    const token = (n) => getComputedStyle(root).getPropertyValue(`--vscode-${n}`).trim();
    const bg = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).backgroundColor : "";
    };
    const fg = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).color : "";
    };
    return {
      titleBar: bg(".monaco-workbench .titlebar"),
      titleBarText: fg(".monaco-workbench .titlebar"),
      activityBar: bg(".monaco-workbench .activitybar"),
      statusBar: bg(".monaco-workbench .statusbar"),
      documentTitle: document.title,
      // The surface code is read on, as a token rather than as an element's
      // background: this is the value RFC 0014's contrast test makes its
      // promise about, and the one RFC 0019 §5.3 says the overlay never
      // touches. `.monaco-workbench`'s own background is not it — in a
      // no-folder window it tracks the title bar.
      ground: token("editor-background"),
      // Everything the overlay claims, as the editor resolved it, so a failure
      // says which key did not arrive rather than only that a pixel is wrong.
      tokens: {
        titleBarBg: token("titleBar-activeBackground"),
        titleBarFg: token("titleBar-activeForeground"),
        activityBarBg: token("activityBar-background"),
        activityBarFg: token("activityBar-foreground"),
        statusBarBg: token("statusBar-background"),
        statusBarFg: token("statusBar-foreground"),
        statusBarNoFolderBg: token("statusBar-noFolderBackground"),
      },
    };
  });

const hexes = (c) => ({
  titleBar: hexOf(c.titleBar).toLowerCase(),
  activityBar: hexOf(c.activityBar).toLowerCase(),
  statusBar: hexOf(c.statusBar).toLowerCase(),
  // Already a hex: a --vscode-* token is the theme's own string.
  ground: (c.ground ?? "").toLowerCase(),
});

/** Our status bar item: the workbench prefixes the id with the extension id. */
const seasonsItem = (page) =>
  page
    .$$eval(".statusbar-item", (els) =>
      els.map((e) => ({
        id: e.id,
        text: e.innerText.replace(/\s+/g, " ").trim(),
        label: e.getAttribute("aria-label") || "",
      })),
    )
    .then((items) => items.filter((i) => /seasons/i.test(i.id) || /seasons/i.test(i.label)))
    .catch(() => []);

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

const browser = await puppeteer.connect({ browserURL: CDP });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1360, height: 900 });

try {
  await openWorkbench(page);
  // The chrome before anything of ours: what "the theme's colour again" means.
  // Settled over two identical reads, because the first paint is the default
  // light theme and `workbench.colorTheme` arrives a moment later.
  let previous = null;
  const base = await settle(
    async () => {
      const now = hexes(await chrome(page));
      const same = previous && JSON.stringify(previous) === JSON.stringify(now);
      previous = now;
      return same ? now : null;
    },
    (v) => v !== null,
    30000,
    1500,
  );
  const theme = base.value ?? hexes(await chrome(page));

  // 1. The window: a one-day user entry covering today, typed into the user
  // settings. The config surface is its own test seam, which is why the
  // extension has no date-forcing setting (RFC 0019 §10).
  await writeUserSettings(page, SEED);
  await snap(page, "settings");
  await reloadWindow(page);

  const item = await settle(() => seasonsItem(page), (s) => s.length > 0, 90000);
  const painted = await settle(() => chrome(page), (c) => hexes(c).titleBar === BACKGROUND, 60000);
  await snap(page, "applied");
  emit({
    phase: "applied",
    ms: painted.ms,
    itemMs: item.ms,
    items: item.value,
    chrome: painted.value,
    hex: hexes(painted.value),
    tokens: painted.value.tokens,
    theme,
    expected: BACKGROUND,
    glyph: GLYPH,
    name: NAME,
    title: TITLE,
    timedOut: !!painted.timedOut,
  });

  // 2. The undo, from the palette: the status bar item's own command, which is
  // the path a person takes.
  const rows = await runCommand(page, "Seasons: Disable until next year");
  const gone = await settle(() => chrome(page), (c) => hexes(c).titleBar === theme.titleBar, 60000);
  await snap(page, "removed");
  emit({
    phase: "removed",
    ms: gone.ms,
    rows: rows.slice(0, 8),
    items: await seasonsItem(page),
    chrome: gone.value,
    hex: hexes(gone.value),
    theme,
    expected: BACKGROUND,
    glyph: GLYPH,
    title: TITLE,
    timedOut: !!gone.timedOut,
  });

  // 3. And it stays undone across a reload. This is the assertion the whole
  // _saved design exists for: whatever is left in the settings must not be
  // able to paint the chrome again.
  await reloadWindow(page);
  const after = await chrome(page);
  await snap(page, "persisted");
  emit({
    phase: "persisted",
    items: await seasonsItem(page),
    chrome: after,
    hex: hexes(after),
    theme,
    expected: BACKGROUND,
    glyph: GLYPH,
    title: TITLE,
  });
} finally {
  await page.close().catch(() => {});
  await ctx.close().catch(() => {});
  browser.disconnect();
}

#!/usr/bin/env node
// The browser half of the `java` heavy half (RFC 0001 §10 layer 4, decision
// 39): drives a real VS Code web workbench with `redhat.java`, `java-core`
// (with its JDT bundle) and `java-groovy` installed, a Maven fixture open,
// no BatleHub and no Postgres. One JSON line per measurement; the shell
// suite (view.sh) asserts.
//
//   node java.mjs --url <workbench> --shots <dir> --cdp <http://host:port>
//        --workspace <dir> [--after-baseline <cmd>] [--stop-after <phase>]
//
//   status     the Java status bar item as soon as it exists, and when (ms after load)
//   trusted    the folder trusted through the Workspace Trust editor; the item after the re-detection
//   log        the "BatleHub Java" channel after activation (the whole channel, scrolled)
//   reload     whether the editor was reloaded because the core wrote java.jdt.ls.java.home
//   ready      the status bar once the server mode is Standard, and when
//   log2       the channel after the reload: the pinned redhat.java, the activation time
//   bundle     the "BatleHub Java: JDT" channel: the bundle's ping
//   pick       the rows of "Java: Pick the JDK"
//   panel      the Java panel: its tabs, the accessibility roles, arrow keys, three themes
//   theme      RFC 0014: the three BatleHub themes, the chrome tokens and the panel under each
//   theme-tokens the rendered Java token colours under BatleHub Dark
//   explorer   the Projects view's rows
//   tasks      "Tasks: Run Task" → the batlehub-java rows
//   inspections the Problems panel on Greeter.java, then "Fix all" and the buffer after
//   generate   "Java: Getters and setters…" on Person.java: the buffer after (bundle) or Red Hat's picker
//   groovy     Hello.groovy opened: the registration line, the Groovy log, the hover
//   classpath  spike (a): the classpath before the m2e preference, --after-baseline, after re-import
//   remove     "Java: Remove BatleHub settings": the dialog, and .vscode/settings.json after
//   perf       activation, detection, status bar, ready and panel-paint times
//   console    the browser console's error count
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const snap = (page, name) => page.screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, "0")}-java-${name}.png`) }).catch(() => {});
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

/**
 * An output channel's lines as the editor writes them to disk
 * (`<server data>/logs/<session>/exthost<n>/output_logging_<time>/<n>-<name>.log`),
 * newest extension host last. The panel wraps long entries and its scroll
 * stops early on repeated fragments; the file does neither. The editor of
 * `java-ws` is `editor-java`, of `java-ws-desktop` `editor-java-desktop`.
 */
function channelLog(name) {
  const logs = path.join(path.dirname(WS), `editor-java${path.basename(WS).replace("java-ws", "")}`, "server", "data", "logs");
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(`-${name}.log`)) files.push(p);
    }
  };
  try {
    walk(logs);
  } catch {
    return [];
  }
  return files.flatMap((f) => readFileSync(f, "utf8").split("\n"));
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
  // 30 s: the first paint competes with every extension starting (cspell among them).
  for (let i = 0; i < 60; i++) {
    for (const f of page.frames()) {
      const has = await f.$('[role="tablist"][aria-label="Java panel tabs"]').catch(() => null);
      if (has) return f;
    }
    await sleep(500);
  }
  return null;
}

/** rgb(…)/rgba(…) as the theme files write it; a #hex passes through. */
function hexOf(value) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value ?? "");
  if (!m) return (value ?? "").trim().toLowerCase();
  const hex = (n) => Number(n).toString(16).padStart(2, "0");
  const alpha = m[4] === undefined || Number(m[4]) === 1 ? "" : hex(Math.round(Number(m[4]) * 255));
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}${alpha}`;
}

/** The --vscode-* tokens RFC 0014 §4.2 puts a BatleHub value on. */
const THEME_TOKENS = [
  "foreground",
  "focusBorder",
  "editor-background",
  "editor-foreground",
  "panelTitle-activeBorder",
  "button-background",
  "button-foreground",
  "textLink-foreground",
  "editorError-foreground",
  "editorWarning-foreground",
  "contrastBorder",
  "contrastActiveBorder",
];

/**
 * One BatleHub theme: the workbench ground as painted, the chrome tokens, and
 * the Java panel under it — its selected tab, every colour it renders, and
 * the focus ring on a keyboard-focused tab (RFC 0014 §2.1).
 */
async function themeProbe(page, label, shotName) {
  await setTheme(page, label);
  await clickActivity(page, "Java");
  await sleep(1200);
  const chrome = await page.evaluate((names) => {
    // The editor declares --vscode-* on the workbench, not on :root; custom
    // properties inherit, so reading them there works either way.
    const workbench = document.querySelector(".monaco-workbench") ?? document.documentElement;
    const cs = getComputedStyle(workbench);
    const out = { ground: cs.backgroundColor };
    for (const n of names) out[n] = cs.getPropertyValue(`--vscode-${n}`).trim();
    return out;
  }, THEME_TOKENS);
  const frame = await panelFrame(page);
  let panel = null;
  if (frame) {
    // A keyboard interaction, so :focus-visible really applies to the ring.
    await (await frame.$('[role="tab"]'))?.focus();
    await page.keyboard.press("ArrowRight");
    await sleep(400);
    panel = await frame.evaluate(() => {
      const selected = document.querySelector('[role="tab"][aria-selected="true"]');
      const sel = selected && getComputedStyle(selected);
      // Every colour the panel's own stylesheet renders. Native form
      // controls are left out: a radio or a select is painted by the user
      // agent, not by a --vscode-* token, so it is not the theme's to answer
      // for (RFC 0001 decision 18 is about the panel's own rules).
      const used = new Set();
      for (const el of document.querySelectorAll("body, body *")) {
        if (/^(INPUT|SELECT|TEXTAREA|OPTION)$/.test(el.tagName)) continue;
        const cs = getComputedStyle(el);
        for (const prop of ["color", "backgroundColor", "borderTopColor", "borderBottomColor", "borderLeftColor", "borderRightColor"]) {
          const v = cs[prop];
          if (v && v !== "rgba(0, 0, 0, 0)") used.add(v);
        }
      }
      const active = document.activeElement;
      const ring = active && active !== document.body ? getComputedStyle(active) : null;
      return {
        tabForeground: sel ? sel.color : "",
        tabUnderline: sel ? sel.borderBottomColor : "",
        used: [...used],
        ringColor: ring ? ring.outlineColor : "",
        ringWidth: ring ? ring.outlineWidth : "",
      };
    });
    await page.keyboard.press("Home");
    await sleep(300);
  }
  await snap(page, shotName);
  const asHex = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(hexOf) : hexOf(v)]));
  return { label, found: !!frame, chrome: asHex(chrome), panel: panel ? asHex(panel) : null };
}

/**
 * What the editor really painted the Java tokens: the four voices of §4.2 read
 * off the rendered spans, and every distinct colour in the buffer so the One
 * Synthetic Rule can be checked against the screen rather than against the
 * theme file.
 */
async function tokenColours(page, wanted) {
  const found = await page.evaluate((want) => {
    const spans = [...document.querySelectorAll(".view-lines span")].filter((s) => /(^|\s)mtk\d/.test(s.className));
    const out = { all: [], pick: {} };
    const all = new Set();
    for (const s of spans) if (s.textContent.trim()) all.add(getComputedStyle(s).color);
    out.all = [...all];
    for (const [name, text] of Object.entries(want)) {
      const at = text.startsWith("@");
      const wanted = at ? text.slice(1) : text;
      const hit = spans.find((s, i) => {
        const t = s.textContent.trim();
        // The editor merges neighbouring tokens of one colour into one span,
        // so a string whose quotes wear its colour reads `"Ada"`.
        if (!at) return t === text || t === `"${text}"`;
        // The grammar may give "@Test" one span or split off the "@";
        // either way, `Test` in an import is a type and not the annotation.
        return t === text || (t === wanted && spans[i - 1] && spans[i - 1].textContent.trim().endsWith("@"));
      });
      if (hit) out.pick[name] = getComputedStyle(hit).color;
    }
    return out;
  }, wanted);
  return { all: found.all.map(hexOf), pick: Object.fromEntries(Object.entries(found.pick).map(([k, v]) => [k, hexOf(v)])) };
}

/**
 * `Preferences: Color Theme` really applied. The command has to be *run* —
 * with `enter: false` the palette never opens the theme picker and the name
 * is typed into the command query instead, which is why the suite's three
 * "themes" used to be three screenshots of the same one.
 */
async function setTheme(page, name) {
  await runCommand(page, "Preferences: Color Theme");
  const input = await page.waitForSelector(".quick-input-widget input", { timeout: 20000 });
  await input.focus();
  await chord(page, "Control", "a");
  await page.keyboard.type(name);
  await sleep(1000);
  await page.keyboard.press("Enter");
  await sleep(1800);
}

/** The Problems panel's rows for the active file. */
async function problems(page) {
  await runCommand(page, "View: Focus Problems");
  await sleep(1500);
  return page.$$eval(".markers-panel .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
}

const browser = await puppeteer.connect({ browserURL: CDP });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1360, height: 900 });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});

const perf = {};
try {
  await openWorkbench(page);
  // 1. The status bar item, and how long after the page loaded it appeared.
  let st = await settle(() => javaStatus(page), (s) => s.length > 0, 90000);
  perf.statusBarMs = st.ms;
  await snap(page, "status");
  emit({ phase: "status", items: st.value, ms: st.ms });
  // 1b. RFC 0007 §4.3: the import's gate is the editor's trust, and this is
  // the one moment in the suite where the workspace is really untrusted. The
  // command must say so and write nothing — not even the experimental flag,
  // whose prompt is itself a write.
  await runCommand(page, "Java: Import from IntelliJ");
  await sleep(1500);
  const untrustedNotifications = await notifications(page);
  await snap(page, "idea-untrusted");
  emit({
    phase: "idea-untrusted",
    notifications: untrustedNotifications,
    settings: readIfPresent(path.join(WS, ".vscode", "settings.json")),
    profile: readIfPresent(path.join(WS, ".vscode", "batlehub-java", "formatter.xml")),
  });
  await dismissDialogs(page, /^(Cancel|Close)/);

  // The folder opens in Restricted Mode; the core activated before trust and
  // ran nothing. Trust it, then wait for the detection trust triggers.
  const how = await trustWorkspace(page);
  const trusted = await settle(() => javaStatus(page), (s) => s.length > 0 && !s.some((i) => /untrusted/.test(i.label)), 60000);
  await snap(page, "trusted");
  emit({ phase: "trusted", how, items: trusted.value, ms: trusted.ms, timedOut: !!trusted.timedOut });

  // 2. The channel after activation and the trusted detection.
  await sleep(1500);
  const lines = await outputLines(page);
  await snap(page, "log");
  emit({ phase: "log", lines });
  const joined = lines.join(" ");
  perf.detectionMs = Number(/detection in (\d+) ms/.exec(joined)?.[1] ?? -1);

  // 3. The newcomer story: no JAVA_HOME, `java` a manager shim with no
  // version — the core wrote java.jdt.ls.java.home, and the language server
  // needs a reload to see it.
  let reloaded = false;
  if (/wrote java\.jdt\.ls\.java\.home/.test(joined)) {
    reloaded = true;
    await dismissDialogs(page, /^(Reload|Yes|OK)/);
    await openWorkbench(page);
    st = await settle(() => javaStatus(page), (s) => s.length > 0, 90000);
  }
  emit({ phase: "reload", reloaded, notifications: await notifications(page) });

  // 4. The server reaches Standard mode (import done); the status bar says so.
  const ready = await settle(() => javaStatus(page), (s) => s.some((i) => /Server mode: Standard/.test(i.label)), 300000, 2000);
  perf.readyMs = ready.ms;
  await dismissDialogs(page);
  await snap(page, "ready");
  emit({ phase: "ready", items: ready.value, ms: ready.ms, timedOut: !!ready.timedOut });
  const lines2 = await outputLines(page);
  emit({ phase: "log2", lines: lines2 });
  perf.activationMs = Number(/activated in (\d+) ms/.exec(lines2.join(" "))?.[1] ?? -1);

  // 4b. The bundle's ping, in the JDT channel: it is probed after serverReady,
  // which on a cold ~/.m2 (a CI runner) waits for m2e to fetch the fixture's
  // plugins from Central — the same budget as the import above.
  const jdt = await settle(() => outputLines(page, "Java: Show the JDT log"), (l) => l.some((x) => /bundle loaded|ping failed/.test(x)), 300000, 3000);
  emit({ phase: "bundle", lines: jdt.value.slice(-8), loaded: jdt.value.some((x) => /bundle loaded/.test(x)) });

  // 5. The quick pick behind the status bar item.
  await runCommand(page, "Java: Pick the JDK");
  const pick = await quickPickRows(page);
  await snap(page, "pick");
  await page.keyboard.press("Escape");
  await sleep(500);
  emit({ phase: "pick", ...pick });

  // 6. The Java panel: tabs, the accessibility tree, arrow keys, three themes.
  await clickActivity(page, "Java");
  await sleep(1500);
  const frame = await panelFrame(page);
  const tabs = frame ? await frame.$$eval('[role="tab"]', (els) => els.map((e) => ({ text: e.textContent.trim(), selected: e.getAttribute("aria-selected"), tabindex: e.getAttribute("tabindex") }))) : [];
  const roles = frame ? await frame.$$eval("[role]", (els) => [...new Set(els.map((e) => e.getAttribute("role")))]) : [];
  const labelled = frame ? await frame.$$eval("table[aria-label], [aria-labelledby], input[aria-label]", (els) => els.length) : 0;
  let arrowMoved = false;
  if (frame) {
    const first = await frame.$('[role="tab"]');
    await first?.focus();
    await page.keyboard.press("ArrowRight");
    await sleep(400);
    const sel = await frame.$$eval('[role="tab"]', (els) => els.map((e) => e.getAttribute("aria-selected")));
    arrowMoved = sel[1] === "true";
    await page.keyboard.press("Home");
    await sleep(300);
  }
  await snap(page, "panel-dark");
  await setTheme(page, "Light Modern");
  await clickActivity(page, "Java");
  await snap(page, "panel-light");
  await setTheme(page, "Dark High Contrast");
  await clickActivity(page, "Java");
  await snap(page, "panel-hc");
  await setTheme(page, "Dark Modern");
  perf.panelPaintMs = Number(/panel first paint (\d+) ms/.exec((await outputLines(page)).join(" "))?.[1] ?? -1);
  emit({ phase: "panel", found: !!frame, tabs, roles, labelled, arrowMoved, paintMs: perf.panelPaintMs });

  // 6b. RFC 0014: the same panel under the three BatleHub themes, with the
  // chrome tokens read from the workbench rather than from the theme file.
  // Only when the theme VSIX is installed beside the core (view.sh).
  if (process.env.BATLEHUB_THEME === "1") {
    const dark = await themeProbe(page, "BatleHub Dark", "panel-batlehub-dark");
    const light = await themeProbe(page, "BatleHub Light", "panel-batlehub-light");
    const hc = await themeProbe(page, "BatleHub High Contrast", "panel-batlehub-hc");
    emit({ phase: "theme", dark, light, hc });

    // 6c. The four voices, as the editor painted them: Java under BatleHub
    // Dark with JDT.LS in Standard mode, so the semantic tokens are the
    // server's truth and not the grammar's guess.
    await setTheme(page, "BatleHub Dark");
    await openFile(page, "Greeter.java");
    await sleep(2500);
    // `greeting` is a call, so it is the `method` voice; `all` would be a
    // declaration and bold. Likewise the class is read from `Person`, a
    // reference: `Greeter` here is only ever its own declaration, which is
    // `class.declaration`, a voice of its own since the editor's colours. The string is read from MainTest.java's
    // "Ada": an empty literal is two punctuation quotes and no string span.
    // Settled on the theme's own voices rather than a fixed sleep: before the
    // semantic tokens arrive the spans wear TextMate's colours, and a run
    // that reads them too early sees `class` as `method`. A voice that never
    // arrives times out, and the assertion fails on what was last painted.
    const voices = JSON.parse(readFileSync(path.join(here, "..", "..", "extensions", "batlehub-theme", "themes", "batlehub-dark.json"), "utf8")).semanticTokenColors;
    const painted = (want) => (r) => Object.keys(want).every((k) => r.pick[k] === String(voices[k]?.foreground ?? voices[k]).toLowerCase());
    const read = async (want) => (await settle(() => tokenColours(page, want), painted(want), 20000, 1000)).value;
    const code = await read({ class: "Person", method: "greeting", keyword: "public" });
    await openFile(page, "MainTest.java");
    const rest = await read({ annotation: "@Test", string: "Ada" });
    await snap(page, "batlehub-tokens");
    emit({ phase: "theme-tokens", pick: { ...code.pick, ...rest.pick }, all: [...new Set([...code.all, ...rest.all])] });
    await setTheme(page, "Dark Modern");
  }

  // 7. The explorer's rows (what is expanded: folder → JDK, modules; plus the Inspections view).
  await clickActivity(page, "Java");
  await sleep(1000);
  const explorer = await page.$$eval(".sidebar .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
  await snap(page, "explorer");
  emit({ phase: "explorer", rows: explorer });

  // 8. The task provider, through the editor's own picker.
  await runCommand(page, "Tasks: Run Task");
  await sleep(2500);
  let taskRows = (await quickPickRows(page)).rows;
  if (!taskRows.some((r) => /maven (compile|package)/.test(r)) && taskRows.some((r) => /batlehub-java/.test(r))) {
    await page.keyboard.type("batlehub-java");
    await sleep(800);
    await page.keyboard.press("Enter");
    await sleep(3000);
    taskRows = (await quickPickRows(page)).rows;
  }
  await snap(page, "tasks");
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.keyboard.press("Escape");
  // Run one to completion: the terminal's DOM renderer (gpuAcceleration off) makes its rows readable.
  await runCommand(page, "Tasks: Run Task");
  await sleep(2500);
  await page.keyboard.type("batlehub-java: maven compile");
  await sleep(1200);
  await page.keyboard.press("Enter");
  await sleep(1500);
  // "Run Task" may ask which problem matcher to use for a task without one; take the first.
  if (await page.$(".quick-input-widget:not([style*='display: none'])")) await page.keyboard.press("Enter");
  const termRead = () => page.$$eval(".terminal .xterm-rows > div, .xterm-rows > div", (els) => els.map((e) => e.innerText.replace(/\u00a0/g, " ").trimEnd()).filter(Boolean)).catch(() => []);
  const built = await settle(termRead, (rows) => rows.some((r) => /BUILD (SUCCESS|FAILURE)/.test(r)), 240000, 3000);
  await snap(page, "task-run");
  const termText = built.value.join("\n");
  emit({ phase: "tasks", rows: taskRows, ran: /BUILD SUCCESS/.test(termText), terminal: built.value.filter((r) => /BUILD|JAVA_HOME|mvn|Total time|ERROR/.test(r)).slice(0, 8) });

  // 8b. RFC 0007 use case 1: Import from IntelliJ → Code style. The plan is
  // shown as a diff before anything is on disk; Write puts the Eclipse
  // profile and the settings in place; Format Document then has to produce
  // exactly what IDEA 2026.1 produced with the same scheme (the committed
  // Greeter.formatted.java).
  const IDEA_STYLE = path.join(WS, ".idea", "codeStyles", "Project.xml");
  const ideaBefore = readIfPresent(IDEA_STYLE);
  const ideaTemplatesBefore = readIfPresent(path.join(WS, ".idea", "fileTemplates", "Class.java"));
  await runCommand(page, "Java: Import from IntelliJ");
  await sleep(1200);
  // The flag is off in a fresh workspace: the command offers to turn it on,
  // and goes on to the import itself once it is on — no second invocation.
  const flagged = await notifications(page);
  const turnedOn = flagged.some((n) => /experimental/.test(n))
    ? await clickNotificationAction(page, /^Turn it on/)
    : null;
  if (turnedOn) await sleep(2500);
  // The scope pick is a multi-select with every kind on by default (§4.2).
  // Accept it as it stands: typing would filter the list without unchecking
  // anything, and `.idea/` here has no runConfigurations, so "everything" and
  // "code style only" read the same — except that the plan then has to show
  // both sections, which is the stronger assertion.
  const scopeRows = await quickPickRows(page);
  await page.keyboard.press("Enter");
  await sleep(2500);
  const planText = norm(
    await page
      .$eval(
        ".monaco-dialog-box .dialog-message-detail, .monaco-dialog-box .dialog-message-text",
        (e) => e.innerText,
      )
      .catch(() => ""),
  );
  await snap(page, "idea-plan");
  // Show diff: one diff editor per target, right-hand side served from memory.
  const shown = await dismissDialogs(page, /^Show diff/);
  await sleep(3000);
  const diffTabs = await page
    .$$eval(".tabs-container .tab", (els) =>
      els.map((e) => e.getAttribute("aria-label") ?? e.innerText.trim()),
    )
    .catch(() => []);
  const onDiskDuringPlan = {
    settings: readIfPresent(path.join(WS, ".vscode", "settings.json")),
    profile: readIfPresent(path.join(WS, ".vscode", "batlehub-java", "formatter.xml")),
  };
  await snap(page, "idea-diff");
  // The plan comes back after the diff; now write.
  await sleep(1500);
  await dismissDialogs(page, /^Write/);
  await sleep(3000);
  const wrote = {
    settings: readIfPresent(path.join(WS, ".vscode", "settings.json")),
    profile: readIfPresent(path.join(WS, ".vscode", "batlehub-java", "formatter.xml")),
    manifest: readIfPresent(path.join(WS, ".batlehub", "java", "written.json")),
    idea: readIfPresent(path.join(WS, ".idea", "codeStyles", "Project.xml")),
    // Use cases 2 and 3: the live templates of the suite's IDEA configuration
    // directory and the project's file templates, both in one snippets file.
    snippets: readIfPresent(path.join(WS, ".vscode", "intellij.code-snippets")),
    ideaTemplates: readIfPresent(path.join(WS, ".idea", "fileTemplates", "Class.java")),
  };
  await snap(page, "idea-written");
  // Format Document with the imported profile, against IDEA's own output.
  // Read the *saved file*, not the editor: `editorText` walks Monaco's
  // virtualised DOM, which is in recycling order rather than line order and
  // drops what is scrolled out — good enough for a regex, useless for a
  // byte-for-byte comparison with a golden file.
  const GREETER = path.join(WS, "core", "src", "main", "java", "com", "acme", "core", "Greeter.java");
  const greeterBefore = readIfPresent(GREETER);
  await openFile(page, "Greeter.java");
  await sleep(1500);
  await runCommand(page, "Format Document");
  await sleep(2000);
  await chord(page, "Control", "s");
  const saved = await settle(
    async () => readIfPresent(GREETER),
    (text) => text !== null && text !== greeterBefore,
    45000,
    1500,
  );
  const formatted = saved.value ?? "";
  await snap(page, "idea-format");
  emit({
    phase: "idea",
    turnedOn,
    scopeRows: scopeRows.rows,
    plan: planText,
    shown,
    diffTabs,
    onDiskDuringPlan,
    wroteProfile: !!wrote.profile,
    wroteSettings: wrote.settings,
    manifest: wrote.manifest,
    ideaUnchanged: wrote.idea === ideaBefore && wrote.ideaTemplates === ideaTemplatesBefore,
    snippets: wrote.snippets,
    greeterBefore,
    formatted,
    formatTimedOut: !!saved.timedOut,
    golden: readIfPresent(path.join(WS, ".idea", "golden", "Greeter.formatted.java")),
  });
  // Use case 2's real proof: the snippet the import wrote is offered by the
  // editor's own completion in a Java file. A snippets file nothing reads is
  // not an imported live template.
  const SNIPPET_PROBE = path.join(WS, "core", "src", "main", "java", "com", "acme", "core", "Probe.java");
  // The caret goes to the end of the file and one line past it: a snippet
  // scoped to `java` is offered anywhere in a Java file, and end-of-file is
  // the one position that needs no cursor arithmetic to reach.
  writeFileSync(SNIPPET_PROBE, "package com.acme.core;\n\nclass Probe {}\n");
  await openFile(page, "Probe.java");
  await sleep(2000);
  // `chord` is the only way to send a combination here: puppeteer's
  // `keyboard.press` takes one key and rejects "Control+Home".
  await chord(page, "Control", "End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("sout");
  await sleep(1500);
  await chord(page, "Control", " ");
  const suggestions = await settle(
    async () =>
      await page
        .$$eval(".suggest-widget .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()))
        .catch(() => []),
    (rows) => rows.some((r) => /sout/.test(r)),
    20000,
    1000,
  );
  await snap(page, "idea-snippet");
  emit({ phase: "idea-snippet", suggestions: suggestions.value ?? [], timedOut: !!suggestions.timedOut });
  try {
    rmSync(SNIPPET_PROBE);
  } catch {
    // The probe is the suite's own file; a failed delete is not a failure.
  }

  // Put the fixture's file back before the inspection step reads it. The
  // buffer is clean (the format was saved), so the editor picks the change
  // up rather than holding a stale one.
  if (greeterBefore !== null) writeFileSync(GREETER, greeterBefore);
  await sleep(1500);

  // 9. Inspections on Greeter.java: the Problems panel, then Fix all, then the buffer.
  await openFile(page, "Greeter.java");
  const probs = await settle(() => problems(page), (rows) => rows.some((r) => /batlehub/.test(r)), 60000, 3000);
  await snap(page, "inspections");
  await openFile(page, "Greeter.java");
  await runCommand(page, "Java: Fix all inspections in file");
  await sleep(3000);
  await openFile(page, "Greeter.java");
  await snap(page, "fixed");
  // Saved and read from disk, for the same reason as the format step: the
  // golden is byte-for-byte, and `editorText` is not.
  await chord(page, "Control", "s");
  const fixed = await settle(
    async () => readIfPresent(GREETER),
    (text) => text !== null && text !== greeterBefore,
    30000,
    1000,
  );
  emit({ phase: "inspections", problems: probs.value, fixed: fixed.value ?? "", golden: readIfPresent(path.join(WS, ".idea", "golden", "Greeter.fixed.java")) });
  if (greeterBefore !== null) writeFileSync(GREETER, greeterBefore);
  await sleep(1500);
  // The file was put back behind the editor: revert the buffer to it, or a
  // later save meets "the content of the file is newer" and the buffer
  // stays dirty for every step after this one.
  await openFile(page, "Greeter.java");
  await runCommand(page, "File: Revert File");
  await sleep(800);
  const greeterDirty = await page.$$eval(".tabs-container .tab.dirty", (els) => els.some((e) => /Greeter\.java/.test(e.getAttribute("aria-label") || e.innerText))).catch(() => false);
  emit({ phase: "inspections-cleanup", greeterDirty });

  // 9b. RFC 0013 phase 1: cspell's findings in Java as one rule of the
  // Inspections view, and the core's fix that writes the team's cspell.json.
  const CSPELL_JSON = path.join(WS, "cspell.json");
  rmSync(CSPELL_JSON, { force: true });
  await openFile(page, "Speller.java");
  const spellProblems = await settle(() => problems(page), (rows) => rows.filter((r) => /cSpell/.test(r)).length >= 3, 120000, 3000);
  const inspectionsView = async () => {
    await runCommand(page, "Java: Focus on Inspections View");
    await sleep(1200);
    return page.$$eval('.pane:has(.pane-header[aria-label*="Inspections"]) .monaco-list-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
  };
  const spellView = await settle(inspectionsView, (rows) => rows.some((r) => /spelling\/unknownWord/.test(r)), 30000, 2000);
  await snap(page, "spelling");
  const coreLines = (await outputLines(page)).join(" ");
  emit({
    phase: "spelling",
    problems: (spellProblems.value ?? []).filter((r) => /cSpell/.test(r)).slice(0, 6),
    view: (spellView.value ?? []).slice(0, 8),
    detected: /spelling: cspell [\d.]+ detected, bridged/.test(coreLines),
  });
  // Case 4: the lightbulb on Mesage — the core's fix beside cspell's own.
  await openFile(page, "Speller.java");
  await chord(page, "Control", "g");
  await sleep(400);
  await page.keyboard.type("7:31");
  await page.keyboard.press("Enter");
  await sleep(600);
  await runCommand(page, "Quick Fix...");
  await sleep(2500);
  const fixes = await page.$$eval(".action-widget .monaco-list-row, .context-view .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
  const ours = await page.$$(".action-widget .monaco-list-row, .context-view .monaco-list-row");
  let picked = false;
  for (const row of ours)
    if (/Add "Mesage" to project dictionary/.test(await row.evaluate((e) => e.innerText))) {
      await row.click();
      picked = true;
      break;
    }
  if (!picked) await page.keyboard.press("Escape");
  const dict = await settle(() => readIfPresent(CSPELL_JSON), (t) => /Mesage/.test(t ?? ""), 15000, 1000);
  const spellAfter = await settle(() => problems(page), (rows) => !rows.some((r) => /Mesage/.test(r) && /cSpell/.test(r)), 30000, 2000);
  emit({
    phase: "spellDict",
    fixes: fixes.slice(0, 10),
    picked,
    cspellJson: dict.value ?? null,
    settings: readIfPresent(path.join(WS, ".vscode", "settings.json")),
    mesageGone: !spellAfter.timedOut,
    problems: (spellAfter.value ?? []).filter((r) => /cSpell/.test(r)).slice(0, 6),
  });
  rmSync(CSPELL_JSON, { force: true });

  // 10. Generate on Person.java: the bundle's delegate writes the accessors; without it Red Hat's picker opens.
  await openFile(page, "Person.java");
  await chord(page, "Control", "End");
  await sleep(300);
  await runCommand(page, "Java: Getters and setters");
  await sleep(3000);
  const picker = await quickPickRows(page);
  if (picker.rows.length) await page.keyboard.press("Escape");
  const personAfter = await editorText(page);
  await snap(page, "generate");
  emit({ phase: "generate", generated: /getName\(\)/.test(personAfter) && /setAge\(/.test(personAfter), pickerRows: picker.rows.slice(0, 4) });
  await runCommand(page, "File: Revert File");
  await sleep(500);

  // 10b. RFC 0002 phase 0: the live editor as an MCP server, driven the way
  // an agent outside the editor drives it — `node mcp-relay.js <socket>`
  // over stdio, the paths read off the core's log. Use case 7: an unsaved
  // caller is renamed too, nothing reaches disk, one undo; use case 8: the
  // workspace's overrides change the Problems panel, not what the agent is told.
  {
    const MAIN = path.join(WS, "app", "src", "main", "java", "com", "acme", "app", "Main.java");
    const SETTINGS = path.join(WS, ".vscode", "settings.json");
    const listening = channelLog("BatleHub Java")
      .map((l) => /mcp: listening on (\S+) \(relay (\S+)\)/.exec(l))
      .findLast(Boolean);
    const jdtls = () => Number(execSync("pgrep -fc '[o]rg.eclipse.jdt.ls.core.id1' || true").toString().trim() || 0);
    const jdtlsBefore = jdtls();
    const mcp = { listening: !!listening };
    if (listening) {
      const { spawn } = await import("node:child_process");
      const relay = spawn("node", [listening[2], listening[1]], { stdio: ["pipe", "pipe", "inherit"] });
      const waiting = new Map();
      let buf = "";
      relay.stdout.setEncoding("utf8").on("data", (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const m = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          waiting.get(m.id)?.(m);
        }
      });
      let id = 0;
      const rpc = (method, params) =>
        new Promise((resolve, reject) => {
          const n = ++id;
          const t = setTimeout(() => reject(new Error(`${method}: no answer in 120 s`)), 120000);
          waiting.set(n, (m) => (clearTimeout(t), resolve(m)));
          relay.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
        });
      const tool = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
      const settingsBefore = readIfPresent(SETTINGS);
      try {
        mcp.init = (await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "heavy", version: "0" } })).result?.serverInfo;
        relay.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
        mcp.tools = (await rpc("tools/list", {})).result?.tools?.map((t) => t.name);
        mcp.status = (await tool("java_status", {}))?.structuredContent;

        // The web build saves after a delay by default: off for this step, or
        // the editor itself would save what the tool left unsaved.
        const s = { ...JSON.parse(settingsBefore ?? "{}"), "files.autoSave": "off" };
        // From a known Greeter.java: the inspections step saved its Fix all and
        // wrote the fixture back behind the editor, and the server can keep
        // the fixed copy (RFC 0002 §11, phase 0). Auto save off, every editor
        // closed, the fixture's own file on disk, then the cases.
        writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
        await sleep(1000);
        await runCommand(page, "View: Close All Editors");
        await dismissDialogs(page, /^(Don't Save|Do not save)/);
        writeFileSync(GREETER, readFileSync(path.join(here, "fixtures", "maven-multi", "core", "src", "main", "java", "com", "acme", "core", "Greeter.java"), "utf8"));
        await sleep(3000);
        // Use case 8: a committed workspace settings.json turns one rule off and another down.
        writeFileSync(SETTINGS, JSON.stringify({ ...s, "batlehub.java.inspections.severityOverrides": { "performance/stringConcatInLoop": "off", "style/redundantThis": "hint" } }, null, 2));
        await openFile(page, "Greeter.java");
        const panel = await settle(() => problems(page), (rows) => rows.some((r) => /redundantThis/.test(r)) && !rows.some((r) => /stringConcatInLoop/.test(r)), 30000, 2000);
        const inspected = await tool("java_inspect", { paths: ["core/src/main/java/com/acme/core/Greeter.java"] });
        mcp.inspect = inspected?.structuredContent?.findings?.map((f) => ({ code: f.code, severity: f.severity, line: f.range.start.line + 1, differs: !!f.differsFromEditor }));
        mcp.panel = (panel.value ?? []).filter((r) => /batlehub/.test(r));
        writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
        await sleep(1500);

        // Use case 7: an unsaved second caller of all(), then the rename.
        // The inspections step rewrote Greeter.java behind the editor: close
        // everything so the server's copy is the disk's again before typing.
        await runCommand(page, "View: Close All Editors");
        await sleep(2000);
        const greeterDisk = readIfPresent(GREETER);
        const mainDisk = readIfPresent(MAIN);
        const callerLine = greeterDisk.split("\n").findIndex((l) => /people\.size\(\) == 0/.test(l)) + 1;
        mcp.callerLine = callerLine;
        await openFile(page, "Greeter.java");
        await sleep(3000);
        await chord(page, "Control", "g");
        await sleep(300);
        await page.keyboard.type(`${callerLine}:9`);
        await page.keyboard.press("Enter");
        await sleep(300);
        await page.keyboard.type("all();");
        await page.keyboard.press("Enter");
        await sleep(1500);
        const typeRename = await tool("java_rename", { symbol: "com.acme.core.Greeter", newName: "Hello", dryRun: true });
        mcp.typeRename = { isError: !!typeRename?.isError, text: typeRename?.content?.[0]?.text };
        const dry = await tool("java_rename", { symbol: "com.acme.core.Greeter#all", newName: "everyone", dryRun: true });
        mcp.dry = { applied: dry?.structuredContent?.applied, files: Object.keys(dry?.structuredContent?.edit?.changes ?? {}) };
        const onDisk = () => readIfPresent(GREETER) === greeterDisk && readIfPresent(MAIN) === mainDisk;
        mcp.diskAfterDry = onDisk();
        const t0 = Date.now();
        const renamed = await tool("java_rename", { symbol: "com.acme.core.Greeter#all", newName: "everyone" });
        mcp.renameMs = Date.now() - t0;
        mcp.diskAfterApply = onDisk();
        await sleep(3000);
        mcp.diskAfter3s = onDisk();
        const r = renamed?.structuredContent;
        mcp.rename = { isError: !!renamed?.isError, text: renamed?.isError ? renamed.content?.[0]?.text : undefined, applied: r?.applied, files: Object.keys(r?.edit?.changes ?? {}), greeterLines: (r?.edit?.changes?.["core/src/main/java/com/acme/core/Greeter.java"] ?? []).map((e) => e.range.start.line + 1) };
        await sleep(1000);
        await openFile(page, "Main.java");
        mcp.mainBuffer = /g\.everyone\(\)/.test(await editorText(page));
        await openFile(page, "Greeter.java");
        const greeterBuffer = await editorText(page);
        mcp.greeterBuffer = (greeterBuffer.match(/everyone\(\)/g) ?? []).length;
        mcp.disk = { greeter: readIfPresent(GREETER) === greeterDisk, main: readIfPresent(MAIN) === mainDisk, greeterNow: readIfPresent(GREETER) === greeterDisk ? undefined : readIfPresent(GREETER) };
        await snap(page, "mcp-rename");
        // One undo takes the whole call back, in every file.
        await chord(page, "Control", "z");
        await sleep(1500);
        await dismissDialogs(page, /^(Undo|Yes|OK)/);
        await sleep(1000);
        await openFile(page, "Main.java");
        mcp.mainAfterUndo = /g\.all\(\)/.test(await editorText(page));
        await openFile(page, "Greeter.java");
        const afterUndo = await editorText(page);
        mcp.greeterAfterUndo = { everyone: /everyone/.test(afterUndo), unsavedCallerKept: /all\(\);/.test(afterUndo) };
        mcp.jdtls = { before: jdtlsBefore, after: jdtls() };
      } catch (e) {
        mcp.error = e.message;
      }
      relay.stdin.end();
      relay.kill();
      // Back to the fixture: every buffer the rename or the typing touched.
      for (const f of ["Greeter.java", "Main.java", "MainTest.java"]) {
        await openFile(page, f);
        await runCommand(page, "File: Revert File");
        await sleep(400);
      }
      if (settingsBefore === null) rmSync(SETTINGS, { force: true });
      else writeFileSync(SETTINGS, settingsBefore);
    }
    emit({ phase: "mcp", ...mcp });
  }

  // 10c. RFC 0005 phase 1: the profile's schema, contributed by java-core and
  // generated from the bundle, read by the editor's own JSON service — an
  // `off` with no `why` and a misspelt rule are flagged before anything of
  // ours reads the file.
  {
    const PROFILE = path.join(WS, ".batlehub", "java", "inspections.json");
    mkdirSync(path.dirname(PROFILE), { recursive: true });
    writeFileSync(
      PROFILE,
      JSON.stringify({ version: 1, rules: { "correctness/emptyCatch": { severity: "off" }, "style/ifReturnBool": { severity: "error" }, "style/redundantThis": { severity: "off", why: "house style" } } }, null, 2),
    );
    await openFile(page, "inspections.json");
    const rows = await settle(() => problems(page), (r) => r.some((x) => /why/.test(x)) && r.some((x) => /ifReturnBool/.test(x)), 30000, 2000);
    await snap(page, "profile-schema");
    emit({ phase: "profileSchema", problems: (rows.value ?? []).filter((r) => /inspections\.json|why|ifReturnBool|redundantThis/.test(r)) });
    rmSync(PROFILE, { force: true });
    // RFC 0006 phase 1: project.json's schema, the same way.
    const PROJECT = path.join(WS, ".batlehub", "java", "project.json");
    writeFileSync(PROJECT, JSON.stringify({ version: 1, maven: { activeProfiles: "dev", configuration: "corp" }, registry: { enabled: true } }, null, 2));
    await openFile(page, "project.json");
    const prow = await settle(() => problems(page), (r) => r.some((x) => /^project\.json/.test(x)), 30000, 2000);
    await snap(page, "project-schema");
    emit({ phase: "projectSchema", problems: (prow.value ?? []).filter((r) => /project\.json|Incorrect type|Value is not accepted|not allowed/.test(r)) });
    rmSync(PROJECT, { force: true });
    await runCommand(page, "View: Close All Editors");
    await sleep(500);
  }

  // 11. The Groovy satellite on Hello.groovy.
  await openFile(page, "Hello.groovy");
  await sleep(4000);
  const coreLog = (await outputLines(page)).join(" ");
  const groovyLog = (await outputLines(page, "Java: Show the Groovy log")).join(" ");
  await openFile(page, "Hello.groovy");
  // Put the caret on `greet` by clicking its rendered token, then ask for the hover.
  const caretPlaced = await page.evaluate(() => {
    const spans = [...document.querySelectorAll(".editor-instance .monaco-editor .view-line span")];
    const el = spans.find((e) => e.textContent === "greet" || /\bgreet\b/.test(e.textContent ?? ""));
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(20, r.width / 2);
    const y = r.top + r.height / 2;
    for (const type of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    return true;
  });
  await sleep(400);
  if (caretPlaced) await runCommand(page, "Show or Focus Hover");
  await sleep(2500);
  const hover = norm(await page.$eval(".monaco-hover .hover-contents", (e) => e.innerText).catch(() => ""));
  await snap(page, "groovy");
  const mode = await statusItems(page, /status\.editor\.mode|editor\.mode/);
  const hiddenBefore = (await statusItems(page, /groovy\.server/)).length === 0;
  let shownAfter = false;
  if (args["after-groovy"]) {
    hook(args["after-groovy"]);
    shownAfter = !(await settle(() => statusItems(page, /groovy\.server/), (s) => s.length > 0, 30000)).timedOut;
  }
  // RFC 0003 case 5: the Groovy server is the core's managed process, and the
  // JDK tab's sum (the same consumers as this command) lists its cap.
  const resourcesLog = (await outputLines(page, "Java: Show the container's resources")).join(" ");
  emit({
    phase: "procGroovy",
    started: /started groovy-ls \(pid \d+, 768 MiB declared\)/.test(resourcesLog),
    inSum: /groovy-ls \(declared\): 768 MiB/.test(resourcesLog),
    tail: resourcesLog.slice(-600),
  });
  emit({ phase: "groovy", registered: /language groovy registered/.test(coreLog), serverLog: groovyLog.slice(0, 500), started: /running|started|initialize/i.test(groovyLog), hover, languageMode: mode.map((m) => m.text), statusItemHidden: hiddenBefore, statusItemShownAfterToggle: shownAfter });

  // 11b. RFC 0003 phase 3, cases 1–3: a `batlehub-run` is a debug session.
  // The long-lived process is the resolved JDK's own `jwebserver` (nothing is
  // downloaded); the `launch` step is a node launch, since this half installs
  // no Java debugger and js-debug is built in (decision 14 lists any type).
  const RUN_PORT = 18080;
  const LAUNCH_JSON = path.join(WS, ".vscode", "launch.json");
  const IT = path.join(WS, "it-check.js");
  const portFree = () =>
    new Promise((r) => {
      const s = net.connect({ host: "127.0.0.1", port: RUN_PORT });
      s.once("connect", () => (s.destroy(), r(false)));
      s.once("error", () => r(true));
    });
  const replLines = async () => {
    await runCommand(page, "Debug Console: Focus on Debug Console View");
    await sleep(600);
    return page.$$eval(".repl .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
  };
  const startRun = async (name) => {
    await runCommand(page, "Debug: Select and Start Debugging");
    await sleep(800);
    await page.keyboard.type(name);
    await sleep(800);
    await page.keyboard.press("Enter");
  };
  const runStatus = async () => (await javaStatus(page)).map((i) => i.text).join(" ");

  // Case 1, from the run editor: template → name → command → memory → probe.
  await runCommand(page, "Java: New run configuration…");
  await sleep(800);
  await page.keyboard.type("Orchestrated run");
  await sleep(500);
  await page.keyboard.press("Enter");
  for (const answer of ["Serve", `jwebserver -p ${RUN_PORT}`, "128", String(RUN_PORT)]) {
    await sleep(700);
    await chord(page, "Control", "a");
    await page.keyboard.type(answer);
    await page.keyboard.press("Enter");
  }
  await sleep(1000);
  const written = readIfPresent(LAUNCH_JSON) ?? "";
  await startRun("Serve");
  const served = await settle(
    async () => ({ free: await portFree(), status: await runStatus() }),
    (v) => !v.free && /run ● 1 process/.test(v.status),
    60000,
    1000,
  );
  await sleep(1000);
  const termRows = await page.$$eval(".terminal .xterm-rows > div, .xterm-rows > div", (els) => els.map((e) => e.innerText.replace(/ /g, " ").trimEnd()).filter(Boolean)).catch(() => []);
  const terminals = await page.$$eval(".terminal-tabs-entry, .single-terminal-tab, .tabs-list .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim())).catch(() => []);
  let answered = false;
  try {
    answered = (await fetch(`http://127.0.0.1:${RUN_PORT}/`)).ok;
  } catch {
    answered = false;
  }
  await snap(page, "run-order");
  const orderLines = await replLines();
  // Case 4's half the browser can drive: Stop, and the reverse stop's line.
  await runCommand(page, "Debug: Stop");
  const stopped = await settle(portFree, (free) => free, 30000, 500);
  await sleep(1000);
  const stopLines = await replLines();
  emit({
    phase: "runOrder",
    written: /"batlehub-run"/.test(written) && /"jwebserver"/.test(written) && /"memoryMiB": 128/.test(written),
    status: served.value?.status ?? "",
    up: !served.timedOut,
    answered,
    terminal: termRows.filter((r) => /Serving|jwebserver|port/.test(r)).slice(0, 4),
    terminals,
    console: orderLines,
    stopConsole: stopLines,
    portFreeAfter: !stopped.timedOut,
    statusAfter: await runStatus(),
  });

  // Case 2, the acceptance run: a task, the server ready by HTTP, a launch that GETs it.
  // js-debug sends no `exited` event, so the run cannot read the IT's code:
  // the IT leaves what it got in a file the driver reads.
  const IT_RESULT = path.join(WS, "it-result.txt");
  rmSync(IT_RESULT, { force: true });
  writeFileSync(IT, `const fs = require("fs"); fetch("http://127.0.0.1:${RUN_PORT}/").then((r) => { fs.writeFileSync(${JSON.stringify(IT_RESULT)}, String(r.status)); process.exit(r.status === 200 ? 0 : 1); }, (e) => { fs.writeFileSync(${JSON.stringify(IT_RESULT)}, e.message); process.exit(2); });\n`);
  const launchText = readIfPresent(LAUNCH_JSON) ?? "";
  const entries = JSON.parse(launchText.replace(/^\s*\/\/.*$/gm, ""));
  entries.configurations.push(
    { type: "node", request: "launch", name: "Run IT", program: "${workspaceFolder}/it-check.js", console: "internalConsole" },
    {
      type: "batlehub-run",
      request: "launch",
      name: "Acceptance",
      steps: [
        { task: "batlehub-java: maven compile" },
        { process: ["jwebserver", "-p", String(RUN_PORT)], memoryMiB: 128, ready: { http: `http://127.0.0.1:${RUN_PORT}/` } },
        { launch: "Run IT" },
      ],
    },
    { type: "batlehub-run", request: "launch", name: "Timeout", steps: [{ process: ["jwebserver", "-p", String(RUN_PORT)], memoryMiB: 128, ready: { http: `http://127.0.0.1:${RUN_PORT}/nope`, timeoutMs: 5000 } }] },
  );
  writeFileSync(LAUNCH_JSON, JSON.stringify(entries, null, 2));
  await sleep(1500);
  await startRun("Acceptance");
  const accept = await settle(replLines, (l) => l.some((x) => /stopping 1 \(/.test(x)) || l.some((x) => /^step \d.*(failed|not ready|no task|did not start)/.test(x)), 240000, 3000);
  emit({ phase: "runAccept", console: accept.value ?? [], timedOut: !!accept.timedOut, portFreeAfter: await portFree(), itGot: readIfPresent(IT_RESULT) });

  // Case 3, readiness never comes: the run fails, the process is still stopped.
  await startRun("Timeout");
  const timeout = await settle(replLines, (l) => l.some((x) => /stopping 1 \(/.test(x)), 60000, 1000);
  await sleep(1000);
  emit({ phase: "runTimeout", console: timeout.value ?? [], timedOut: !!timeout.timedOut, portFreeAfter: await portFree(), statusAfter: await runStatus() });
  for (const f of [IT, IT_RESULT, LAUNCH_JSON]) rmSync(f, { force: true });

  // 12. Spike (a): the classpath before, the m2e preference, the classpath after.
  await openFile(page, "Greeter.java");
  const dump = async () => {
    await runCommand(page, "Java: Dump the classpath (spike)");
    await sleep(3000);
    const l = await outputLines(page);
    const idx = l.reduce((last, x, i) => (/classpath of /.test(x) ? i : last), -1);
    return idx >= 0 ? l.slice(idx).join("\n") : l.slice(-5).join("\n");
  };
  const before = await dump();
  let ran = null;
  if (args["after-baseline"]) {
    hook(args["after-baseline"]);
    ran = args["after-baseline"].slice(0, 80);
  }
  await runCommand(page, "Java: Reload the Java projects");
  const after = await settle(dump, (cp) => /commons-lang3/.test(cp), 120000, 5000);
  await snap(page, "classpath");
  emit({ phase: "classpath", before: /commons-lang3/.test(before), afterBaseline: ran, after: /commons-lang3/.test(after.value), entriesBefore: (before.match(/\.jar/g) ?? []).length, entriesAfter: (after.value.match(/\.jar/g) ?? []).length, tail: after.value.slice(-300) });

  // 12b. RFC 0012 phase 1, use cases 1–3: the default-on write of
  // `java.completion.chain.enabled`, a chain on the completion shortcut, and
  // what it costs. The Undo comes last, because it stops the key being
  // written again in this workspace.
  const readJson = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  const MAIN = path.join(WS, "app", "src", "main", "java", "com", "acme", "app", "Main.java");
  const chainSettings = () => readJson(path.join(WS, ".vscode", "settings.json"));
  const chainManifest = () => readJson(path.join(WS, ".batlehub", "java", "written.json"));
  const chain = {
    settingWritten: chainSettings()?.["java.completion.chain.enabled"],
    manifestHas: (chainManifest()?.entries ?? []).some(
      (e) => e.key === "java.completion.chain.enabled",
    ),
    // The write happens at the first detection, which is *before* the
    // newcomer reload of step 3 — and an output channel starts empty after a
    // reload. The line is in the channel this run captured back then.
    log: [...lines, ...lines2, ...(await outputLines(page))].some((l) =>
      /wrote java\.completion\.chain\.enabled/.test(l),
    ),
    requestTrace: [...lines, ...lines2].find((l) =>
      /redhat\.java request trace:/.test(l),
    ),
  };
  // The panel's once-only line and its two actions.
  await clickActivity(page, "Java");
  await sleep(1500);
  const chainFrame = await panelFrame(page);
  chain.notice = chainFrame
    ? await chainFrame
        .$eval(".notice", (e) => e.innerText.replace(/\s+/g, " ").trim())
        .catch(() => "")
    : "";
  await snap(page, "chain-notice");

  // Use case 2: a chain to the expected type on the completion shortcut. The
  // line is typed rather than committed, so the fixture keeps compiling.
  let lastCompletionMs = -1;
  const completionAt = async () => {
    const t = Date.now();
    await chord(page, "Control", " ");
    const rows = await settle(
      () =>
        page
          .$$eval(".suggest-widget .monaco-list-row", (els) =>
            els.map((e) => e.innerText.replace(/\s+/g, " ").trim()),
          )
          .catch(() => []),
      (r) => r.length > 0,
      20000,
      50,
    );
    lastCompletionMs = rows.timedOut ? -1 : Date.now() - t;
    return rows.value ?? [];
  };
  const openProbe = async () => {
    await openFile(page, "Main.java");
    await sleep(800);
    // The line that uses `g`, found by its text — counting ArrowUps from the
    // end of the file makes the trailing newline decide whether the caret
    // lands inside main() or in the class body, and the completion list of
    // the two looks similar enough to pass unnoticed.
    const line = readFileSync(MAIN, "utf8")
      .split("\n")
      .findIndex((l) => l.includes("System.out.print"));
    await runCommand(page, "Go to Line/Column...");
    await page.keyboard.type(String(line + 1));
    await sleep(400);
    await page.keyboard.press("Enter");
    await sleep(500);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    // The shape the server actually answers, measured: a chain to a *project*
    // reference type. It refuses primitives and JDK types outright, so the
    // `String s = ` of the RFC's first draft could never have produced one.
    await page.keyboard.type("Config config = new Config();");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Server srv = ");
    await sleep(1500);
  };
  await openProbe();
  const chainRows = await completionAt();
  chain.items = chainRows.slice(0, 12);
  const CHAIN_ROW = /config\s*\.\s*getServer\s*\(\s*\)/;
  chain.hasChain = chainRows.some((r) => CHAIN_ROW.test(r));
  await snap(page, "chain-suggest");
  await page.keyboard.press("Escape");

  // Use case 3: ten round trips, median, from redhat.java's own request trace
  // through the core's debug log (`completion round trip N ms`).
  // Ten invocations, dismissing in between; the wall clock from the shortcut
  // to the list being on screen. It is the client's number rather than the
  // server's — it includes the editor's own rendering — but it is measured
  // the same way with chains on and off, so the *delta* is the feature's
  // cost, and it is what the user actually waits for.
  const roundTrips = async () => {
    const out = [];
    for (let i = 0; i < 10; i++) {
      await completionAt();
      if (lastCompletionMs >= 0) out.push(lastCompletionMs);
      await page.keyboard.press("Escape");
      await sleep(250);
    }
    return out;
  };
  const median = (xs) =>
    xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : -1;
  chain.samples = await roundTrips();
  perf.chainMs = median(chain.samples);

  // The rank: where the chain item lands once a prefix filters the list. How
  // `sortText` and the editor's fuzzy score interact is *measured* here,
  // before phase 2 designs a ranking on top of it.
  await page.keyboard.type("con");
  await sleep(800);
  const ranked = await completionAt();
  chain.rankedItems = ranked.slice(0, 8);
  chain.rankedCount = ranked.length;
  perf.chainRank = ranked.findIndex((r) => CHAIN_ROW.test(r));
  await snap(page, "chain-rank");
  await page.keyboard.press("Escape");

  // The same position with the setting off: the cost is a delta in the log,
  // not a feeling — and the chain item has to be gone.
  await runCommand(page, "File: Revert File");
  await sleep(500);
  hook(
    `python3 - '${path.join(WS, ".vscode", "settings.json")}' <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["java.completion.chain.enabled"] = False
json.dump(d, open(p, "w"), indent=2)
PY`,
  );
  await sleep(4000);
  await openProbe();
  const offRows = await completionAt();
  chain.offHasChain = offRows.some((r) => CHAIN_ROW.test(r));
  await page.keyboard.press("Escape");
  perf.chainOffMs = median(await roundTrips());
  await runCommand(page, "File: Revert File");
  await sleep(500);

  // Use case 1's last half: Undo removes the setting and its manifest entry.
  hook(
    `python3 - '${path.join(WS, ".vscode", "settings.json")}' <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["java.completion.chain.enabled"] = True
json.dump(d, open(p, "w"), indent=2)
PY`,
  );
  await sleep(2000);
  await clickActivity(page, "Java");
  await sleep(1500);
  const undoFrame = await panelFrame(page);
  const undoBtn = undoFrame
    ? await undoFrame.$('.notice button[data-msg="undoChain"]')
    : null;
  if (undoBtn) await undoBtn.click();
  await sleep(3000);
  chain.afterUndo = {
    setting: chainSettings()?.["java.completion.chain.enabled"] ?? null,
    manifestHas: (chainManifest()?.entries ?? []).some(
      (e) => e.key === "java.completion.chain.enabled",
    ),
    // Every other write the core made has to still be there.
    manifestOther: (chainManifest()?.entries ?? []).length,
    clicked: !!undoBtn,
  };
  await snap(page, "chain-undone");
  emit({ phase: "chain", ...chain, chainMs: perf.chainMs, chainOffMs: perf.chainOffMs, chainRank: perf.chainRank });

  // 12c. RFC 0012 phase 2, use case 4: in "auto" the bundle's delegate
  // answers while typing — no shortcut — and answers the `int` the server's
  // computer refuses. The phase 1 steps above ran in "shortcut" (the
  // machine settings of view.sh); the workspace switches to "auto" here,
  // after the Undo, so the server's key is absent and the delegate is the
  // one source. Each round types a new variable name, so the bundle's cache
  // (keyed by the file minus the typed prefix) is cold every time.
  const setChainMode = (mode) =>
    hook(
      `python3 - '${path.join(WS, ".vscode", "settings.json")}' '${mode}' <<'PY'
import json, sys
p, mode = sys.argv[1], sys.argv[2]
d = json.load(open(p))
if mode == "unset": d.pop("batlehub.java.completion.chain", None)
else: d["batlehub.java.completion.chain"] = mode
json.dump(d, open(p, "w"), indent=2)
PY`,
    );
  setChainMode("auto");
  await sleep(3000);
  const DELEGATE_ROW = /config\s*\.\s*getServer\s*\(\s*\)\s*\.\s*getPort\s*\(\s*\)/;
  const delegate = { rounds: [] };
  await openFile(page, "Main.java");
  await sleep(800);
  {
    const line = readFileSync(MAIN, "utf8")
      .split("\n")
      .findIndex((l) => l.includes("System.out.print"));
    await runCommand(page, "Go to Line/Column...");
    await page.keyboard.type(String(line + 1));
    await sleep(400);
    await page.keyboard.press("Enter");
    await sleep(500);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Config config = new Config();");
    await page.keyboard.press("Enter");
    await sleep(1500);
  }
  for (let i = 0; i < 10; i++) {
    await page.keyboard.type(`int p${i} = g`);
    const rows = await settle(
      () =>
        page
          .$$eval(".suggest-widget .monaco-list-row", (els) =>
            els.map((e) => e.innerText.replace(/\s+/g, " ").trim()),
          )
          .catch(() => []),
      (r) => r.some((x) => DELEGATE_ROW.test(x)),
      10000,
      50,
    );
    delegate.rounds.push({ found: !rows.timedOut, ms: rows.ms });
    if (i === 0) {
      delegate.items = (rows.value ?? []).slice(0, 8);
      await snap(page, "chain-delegate");
    }
    await page.keyboard.press("Escape");
    await page.keyboard.press("End");
    await chord(page, "Shift", "Home");
    await page.keyboard.press("Backspace");
    await sleep(300);
  }
  delegate.found = delegate.rounds.every((r) => r.found);
  // The provider's own round trip, from the core's JDT channel: the bundle's
  // walk plus the command's trip through redhat.java, without the editor's
  // rendering — what the 150 ms budget is about.
  const jdtLines = channelLog("BatleHub Java JDT");
  const trips = jdtLines
    .map((l) => /chain delegate (\d+) ms \(bundle [^)]*\): ([1-9]\d*) chain/.exec(l))
    .filter((m) => m && !/cached/.test(m.input))
    .map((m) => Number(m[1]));
  delegate.trips = trips.slice(-10);
  delegate.truncated = jdtLines.some((l) => /chain delegate .*truncated/.test(l));
  perf.chainDelegateMs = median(delegate.trips);
  await runCommand(page, "File: Revert File");
  await sleep(500);
  setChainMode("unset");
  await sleep(1500);
  emit({ phase: "chainDelegate", ...delegate, chainDelegateMs: perf.chainDelegateMs });

  // 13. Clean removal: the modal lists what it restores; settings.json after.
  await runCommand(page, "Java: Remove BatleHub settings");
  await sleep(1500);
  const dialog = norm(await page.$eval(".monaco-dialog-box .dialog-message-text, .monaco-dialog-box .dialog-message-detail", (e) => e.innerText).catch(() => ""));
  await snap(page, "remove-dialog");
  const clicked = await dismissDialogs(page, /^Restore/);
  await sleep(2500);
  let settings = null;
  try {
    settings = readFileSync(path.join(WS, ".vscode", "settings.json"), "utf8");
  } catch {
    settings = null;
  }
  emit({ phase: "remove", dialog, clicked, settings, notifications: await notifications(page) });

  emit({ phase: "perf", ...perf });
  emit({ phase: "console", errors: consoleErrors.length, sample: consoleErrors.slice(0, 3) });
} catch (e) {
  if (!(e instanceof StopSuite)) throw e;
} finally {
  await page.close().catch(() => {});
  await ctx.close().catch(() => {});
  browser.disconnect();
}

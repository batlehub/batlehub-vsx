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
import { readFileSync, writeFileSync } from "node:fs";
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
  await sleep(1200);
  const rows = await page.$$eval(".quick-input-widget .monaco-list-row", (els) => els.map((e) => (e.querySelector(".label-name") ?? e).textContent.replace(/\s+/g, " ").trim()));
  if (enter) {
    const i = rows.findIndex((r) => r === title || r.startsWith(`${title} `) || r.startsWith(`${title}…`) || r === `${title}…`);
    if (i > 0) {
      const handles = await page.$$(".quick-input-widget .monaco-list-row");
      await handles[i]?.click();
    } else await page.keyboard.press("Enter");
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
  await page.keyboard.type(name);
  await sleep(1200);
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

async function setTheme(page, name) {
  await runCommand(page, "Preferences: Color Theme", false);
  await sleep(600);
  await page.keyboard.type(name);
  await sleep(800);
  await page.keyboard.press("Enter");
  await sleep(1500);
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
    ideaUnchanged: wrote.idea === ideaBefore,
    greeterBefore,
    formatted,
    formatTimedOut: !!saved.timedOut,
    golden: readIfPresent(path.join(WS, ".idea", "golden", "Greeter.formatted.java")),
  });
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
  const greeterAfter = await editorText(page);
  await snap(page, "fixed");
  emit({ phase: "inspections", problems: probs.value, fixedIsEmpty: /isEmpty\(\)/.test(greeterAfter), fixedNoThis: !/this\.people/.test(greeterAfter), fixedNoUnused: !/int unused/.test(greeterAfter) });
  await runCommand(page, "File: Revert File");
  await sleep(500);

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
  emit({ phase: "groovy", registered: /language groovy registered/.test(coreLog), serverLog: groovyLog.slice(0, 500), started: /running|started|initialize/i.test(groovyLog), hover, languageMode: mode.map((m) => m.text), statusItemHidden: hiddenBefore, statusItemShownAfterToggle: shownAfter });

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

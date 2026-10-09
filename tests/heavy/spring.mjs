#!/usr/bin/env node
// The browser half of the `spring` heavy half (RFC 0010 §6.4, §10): a real
// VS Code web workbench with java-core, java-spring and — unless
// `--degraded` — vmware.vscode-spring-boot, the spring-boot fixture open.
// One JSON line per measurement; view.sh asserts.
//
//   node spring.mjs --url <workbench> --shots <dir> --cdp <http://host:port>
//        --workspace <dir> [--degraded 1]
//
//   detect      the "BatleHub Java: Spring" channel: detection, the bridge write; the notifications
//   hover       case 1: Spring Tools' documentation on server.port in application.yml
//   profiles    case 2: `dev` ticked in the Spring tab, the setting it wrote, the tab after
//   template    case 2: Java: New run configuration → Spring Boot application, launch.json after
//   run         case 2: the entry started — /actuator/health on the dev port
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
const snap = (page, name) => page.screenshot({ path: path.join(SHOTS, `${String(++shot).padStart(2, "0")}-spring${DEGRADED ? "-degraded" : ""}-${name}.png`) }).catch(() => {});
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


const DEGRADED = !!args.degraded;
const DEV_PORT = 8081;
const YML = path.join(WS, "src", "main", "resources", "application.yml");
const LAUNCH = path.join(WS, ".vscode", "launch.json");

const health = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${DEV_PORT}/actuator/health`);
    return { status: r.status, body: (await r.text()).slice(0, 300) };
  } catch (e) {
    return { status: 0, body: e.message };
  }
};
/** The Java panel's Spring tab: its frame and its text. */
const springTab = async () => {
  await clickActivity(page, "Java");
  await sleep(1500);
  const frame = await panelFrame(page);
  if (!frame) return { frame: null, text: "" };
  for (const t of await frame.$$('[role="tab"]'))
    if ((await t.evaluate((e) => e.textContent.trim())) === "Spring") {
      await t.click();
      await sleep(800);
    }
  const text = await frame.$eval('[role="tabpanel"]:not([hidden])', (e) => e.innerText.replace(/\s+/g, " ").trim()).catch(() => "");
  return { frame, text };
};

const browser = await puppeteer.connect({ browserURL: CDP });
const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 1360, height: 900 });

try {
  const trust = async () => {
    await settle(() => javaStatus(page), (s) => s.length > 0, 90000);
    // A click on a button that re-renders mid-click throws: the next round retries it.
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
  const detected = await settle(
    () => outputLines(page, "Spring Boot: Show the Spring log").catch(() => []),
    (l) => l.some((x) => /detected Spring Boot|no Spring Boot module/.test(x)),
    90000,
    2000,
  );
  await runCommand(page, "Notifications: Show Notifications");
  await sleep(800);
  await snap(page, "detect");
  emit({ phase: "detect", lines: detected.value ?? [], notifications: await notifications(page) });

  if (!DEGRADED) {
    // Case 1: Spring Tools' server started on the bridged JDK — after the
    // reload, as RFC 0011 found for the MicroProfile server — documents server.port.
    if ((detected.value ?? []).join(" ").includes("wrote spring-boot.ls.java.home")) {
      await openWorkbench(page);
      await trust();
    }
    await openFile(page, "application.yml");
    const hover = await settle(
      async () => {
        await openFile(page, "application.yml");
        await chord(page, "Control", "g");
        await sleep(400);
        await page.keyboard.type("5:5");
        await page.keyboard.press("Enter");
        await sleep(400);
        await runCommand(page, "Show or Focus Hover");
        await sleep(2500);
        const t = norm(await page.$eval(".monaco-hover .hover-contents", (e) => e.innerText).catch(() => ""));
        await page.keyboard.press("Escape");
        return t;
      },
      (t) => /port/i.test(t) && t.length > 20,
      300000,
      5000,
    );
    await snap(page, "hover");
    emit({ phase: "hover", text: (hover.value ?? "").slice(0, 400), timedOut: !!hover.timedOut, ms: hover.ms });
  }

  // Case 2 (and 5): tick `dev` in the Spring tab.
  const before = await springTab();
  const toggle = before.frame && (await before.frame.$('button[data-cmd="batlehub.java.spring.toggleProfile"][data-arg="dev"]'));
  if (toggle) await toggle.evaluate((e) => e.click());
  await sleep(2500);
  const settings = readIfPresent(path.join(WS, ".vscode", "settings.json"));
  const after = await springTab();
  await snap(page, "profiles");
  emit({ phase: "profiles", before: before.text, after: after.text, clicked: !!toggle, settings });

  // The template, through the core's run editor.
  await runCommand(page, "Java: New run configuration…");
  await sleep(1200);
  await page.keyboard.type("Spring Boot application");
  await sleep(800);
  await page.keyboard.press("Enter");
  const written = await settle(() => readIfPresent(LAUNCH), (t) => /spring-boot/.test(t ?? ""), 30000, 1000);
  emit({ phase: "template", launch: written.value ?? null, timedOut: !!written.timedOut });

  if (!DEGRADED) {
    // Run it: the dev document's port answers, which only the profile can have chosen.
    await runCommand(page, "Debug: Select and Start Debugging");
    await sleep(1000);
    await page.keyboard.type("Spring Boot: DemoApplication");
    await sleep(800);
    await page.keyboard.press("Enter");
    const up = await settle(health, (h) => h.status === 200 && /"UP"/.test(h.body), 300000, 3000);
    await snap(page, "run");
    // The active profiles as Boot itself reports them: the fixture exposes env.
    let activeProfiles = null;
    try {
      activeProfiles = (await (await fetch(`http://127.0.0.1:${DEV_PORT}/actuator/env`)).json()).activeProfiles ?? null;
    } catch {
      activeProfiles = null;
    }
    // Case 4: the dashboard's row for this instance (started by the editor),
    // a saved edit restarts it through devtools, the row's uptime resets.
    const rowOf = (text, port) => (new RegExp(`localhost:${port} UP[^]*?(?=localhost:\\d|Restart:|$)`).exec(text) ?? [""])[0];
    const row1 = await settle(async () => rowOf((await springTab()).text, DEV_PORT), (r) => /UP/.test(r), 30000, 2000);
    const CONTROLLER = path.join(WS, "src", "main", "java", "com", "acme", "demo", "HelloController.java");
    const controller = readIfPresent(CONTROLLER);
    writeFileSync(CONTROLLER, controller.replace("Hello from Spring Boot", "Hello after a restart"));
    let hello = null;
    const restarted = await settle(
      async () => {
        try {
          hello = await (await fetch(`http://127.0.0.1:${DEV_PORT}/hello`)).text();
        } catch {
          hello = null;
        }
        return hello;
      },
      (h) => h === "Hello after a restart",
      90000,
      2000,
    );
    const row2 = await settle(async () => rowOf((await springTab()).text, DEV_PORT), (r) => /restarted 1×/.test(r), 30000, 2000);
    // The tab re-renders on every poll: read it until the reason line is in.
    const tabText = (await settle(async () => (await springTab()).text, (t) => /Restart: /.test(t), 20000, 1000)).value ?? "";
    await snap(page, "restarted");
    // Stop from the tab: enabled for an instance the editor started (decision 14).
    const tabNow = await springTab();
    const stopButton = tabNow.frame && (await tabNow.frame.$(`button[data-cmd="batlehub.java.spring.stopInstance"][data-arg="${DEV_PORT}"]`));
    if (stopButton) await stopButton.evaluate((e) => e.click());
    const down = await settle(health, (h) => h.status === 0, 60000, 1000);
    writeFileSync(CONTROLLER, controller);
    emit({ phase: "run", health: up.value, timedOut: !!up.timedOut, ms: up.ms, activeProfiles, stopped: !down.timedOut });
    emit({
      phase: "devtools",
      row1: row1.value ?? "",
      restarted: !restarted.timedOut,
      hello,
      row2: row2.value ?? "",
      rowRestarted: !row2.timedOut,
      restartReason: /Restart: no restart endpoint/.test(tabText),
      stopFromTab: !!stopButton,
      stopped: !down.timedOut,
    });

    // Case 3: an instance the editor did not start — `spring-boot:run` as a
    // batlehub-java task, on the default port.
    const status8080 = async () => {
      try {
        return (await fetch("http://127.0.0.1:8080/actuator/health")).status;
      } catch {
        return 0;
      }
    };
    await runCommand(page, "Java: Run a Maven goal / Gradle task…");
    await sleep(1200);
    await page.keyboard.type("Other");
    await sleep(600);
    await page.keyboard.press("Enter");
    await sleep(1000);
    await page.keyboard.type("spring-boot:run");
    await page.keyboard.press("Enter");
    const otherUp = await settle(status8080, (st) => st === 200, 300000, 2000);
    const t0 = Date.now();
    const upAt = new Date(t0).toISOString();
    const row3 = await settle(async () => rowOf((await springTab()).text, 8080), (r) => /UP/.test(r), 30000, 1000);
    const rowAfterMs = Date.now() - t0;
    const tab3 = await springTab();
    const stopDisabled = tab3.frame
      ? await tab3.frame.$eval('tr[data-port="8080"] button[title="started outside the editor"]', (e) => e.disabled).catch(() => false)
      : false;
    const openButton = tab3.frame && (await tab3.frame.$('button[data-cmd="batlehub.java.spring.openInstance"][data-arg="8080"]'));
    // Below the fold of the side panel: clicked through the DOM, not by coordinates.
    if (openButton) await openButton.evaluate((e) => e.click());
    await sleep(3000);
    const editorTabs = await page.$$eval(".tabs-container .tab", (els) => els.map((e) => e.getAttribute("aria-label") || e.innerText)).catch(() => []);
    await snap(page, "dashboard-open");
    // Ctrl+C in the task's terminal: the instance goes, and so does its row.
    // The simple browser's webview holds the keyboard, and the palette with it:
    // a click on the task's terminal gives the keys to the terminal.
    const screen = await page.$(".part.panel .terminal .xterm-screen, .part.panel .xterm-screen");
    if (screen) await screen.click();
    await sleep(800);
    await chord(page, "Control", "c");
    const gone = await settle(status8080, (st) => st === 0, 60000, 1000);
    const t1 = Date.now();
    const rowGone = await settle(async () => rowOf((await springTab()).text, 8080), (r) => r === "", 30000, 1000);
    emit({
      phase: "dashboard",
      up: !otherUp.timedOut,
      row: row3.value ?? "",
      rowAfterMs,
      upAt,
      rowAt: new Date(t0 + rowAfterMs).toISOString(),
      stopDisabled,
      opened: editorTabs.some((t) => /Simple Browser|localhost:8080/.test(t)),
      editorTabs: editorTabs.slice(0, 6),
      appStopped: !gone.timedOut,
      rowGoneMs: rowGone.timedOut ? -1 : Date.now() - t1,
    });

    // Case 6: an ordered run (RFC 0003) whose first step is the app as the
    // `spring-boot` kind, the second a client that needs it; then reverse stop.
    const file = JSON.parse((readIfPresent(LAUNCH) ?? '{"configurations":[]}').replace(/^\s*\/\/.*$/gm, ""));
    file.configurations.push({
      type: "batlehub-run",
      request: "launch",
      name: "Acceptance (Spring)",
      steps: [
        { server: "spring-boot" },
        {
          process: ["node", "-e", `fetch("http://localhost:${DEV_PORT}/hello").then((r) => r.text()).then((t) => { console.log("IT got " + t); process.exit(t === "Hello from Spring Boot" ? 0 : 1); }, () => process.exit(2))`],
          memoryMiB: 64,
          ready: { exit: 0 },
        },
      ],
    });
    writeFileSync(LAUNCH, JSON.stringify(file, null, 2));
    await sleep(1500);
    await runCommand(page, "Debug: Select and Start Debugging");
    await sleep(1000);
    await page.keyboard.type("Acceptance (Spring)");
    await sleep(800);
    await page.keyboard.press("Enter");
    const replNow = async () => {
      // A step's terminal opening mid-typing takes the keys: the next round retries.
      if (!(await runCommand(page, "Debug Console: Focus on Debug Console View").then(() => true, () => false))) {
        await page.keyboard.press("Escape");
        return [];
      }
      await sleep(600);
      return page.$$eval(".repl .monaco-list-row", (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
    };
    const accept = await settle(replNow, (l) => l.some((x) => /^stopping 1 \(/.test(x)) || l.some((x) => /^step \d (not ready|exited \d+, expected|:)/.test(x)), 300000, 3000);
    // The step's terminal keeps the app's log, its graceful shutdown last.
    await runCommand(page, "Terminal: Focus Terminal").catch(() => page.keyboard.press("Escape"));
    await sleep(1000);
    const term = await page.$$eval(".part.panel .xterm-rows > div", (els) => els.map((e) => e.innerText.replace(/\u00a0/g, " ").trimEnd()).filter(Boolean)).catch(() => []);
    await snap(page, "accept");
    emit({
      phase: "accept",
      console: accept.value ?? [],
      timedOut: !!accept.timedOut,
      graceful: term.some((r) => /Commencing graceful shutdown|Graceful shutdown complete/.test(r)),
      portFree: (await health()).status === 0,
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

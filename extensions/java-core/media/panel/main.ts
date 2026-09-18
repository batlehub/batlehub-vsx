// The Java panel's DOM (RFC 0001 decisions 18, 27): tabs with the WAI-ARIA
// tabs pattern (arrow keys, Home/End, roving tabindex), form controls styled
// by `--vscode-*` tokens, and every write a message to the extension, which
// writes settings.json — the panel and the Settings UI never disagree.
/* eslint-disable no-undef */
declare function acquireVsCodeApi(): {
  postMessage(m: unknown): void;
  getState(): { tab?: string } | undefined;
  setState(s: { tab?: string }): void;
};

type State = {
  trusted: boolean;
  serverMode: string;
  jdk: {
    runtimes: {
      name: string;
      version: string;
      vendor?: string;
      path: string;
      source: string;
      resolved: boolean;
    }[];
    required?: { min: number; origin: string };
    reason?: string;
    managers: string[];
    installVia: { value: string; origin: string };
    sources: { value: string[]; origin: string };
    matchProject: boolean;
    resources: {
      limit?: string;
      planned: string;
      consumers: { name: string; bytes: string }[];
      warning?: string;
    };
  };
  build: {
    tool?: string;
    buildFile?: string;
    wrapper?: string;
    mavenConfigurations: {
      name: string;
      settingsFile?: string;
      active: boolean;
    }[];
    mavenOrigin: string;
    stock: { id: string; name: string; quiet: boolean }[];
    satelliteItems: { id: string; shown: boolean }[];
    registry: { enabled: string; url: string; origin: string };
  };
  run: {
    configs: {
      name: string;
      request: string;
      mainClass?: string;
      projectName?: string;
    }[];
    debugger: boolean;
    testRunner: boolean;
  };
  profiles: { declared: string[]; active: string[] };
  experimental: Record<string, boolean>;
  tabs: { id: string; title: string; html: string }[];
};

const vscode = acquireVsCodeApi();
const app = document.getElementById("app")!;
let state: State | undefined;
let current = vscode.getState()?.tab ?? "jdk";

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const post = (m: Record<string, unknown>) => vscode.postMessage(m);
const origin = (o: string) =>
  `<span class="origin" title="${esc(o)}">${esc(o)}</span>`;

function tabJdk(s: State): string {
  const j = s.jdk;
  const rows = j.runtimes.length
    ? j.runtimes
        .map(
          (r) =>
            `<tr class="${r.resolved ? "resolved" : ""}"><td><input type="radio" name="runtime" aria-label="Use ${esc(r.name)}" data-use="${esc(r.path)}" ${r.resolved ? "checked" : ""}></td><td>${esc(r.name)}</td><td>${esc(r.version)}${r.vendor ? ` · ${esc(r.vendor)}` : ""}</td><td>${origin(`detected: ${r.source}`)}</td><td class="path">${esc(r.path)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="muted">No JDK found. ${j.managers.length ? "Install one with " + esc(j.managers[0]) + "." : "No JDK manager found either — see the guide."}</td></tr>`;
  const req = j.required
    ? `The project asks for Java <b>${j.required.min}</b> (${esc(j.required.origin)})${j.reason === "newest" ? ` — <span class="warn">no matching runtime: the newest is used</span>` : ""}.`
    : "The build file names no Java version.";
  const res = j.resources;
  return `
<section aria-labelledby="h-jdk"><h2 id="h-jdk">Runtimes</h2>
<p>${req}</p>
<table aria-label="Installed JDKs"><thead><tr><th scope="col">Use</th><th scope="col">Name</th><th scope="col">Version</th><th scope="col">Origin</th><th scope="col">Path</th></tr></thead><tbody>${rows}</tbody></table>
<div class="row">
  <button data-msg="detect" ${s.trusted ? "" : 'disabled title="untrusted workspace: nothing runs"'}>Detect</button>
  <button data-msg="installJdk" ${s.trusted ? "" : "disabled"}>Install a JDK…</button>
  <label><input type="checkbox" data-set="jdk.matchProject" ${j.matchProject ? "checked" : ""}> Pick the runtime the project asks for</label>
</div>
<div class="field"><label for="installVia">Install through</label>
  <select id="installVia" data-set="jdk.installVia"><option value="auto" ${j.installVia.value === "auto" ? "selected" : ""}>auto (${esc(j.managers.join(", ") || "none found")})</option><option value="mise" ${j.installVia.value === "mise" ? "selected" : ""}>mise</option><option value="sdkman" ${j.installVia.value === "sdkman" ? "selected" : ""}>sdkman</option><option value="none" ${j.installVia.value === "none" ? "selected" : ""}>none</option></select>
  ${origin(j.installVia.origin)} ${j.installVia.origin === "set by you" ? `<button class="link" data-clear="jdk.installVia">Clear override</button>` : ""}</div>
<div class="field"><label for="sources">Sources, in order</label><input id="sources" data-set-list="jdk.sources" value="${esc(j.sources.value.join(", "))}" aria-describedby="sources-help"> ${origin(j.sources.origin)} ${j.sources.origin === "set by you" ? `<button class="link" data-clear="jdk.sources">Clear override</button>` : ""}<span id="sources-help" class="muted">mise, sdkman, env, wellKnown</span></div>
</section>
<section aria-labelledby="h-res"><h2 id="h-res">The container's resources</h2>
${res.warning ? `<p class="warn" role="alert">⚠ ${esc(res.warning)} <a href="https://batleforc.github.io/batlehub-vsx/guide/java/resources">What to put in the devfile</a></p>` : ""}
<p>Limit: <b>${esc(res.limit ?? "none (no cgroup limit)")}</b> · planned: <b>${esc(res.planned)}</b></p>
<ul>${res.consumers.map((c) => `<li>${esc(c.name)}: ${esc(c.bytes)}</li>`).join("")}</ul>
</section>
<section aria-labelledby="h-srv"><h2 id="h-srv">Language server</h2>
<p>Mode: <b>${esc(s.serverMode)}</b>${s.serverMode !== "Standard" ? ` — rename, Generate and inspections need Standard. <button data-msg="switchMode">Switch to Standard</button>` : ""}</p>
</section>`;
}

function tabBuild(s: State): string {
  const b = s.build;
  return `
<section aria-labelledby="h-build"><h2 id="h-build">Build tool</h2>
<p>${b.tool ? `<b>${esc(b.tool)}</b> · ${esc(b.buildFile)}${b.wrapper ? ` · wrapper ${esc(b.wrapper)}` : " · no wrapper (PATH tool)"}` : "No Maven or Gradle build in the first folder."}</p>
<div class="row"><button data-cmd="batlehub.java.runGoal" ${s.trusted ? "" : "disabled"}>Run a goal or task…</button><button data-cmd="batlehub.java.reimport">Reload the Java projects</button></div>
</section>
<section aria-labelledby="h-mvn"><h2 id="h-mvn">Maven configurations ${origin(b.mavenOrigin)}</h2>
${b.mavenConfigurations.length ? `<table aria-label="Maven configurations"><thead><tr><th scope="col">Active</th><th scope="col">Name</th><th scope="col">Settings file</th></tr></thead><tbody>${b.mavenConfigurations.map((c) => `<tr><td><input type="radio" name="mvncfg" aria-label="Activate ${esc(c.name)}" data-set-value="maven.activeConfiguration" value="${esc(c.name)}" ${c.active ? "checked" : ""}></td><td>${esc(c.name)}</td><td class="path">${esc(c.settingsFile ?? "")}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">None: no ~/.m2/settings*.xml, and batlehub.java.maven.configurations is unset.</p>`}
<p class="muted">Switching writes java.configuration.maven.userSettings (workspace) and re-imports.</p>
</section>
<section aria-labelledby="h-reg"><h2 id="h-reg">BatleHub registry link ${origin(b.registry.origin)}</h2>
<div class="field"><label for="reg">Route the build through BatleHub</label><select id="reg" data-set="registry.enabled"><option value="ask" ${b.registry.enabled === "ask" ? "selected" : ""}>ask</option><option value="true" ${b.registry.enabled === "true" ? "selected" : ""}>yes</option><option value="false" ${b.registry.enabled === "false" ? "selected" : ""}>no</option></select></div>
<div class="field"><label for="regurl">Registry URL</label><input id="regurl" data-set-text="registry.url" value="${esc(b.registry.url)}" placeholder="empty: the one batlehub-vsx is signed into"></div>
</section>
<section aria-labelledby="h-stock"><h2 id="h-stock">Stock Java extensions</h2>
${b.stock.length ? `<ul>${b.stock.map((x) => `<li>${esc(x.name)} — ${x.quiet ? `quieted <button data-restore="${esc(x.id)}">Put back</button>` : `<button data-quiet="${esc(x.id)}">Quiet its duplicates</button>`}</li>`).join("")}</ul>` : `<p class="muted">None installed.</p>`}
</section>
<section aria-labelledby="h-sat"><h2 id="h-sat">Satellite status bar items</h2>
${b.satelliteItems.length ? `<ul>${b.satelliteItems.map((i) => `<li><label><input type="checkbox" data-item="${esc(i.id)}" ${i.shown ? "checked" : ""}> ${esc(i.id)}</label></li>`).join("")}</ul>` : `<p class="muted">No satellite registered one.</p>`}
</section>`;
}

function tabRun(s: State): string {
  const r = s.run;
  return `
<section aria-labelledby="h-run"><h2 id="h-run">Run configurations</h2>
<p class="muted">Stored in .vscode/launch.json as type "java"; the stock debugger reads them.${r.debugger ? "" : " <span class='warn'>The Java debugger (vscjava.vscode-java-debug) is not installed: no Run/Debug gutter; the editor still writes launch.json.</span>"}${r.testRunner ? "" : " <span class='warn'>The test runner is not installed: no test gutter.</span>"}</p>
${r.configs.length ? `<table aria-label="Run configurations"><thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Main class</th><th scope="col">Project</th><th scope="col"></th></tr></thead><tbody>${r.configs.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.request)}</td><td>${esc(c.mainClass ?? "")}</td><td>${esc(c.projectName ?? "")}</td><td><button data-cmd="batlehub.java.run.edit" data-arg="${esc(c.name)}">Edit…</button> <button data-cmd="batlehub.java.run.start" data-arg="${esc(c.name)}" ${r.debugger ? "" : "disabled"}>Run</button></td></tr>`).join("")}</tbody></table>` : `<p class="muted">None yet.</p>`}
<div class="row"><button data-cmd="batlehub.java.run.new">New configuration…</button><button data-cmd="batlehub.java.run.edit">Edit configurations…</button>${s.experimental.intellijImport ? `<button data-cmd="batlehub.java.importIdea">Import IntelliJ run configurations…</button>` : ""}</div>
</section>
<section aria-labelledby="h-exp"><h2 id="h-exp">Experimental</h2>
<label><input type="checkbox" data-flag="intellijImport" ${s.experimental.intellijImport ? "checked" : ""}> IntelliJ run-configuration import (.idea/runConfigurations → launch.json)</label>
</section>`;
}

function tabProfiles(s: State): string {
  const p = s.profiles;
  return `
<section aria-labelledby="h-prof"><h2 id="h-prof">Maven profiles</h2>
<p class="muted">Passed as -P to every goal and written where m2e reads them for the language server's import.</p>
${p.declared.length ? `<ul class="checks">${p.declared.map((id) => `<li><label><input type="checkbox" data-profile="${esc(id)}" ${p.active.includes(id) ? "checked" : ""}> ${esc(id)}</label></li>`).join("")}</ul>` : `<p class="muted">The POM declares no profiles.</p>`}
${
  p.active.filter((a) => !p.declared.includes(a)).length
    ? `<p>Also active (from settings): ${p.active
        .filter((a) => !p.declared.includes(a))
        .map(esc)
        .join(", ")}</p>`
    : ""
}
</section>`;
}

function render(): void {
  if (!state) return;
  const tabs = [
    { id: "jdk", title: "JDK", html: tabJdk(state) },
    { id: "build", title: "Build", html: tabBuild(state) },
    { id: "run", title: "Run", html: tabRun(state) },
    { id: "profiles", title: "Profiles", html: tabProfiles(state) },
    ...state.tabs,
  ];
  if (!tabs.some((t) => t.id === current)) current = "jdk";
  app.innerHTML = `
${state.trusted ? "" : `<p class="warn" role="alert">Untrusted workspace: nothing runs until you trust it. Detection reads files only.</p>`}
<div role="tablist" aria-label="Java panel tabs" class="tabs">${tabs.map((t) => `<button role="tab" id="tab-${esc(t.id)}" aria-controls="panel-${esc(t.id)}" aria-selected="${t.id === current}" tabindex="${t.id === current ? 0 : -1}" data-tab="${esc(t.id)}">${esc(t.title)}</button>`).join("")}</div>
${tabs.map((t) => `<div role="tabpanel" id="panel-${esc(t.id)}" aria-labelledby="tab-${esc(t.id)}" ${t.id === current ? "" : "hidden"}>${t.html}</div>`).join("")}`;
  wire();
}

function wire(): void {
  const tabEls = [...app.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  tabEls.forEach((el, i) => {
    el.addEventListener("click", () => select(el.dataset.tab!));
    el.addEventListener("keydown", (e) => {
      const n =
        e.key === "ArrowRight"
          ? (i + 1) % tabEls.length
          : e.key === "ArrowLeft"
            ? (i - 1 + tabEls.length) % tabEls.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? tabEls.length - 1
                : -1;
      if (n < 0) return;
      e.preventDefault();
      select(tabEls[n]!.dataset.tab!);
      tabEls[n]!.focus();
    });
  });
  app
    .querySelectorAll<HTMLElement>("[data-msg]")
    .forEach((el) =>
      el.addEventListener("click", () => post({ type: el.dataset.msg })),
    );
  app.querySelectorAll<HTMLElement>("[data-cmd]").forEach((el) =>
    el.addEventListener("click", () =>
      post({
        type: "command",
        command: el.dataset.cmd,
        args: el.dataset.arg !== undefined ? [el.dataset.arg] : [],
      }),
    ),
  );
  app
    .querySelectorAll<HTMLInputElement>("[data-use]")
    .forEach((el) =>
      el.addEventListener("change", () =>
        post({ type: "useRuntime", path: el.dataset.use }),
      ),
    );
  app
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-set]")
    .forEach((el) =>
      el.addEventListener("change", () =>
        post({
          type: "set",
          key: el.dataset.set,
          value:
            el instanceof HTMLInputElement && el.type === "checkbox"
              ? el.checked
              : el.value,
        }),
      ),
    );
  app
    .querySelectorAll<HTMLInputElement>("[data-set-value]")
    .forEach((el) =>
      el.addEventListener(
        "change",
        () =>
          el.checked &&
          post({ type: "set", key: el.dataset.setValue, value: el.value }),
      ),
    );
  app
    .querySelectorAll<HTMLInputElement>("[data-set-text]")
    .forEach((el) =>
      el.addEventListener("change", () =>
        post({ type: "set", key: el.dataset.setText, value: el.value.trim() }),
      ),
    );
  app.querySelectorAll<HTMLInputElement>("[data-set-list]").forEach((el) =>
    el.addEventListener("change", () =>
      post({
        type: "set",
        key: el.dataset.setList,
        value: el.value
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      }),
    ),
  );
  app
    .querySelectorAll<HTMLElement>("[data-clear]")
    .forEach((el) =>
      el.addEventListener("click", () =>
        post({ type: "set", key: el.dataset.clear, value: null }),
      ),
    );
  app
    .querySelectorAll<HTMLElement>("[data-restore]")
    .forEach((el) =>
      el.addEventListener("click", () =>
        post({ type: "restoreStock", id: el.dataset.restore }),
      ),
    );
  app
    .querySelectorAll<HTMLElement>("[data-quiet]")
    .forEach((el) =>
      el.addEventListener("click", () =>
        post({ type: "quietStock", id: el.dataset.quiet }),
      ),
    );
  app
    .querySelectorAll<HTMLInputElement>("[data-item]")
    .forEach((el) =>
      el.addEventListener("change", () =>
        post({ type: "toggleItem", id: el.dataset.item, shown: el.checked }),
      ),
    );
  app.querySelectorAll<HTMLInputElement>("[data-flag]").forEach((el) =>
    el.addEventListener("change", () =>
      post({
        type: "set",
        key: "experimental",
        value: {
          ...state?.experimental,
          [el.dataset.flag!]: el.checked,
        },
      }),
    ),
  );
  app.querySelectorAll<HTMLInputElement>("[data-profile]").forEach((el) =>
    el.addEventListener("change", () => {
      const active = new Set(state?.profiles.active ?? []);
      if (el.checked) active.add(el.dataset.profile!);
      else active.delete(el.dataset.profile!);
      post({ type: "set", key: "maven.activeProfiles", value: [...active] });
    }),
  );
  app.querySelectorAll<HTMLElement>("[data-tab-msg]").forEach((el) =>
    el.addEventListener("click", () =>
      post({
        type: "tab",
        id: el.dataset.tabMsg,
        message: el.dataset.message,
      }),
    ),
  );
}

function select(id: string): void {
  current = id;
  vscode.setState({ tab: id });
  app.querySelectorAll<HTMLElement>('[role="tab"]').forEach((t) => {
    const on = t.dataset.tab === id;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
  });
  app
    .querySelectorAll<HTMLElement>('[role="tabpanel"]')
    .forEach((p) => (p.hidden = p.id !== `panel-${id}`));
}

window.addEventListener(
  "message",
  (e: MessageEvent<{ type: string; state?: State }>) => {
    if (e.data.type === "state" && e.data.state) {
      state = e.data.state;
      render();
    }
  },
);
post({ type: "ready" });

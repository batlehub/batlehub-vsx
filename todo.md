# RFC 0001 — Java for VS Code: implementation, findings, state of play

**Started** 2026-09-17 · branch `feat-java` (from `main`) · RFC status at start: **Draft, revision 3
— ready to implement from §12 phase 0**. **RFC status now: Accepted** (revision
4, 2026-09-18, reviewed with the user). **State on 2026-09-18 02:43:** phases
0–8 landed and the whole `java` heavy half is green in the real editor
(`task heavy:view:java`, run 16: `JAVA-OK`, sixteen steps from `STATUS-OK` to
`REMOVE-OK` and the performance gate); phase 9 deliberately not done. Committed on `feat-java` (`17c541a`,
`5dce7a7`); the RFC is at revision 5 with the findings below carried into §15.

## Still owed (the honest list)

- **layer 2** (`@vscode/test-cli`) runs only in CI's `host` job — no display here;
- the panel's **golden screenshots / pixelmatch** of §10: screenshots are
  taken in the three themes and kept as artifacts; no pixel comparison
  (a renderer-dependent gate nobody stood behind yet);
- the **nightly matrix** and the **registry half in CI** are written, never
  run on a runner (this workspace cannot run GitHub Actions);
- **phase 9** (the split) deliberately not done: no trigger.

Everything else the RFC names has been driven by a real client: the `java`
half (run 19, 2026-09-18 06:57, sixteen steps green including a Maven task
run to `BUILD SUCCESS` in the terminal, the Groovy hover and the status bar
toggle) and the `registry` half (run 3, 06:35, against BatleHub release
binaries and the Postgres sidecar).

## Phases

| Phase | Scope | State |
| --- | --- | --- |
| 0 | spikes (a) m2e profiles, (b) `redhat.java` API, (c) cgroup | ✅ all three answered — (a) positive in the real editor (run 10): the m2e preference works, no overlay |
| 1 | skeleton: `java-core`, `java-pack`, layers 1–2, fixtures, `rfc:*`, CI | ✅ landed (layer 2 written, CI-only) |
| 2 | `java-core` v0.1 — the newcomer story | ✅ landed; **proven in the real editor** (`STATUS-OK`, `DETECT-OK`, `NEWCOMER-OK`, `SERVER-OK`, `PICK-OK`, `REMOVE-OK`, `PERF-GATE`) |
| 3 | `java-core` v0.2 — the surface (panel, menus, tasks, report) | ✅ landed; **proven** (`PANEL-OK` with ARIA + three themes, `TASKS-OK`, `GENERATE-OK`); Report a problem unit-tested |
| 4 | `java-core` v0.3 — explorer, run editor, IntelliJ import | ✅ landed; explorer **proven** (`EXPLORER-OK`); run editor (quick-input form, feedback 8) and import unit-tested |
| 5 | `java-core` v0.4 — Maven, registry link, `batlehub-vsx` export | ✅ landed; profiles-through-m2e **proven** (`SPIKE-A-OK`); registry link **proven against a real hub** (`REGISTRY-LINK-OK`: token from batlehub-vsx, Maven resolving through the mirror) |
| 6 | `java-core` v0.5 — the JDT bundle (Java) | ✅ landed (fork): Maven + bnd, 11 inspections, accessors delegate, 19 JUnit; **proven in the editor** (`BUNDLE-OK`, `INSPECTIONS-OK`, `GENERATE-OK`) |
| 7 | `java-core` v0.6 — Gradle | ✅ landed; the fixture built and tested with a real Gradle 8.14.5, its real output parsed by the tests |
| 8 | `java-groovy` v0.1 | ✅ landed (fork); **proven in the editor** (`GROOVY-OK`: contract registration, server on the core's JDK, Groovy mode, panel tab) |
| 9 | the split | ⬜ (P2 — "if it has earned itself"; it has not, see §9) |

**Environment this was implemented in** (a Che workspace, `che-browser` parent):
JDK temurin 21.0.11 and 25.0.4 through `mise`, Maven 3.9.16 through `mise`,
no Gradle, no sdkman, cgroup v2 `memory.max` = 16 GiB, Chrome sidecar with
CDP on 9222 and noVNC, VS Code web 1.136.1 cached under
`~/.cache/batlehub-heavy`, Open VSX reachable. **No Xvfb and no GTK in the
tools container**, so `@vscode/test-electron` (layer 2) cannot run here — it
is wired for CI and the real-editor proof is the heavy suite in the browser
sidecar.

---

## 0. Spikes

### (b) `redhat.java`'s exported API — answered from the VSIX

Read from the `redhat.java` VSIX on Open VSX, `1.56.0` (stable) and
`1.57.2026091208` (pre-release), unpacked and grepped
(`dist/extension.js`). **`1.57.0` is not on Open VSX** — the RFC's decision 8
names "1.57.0 as of 2026-09-09" from `main`; Open VSX carries `1.56.0`,
`1.55.0` and the dated pre-releases. So the pin is **`1.56.0`**: the oldest
release on the gallery a che-code mirror serves that has every API below.

- Exported API (`extensions.getExtension("redhat.java").exports`):
  `apiVersion`, `javaRequirement`, `status`, `serverMode`,
  `onDidServerModeChange`, `serverReady()`, `serverRunning()`,
  `onDidClasspathUpdate`, `onDidProjectsImport`, `onDidProjectsDelete`,
  `getProjectSettings`, `getClasspaths(uri, {scope})`, `isTestFile`,
  `registerHoverCommand`, `onWillRequestStart`, `onDidRequestEnd`,
  `onDidSourceInvalidate`, `trackEvent`. Identical in both versions.
- Context key `redhat.java` itself sets: `java:serverMode`
  (`Standard | LightWeight | Hybrid`).
- Commands: `java.server.restart` (contributed), `java.server.mode.switch`
  (contributed; refuses in an untrusted workspace with its own message),
  `java.execute.workspaceCommand` (internal, takes a JDT.LS command id and args),
  `java.project.import.command`, `java.clean.workspace`.
- The generators: `java.action.generateAccessorsPrompt`,
  `java.action.generateConstructorsPrompt`,
  `java.action.generateToStringPrompt`, `java.action.hashCodeEqualsPrompt`,
  `java.action.generateDelegateMethodsPrompt`, plus
  `java.action.overrideMethodsPrompt` and `java.action.organizeImports`.
  **They are internal** (not in `contributes.commands`) and each takes **one
  argument: LSP `CodeActionParams`** (`{ textDocument: { uri }, range,
  context: { diagnostics: [] } }`); the accessors one also reads `kind`
  (`AccessorKind`: `both | getter | setter`) off the same object. Same names
  and shapes in `1.56.0` and the pre-release.
- `contributes.javaExtensions` is read at server start from every installed
  extension's `packageJSON.contributes.javaExtensions` and resolved against
  the extension path (confirmed in the bundle, `existingExtensions`).
- JDT.LS default `-Xmx2G` (`java.jdt.ls.vmargs`); `java.server.launchMode`
  default `Hybrid`; `untrustedWorkspaces: limited` with `java.jdt.ls.java.home`,
  `java.configuration.runtimes`, `java.jdt.ls.vmargs` restricted.
- m2e in the VSIX (`org.eclipse.m2e.core_2.7.800`) does ship
  `ResolverConfigurationIO` reading `activeProfiles` /
  `resolveWorkspaceProjects` from `.settings/org.eclipse.m2e.core.prefs`;
  JDT.LS's `MavenProjectImporter` goes through m2e's
  `ProjectImportConfiguration`. Whether the import honours the file is spike
  (a) — a running server answers it, not a class listing.

### (c) cgroup limit — answered in this pod

`/sys/fs/cgroup/memory.max` = `17179869184` (16 GiB) in this workspace's
tools container (cgroup v2). JDT.LS starts with `-Xmx2G` by default. The
warning threshold `resources.warnBelow: "2Gi"` is therefore a real signal for
a default Che `memoryLimit` and silent here.

### (a) Maven profiles through the import — the `java` heavy scenario

- [x] `maven-multi` fixture with a profile-only dependency (`dev` profile adds
      `commons-lang3`)
- [x] `activeProfiles=dev` written to `.settings/org.eclipse.m2e.core.prefs`,
      re-import, classpath read through `getClasspaths` — the extension
      exposes it as `Java: Dump classpath (spike)` writing to the
      `BatleHub Java` channel, the heavy driver reads the channel
- [x] **result: POSITIVE** (heavy run 10, 2026-09-17 23:31, JDT.LS 1.61.0 of
      redhat.java 1.56.0): `core`'s runtime classpath before any profile had
      no `commons-lang3`; after `activeProfiles=dev` in
      `core/.settings/org.eclipse.m2e.core.prefs` and `Java: Reload the Java
      projects`, `getClasspaths` returned
      `~/.m2/repository/org/apache/commons/commons-lang3/3.17.0/commons-lang3-3.17.0.jar`.
      m2e reads the preference; **no overlay is needed** (decision 14's hoped-for
      outcome). The overlay code stays as the explicit fallback command
      (`Java: Maven: apply the profiles through a settings overlay`) and is
      not on any default path.

---

## 1. Skeleton

- [x] `extensions/java-core` (activates on a Java folder), `extensions/java-pack`
- [x] layer 1: vitest + `test/vscode-mock.ts` — `test/*.test.ts`, 28 tests:
      resolution table, mise/sdkman parsing, cgroup + threshold, launch.json
      round trip with comments and unknown keys kept, manifest replay,
      gating, contract refusal, redaction, POM/Gradle reading
- [x] layer 2: `@vscode/test-cli` under `test-host/` (`task ext:host`; CI
      job `host` under xvfb — **not runnable in this workspace**, see above)
- [x] fixtures `tests/heavy/fixtures/maven-multi` (built once with Maven
      3.9.16 / JDK 21: green, tests pass), `gradle-multi` (wrapper 8.14.3)
- [x] `rfc:*` tasks ported from BatleHub (`docs/build/rfc.mjs`, `rfc-meta.mjs`,
      `docs/internal/0000-rfc-template.md`, `docs/rfc/index.md`, the sidebar
      block in `docs/.vitepress/config.ts`); `task check` runs `rfc:index:check`
- [x] CI: `check` (lint, settings↔docs, l10n, RFC index, unit, package,
      third-party notices, VSIX size budget, docs, audit), `host`, `heavy-java`
- [x] `cog.toml` blocks for `che-notify` (was missing), `java-core`, `java-pack`, `java-groovy`
- [x] the `java` heavy half (`HEAVY_ONLY=java` / `task heavy:view:java`,
      `tests/heavy/java.mjs`; view.sh's BatleHub sections gated on `NEED_HUB`)
- [x] `scripts/check-settings-doc.mjs`, `check-l10n.mjs`, `l10n-export.mjs`,
      `third-party.mjs` (the `lint` job's checks of §13)

## 2. v0.1 — the newcomer story

- [x] JDK detect (mise, sdkman, env, well-known) merged with `java.configuration.runtimes` — `src/jdk/discover.ts`
- [x] JDK resolve (build-tool requirement → match → newest → offer install) — `src/jdk/resolve.ts`, `build/maven/pom.ts`, `build/gradle/script.ts`
- [x] JDK install by delegating to mise / sdkman — `src/jdk/install.ts`, in a terminal the user reads
- [x] resource diagnostic (cgroup v2 / v1, `-Xmx` sum, one warning per session) — `src/detect/resources.ts`
- [x] server-mode gating (context keys `batlehub.java.serverMode`, `batlehub.java.standard`, mode switch offer) — `src/server/`
- [x] single status bar item → JDK quick pick — `src/statusbar.ts`
- [x] channels `BatleHub Java`, `BatleHub Java: <component>`, `log.level`, redaction in the sink — `src/log.ts`, `src/redact.ts`
- [x] trust rule: nothing runs before trust — `realIo({ trusted })`'s `exec` returns nothing; commands say why
- [x] `written.json` manifest + `Java: Remove BatleHub settings` — `src/written.ts`, `src/manifest.ts`
- [x] v0.1 writes `java.configuration.runtimes` and, for the newcomer, `java.jdt.ls.java.home` (see feedback 4)
- [x] performance numbers printed by the heavy half — `PERF` line in the suite log
- [x] **proven in the real editor**: heavy run 7 (2026-09-17 23:10) — status bar
      1.9 s after page load; after Trust: `detection in 121 ms: 2 runtime(s)
      [JavaSE-25@mise, JavaSE-21@mise], managers [mise], folders maven wants
      21 → JavaSE-21 (matches), limit 16 GiB`; `wrote java.configuration.runtimes`;
      `wrote java.jdt.ls.java.home`; reload; `Server mode: Standard` 2.1 s
      after the reload on `JavaSE-21 (21.0.11, mise)`; the quick pick lists
      both runtimes and "Install a JDK…". Seven runs to get there; what each
      one found is in §Feedback 4–7.

## 3. v0.2 — the surface

- [x] Java panel — **proven in the editor** (run 15, `PANEL-OK`: tabs JDK, Build,
      Run, Profiles, Groovy; roles tablist/tab/tabpanel; ArrowRight moves the
      selection; screenshots in Dark Modern, Light Modern and Dark High
      Contrast under `tests/heavy/work/<run>/shots/`): `src/panel/panel.ts`,
      `media/panel/main.ts` (ARIA tabs pattern, roving tabindex, arrows/Home/End),
      `media/panel/panel.css` (`--vscode-*` tokens only); detection origin,
      Detect, Clear override; every write goes to `settings.json`
- [x] rename keybinding `Shift+F6` → the editor's own rename (JDT.LS behind it);
      the preview is the editor's `Ctrl+Enter` — no threshold setting (feedback 9)
- [x] grouped Generate submenu over Red Hat's generators (`src/generate/menu.ts`),
      the phase 6 delegate tried first when `core.bundle.available`
- [x] Run/Debug gutter: **reuse** — `vscode-java-debug` and `vscode-java-test`
      contribute their own lenses; absent, the panel's Run tab says so
- [x] IDEA-style context menu: Generate / Refactor / Go to submenus, `Ctrl+U`, `Ctrl+H`
- [x] `batlehub-java` task provider (`src/build/tasks.ts`): lifecycle + extras,
      `ProcessExecution` argument arrays, resolved JDK in `JAVA_HOME`/`PATH`,
      active configuration `-s`/`-t`, active profiles `-P`; `$batlehub-maven`
      problem matcher; untrusted → a task that only says why
- [x] coexistence prompt (`src/coexistence.ts`): what the stock extensions'
      settings can actually quiet (feedback 10)
- [x] `Report a problem` (`src/report/`): a 60-line zip writer, redaction +
      anonymisation, the issue form `.github/ISSUE_TEMPLATE/java-problem.yml`
- [x] shared-file locks (`src/lock.ts`): `<file>.batlehub.lock`, exclusive create, stale after 30 s
- [x] `l10n`: every runtime string through `vscode.l10n.t`, `en` catalogue generated
      by `scripts/l10n-export.mjs`, checked by `scripts/check-l10n.mjs` (103 strings)
- [x] performance gate in `view.sh` (`PERF-GATE`), thresholds from the measured
      numbers (feedback 17); `HEAVY_PERF_FACTOR` widens them on a slower runner
- [x] nightly compatibility matrix: `.github/workflows/nightly.yaml` (VS Code
      1.136.1 × 1.96.4, redhat.java 1.56.0 × 1.55.0 × pre-release, one drift issue
      per pair); the che-code row waits for an image tarball (RFC 0023)

## 4. v0.3

- [x] project explorer (`src/project/explorer.ts`): folder → JDK → modules →
      sources / tests / resources / dependencies (conflicts, verdicts) —
      `EXPLORER-OK` in the editor; the `batlehub-java` tasks in the editor's
      own picker and `maven compile` run to `BUILD SUCCESS` in the terminal
      with the resolved JDK and the mise Maven — `TASKS-OK` (run 19)
- [x] run-configuration editor + templates (`src/run/editor.ts`, `configs.ts`):
      Application / Remote templates, copy, delete, run, debug; comments and
      unknown keys of `launch.json` survive (jsonc-parser edits, one dependency,
      bundled from its ESM build — feedback 6)
- [x] IntelliJ run-configuration import (`src/idea/import.ts`) behind
      `experimental.intellijImport`: Application, Remote, class-scoped JUnit;
      the plan shown first; skipped entries reported; `.idea/` untouched

## 5. v0.4 — Maven

- [x] named configurations detected from `~/.m2/settings*.xml`; switching writes
      `java.configuration.maven.userSettings` (workspace, manifest) + re-import
- [x] profiles: `-P` on goals; the LS import through m2e's prefs
      (`src/build/maven/m2e.ts`, one `.settings/org.eclipse.m2e.core.prefs` per
      module, each an owned file in the manifest); the overlay fallback
      (`overlay.ts`: `<profiles>`, `<activeProfiles>`, `<mirrors>`, `<servers>`
      only, 0600, `.gitignore` first or refused)
- [x] lifecycle, `dependency:tree` parsed with "omitted for conflict" kept
      (`deptree.ts`), effective POM as a diff against the raw one
- [x] registry link (`src/registry/link.ts`): `ask` once per workspace, the
      `<!-- batlehub:mirror -->` / `<!-- batlehub:server -->` blocks in
      `~/.m2/settings.xml` (set·set·unset byte-identical, tested), 0600 under
      the lock, recorded as a `block` in the manifest with its remover;
      `batlehub-vsx` exports `{ token(), url() }` from `activate` — its only
      change; its 47 unit tests unchanged
- [x] verdicts on dependency nodes (`src/registry/verdicts.ts`):
      `GET /api/v1/verdicts/{registry}/{groupId:artifactId}/{version}` with the
      bearer from `batlehub-vsx`, cached, 404 = nothing shown
- [x] **the registry scenario, green against a real BatleHub** (`task
      heavy:view:registry`, 2026-09-18 06:35, release binaries + the Postgres
      sidecar): `batlehub-vsx` signed in through `BATLEHUB_TOKEN`; the core
      logged `registry link enabled → …/proxy/mvn-<run>/maven2 (token from
      batlehub-vsx)`; the run's `~/.m2/settings.xml` (0600) carried the
      mirror block and `Authorization: Bearer heavy-user-token`, the Gradle
      init script the same; a real Maven with a fresh local repository
      resolved the profile-only `commons-lang3` through the hub, whose Maven
      registry refuses anonymous reads — `_remote.repositories` names
      `batlehub` as the serving repository. Two findings on the way (feedback
      20, 21): Bearer not Basic, and the `/maven2` suffix

## 6. v0.5 — the JDT bundle (a fork's work, its notes merged here)

- [x] `jdt/batlehub-jdt-core/`: Maven `packaging: bundle` (maven-bundle-plugin /
      bnd), Java 21, `Bundle-SymbolicName: batlehub.jdt.core;singleton:=true`,
      `plugin.xml` on `org.eclipse.jdt.ls.core.delegateCommandHandler`, one
      `Handler` for `batlehub.ping`, `batlehub.generate.accessors` (the options
      of §4.1 through `ASTRewrite`, static fields too, existing accessors kept),
      `batlehub.inspections.list`, `batlehub.inspections.fixAll`
- [x] 11 inspections (`META-INF/services`), all syntactic, fixes where safe:
      `unused/privateField`, `unused/privateMethod`, `style/redundantThis`,
      `collections/sizeIsZero`, `performance/stringConcatInLoop` (no fix),
      `correctness/missingOverride`, `correctness/objectsEqualsLiteral`,
      `performance/boxingConstructor`, `correctness/emptyCatch` (no fix),
      `style/booleanLiteralComparison`, `style/ifReturnBoolean`
- [x] `.tasks/jdt.yaml` (`jdt:deps|build|test|smoke|clean`), `jdt/deps.sh`
      installs the jars the pinned redhat.java VSIX ships (`org.eclipse.jdt.ls.core`
      is not on Maven Central) into `~/.m2` as `batlehub.jdtls:*`; the jar lands at
      `extensions/java-core/jdt/batlehub-jdt-core.jar` (gitignored, in the VSIX,
      `contributes.javaExtensions`)
- [x] layer 1b: 19 JUnit 5 tests — golden files per accessor option set,
      positive / negative / fix per inspection (`task jdt:test`)
- [x] TS side: `src/inspections/rules.ts` (pure: overrides, grouping, the
      ping/restart decision), `bridge.ts` (ping after `serverReady` in Standard
      → `core.bundle`, `DiagnosticCollection("batlehub")` with `source: batlehub`,
      `code: <area>/<ruleId>`, severity overrides client-side, fix-all as one
      WorkspaceEdit, one restart offer per session), `view.ts` (Inspections tree:
      rule → file → occurrence, inline Fix all); 3 vitest tests
- [x] **proven headless** (`task jdt:smoke`, the real JDT.LS 1.61.0 of
      redhat.java 1.56.0, JDK 21): 4 `batlehub.*` commands advertised,
      `ServiceReady` in 3 s, ping → version + 11 ids, `Greeter.java` → exactly
      the 4 expected findings (privateField @8, redundantThis @11,
      stringConcatInLoop @17, sizeIsZero @23), fixAll(sizeIsZero) → the
      `.isEmpty()` edit, accessors on `Person.java` → 16 edits
- [x] **proven in the editor** (heavy run 15, 2026-09-18 02:39): `BUNDLE-OK`
      (`bundle loaded: version 0.1.0, 11 inspection(s)` in the JDT channel),
      `INSPECTIONS-OK` (the four `batlehub` diagnostics in the Problems panel
      beside JDT's own; `Fix all in file` rewrote `size() == 0` to
      `isEmpty()`), `GENERATE-OK` (`Java: Getters and setters…` wrote the
      accessors into Person.java through the delegate)

## 7. v0.6 — Gradle

- [x] provider (`src/build/gradle/provider.ts`): subprojects from
      `settings.gradle`, toolchain requirement, `tasks --all` and
      `dependencies` parsed (`tasks.ts`, with Gradle's `-> 2.0.9` conflict
      arrows and `(*)` duplicates), `init.d/batlehub.gradle` registry link
      (mirror + bearer header) as an owned file
- [x] driven with a real Gradle (2026-09-18, allowed by the user):
      `mise use gradle@8` → 8.14.5 in `mise.toml`; `gradle build` on
      `gradle-multi` green (both jars, the JUnit test); its real
      `tasks --all` and `:app:dependencies` (runtime and test classpaths)
      captured under `test/fixtures/gradle-*.txt` and parsed by
      `test/gradle-real.test.ts` (project references, `(c)` constraints,
      `(*)` repeats, task groups) — 47 vitest tests

## 8. `java-groovy` (a fork's work, its notes merged here)

- [x] `extensions/java-groovy/`: activation → `assertContract(1)` →
      `registerLanguage` / `registerStatusBarItem("groovy.server", hidden by
      default)` / `registerPanelTab("groovy")`; `vscode-languageclient` over
      stdio on the JDK the core resolved; own channel `BatleHub Java: Groovy`;
      untrusted → not started; failure → one warning, colouring stays
- [x] the server: Prominic `groovy-language-server-all.jar` (Apache-2.0), the
      prebuilt from `DontShaveTheYak.groovy-guru` 0.6.0 on Open VSX, fetched by
      `task groovy:fetch` (sha256 pinned), `server/NOTICE.md` committed, the jar
      gitignored and shipped in the VSIX (25 MB); `pnpm run package` refuses
      without it
- [x] Gradle DSL and Jenkinsfile: one language id (`groovy`) extended with
      `.gradle .gvy .gy .gsh` and `Jenkinsfile`; one server, one workspace
      classpath (feedback 11)
- [x] `tests/heavy/fixtures/groovy-project/` (Spock, Jenkinsfile, wrapper)
- [x] `tests/contract/run.sh` (`task groovy:contract`): `tsc --noEmit` against
      the current `api.d.ts` → `TYPES-OK (contract major: 1, minor: 0)`; the
      tagged-VSIX pair installs once a release exists (`SKIP` today)
- [x] **decision 7 measured** (`task groovy:smoke`, JDK 21, the fixture):
      `initialize` in 838 ms advertising hover/completion/definition/references/
      symbols/rename; hover on `greet()` → `public String greet()`; document
      symbols right; diagnostics published (unresolved Spock with an empty
      classpath — correct); completion on `new Hello().gr|` offers type names,
      not members — the 2022 build's ceiling. Usable; shipped.
- [x] in the heavy half (run 19): `GROOVY-OK` — registered through the
      contract (`registered with BatleHub Java (contract 1.0)`), the server
      started on the core's JDK 21 with `-Xmx512m`, `Hello.groovy` in Groovy
      mode, the `Groovy` panel tab present, the hover answered
      (`package com.acme class Hello` — the click landed on the class name),
      the status bar item hidden by default and shown once
      `batlehub.java.statusBar.items` toggles it

## 9. The split

Not earned: no satellite has needed its own release cadence (decision 31).
Nothing to do; recorded here so the phase is not read as forgotten.

---

## Feedback — where implementing it corrected the design

(Carried into RFC §15 — revision 4 for 1–19, revision 5 for 20–23.)

1. **Decision 8 pins a version that is not on the gallery.** `1.57.0` exists
   on `main` and on the Microsoft marketplace; Open VSX — what che-code and a
   BatleHub mirror serve — has `1.56.0` and dated pre-releases. The pin is
   `1.56.0`; the RFC's "oldest release that has every API" rule gives the same
   answer for both galleries only when checked against the gallery a Che
   editor actually installs from.
2. **Layer 2 cannot run in the workspace the RFC targets.** `@vscode/test-electron`
   needs a desktop VS Code and a display; the tools container has neither
   (no Xvfb, no GTK). The RFC's own rule — an item is done when a real client
   has been through it — is satisfied by the heavy suite in the browser
   sidecar, which is where every behaviour rule is proven here. Layer 2 is
   wired for CI and is a CI-only gate.
3. **The generators take `CodeActionParams`, not a document + position.** The
   RFC says "the argument shape they take" is what spike (b) pins; it is one
   LSP object, so the Generate menu builds it from the active editor and
   passes it as the single argument. The accessors prompt reads its
   `kind` off the same object.
4. **`extensionDependencies: ["redhat.java"]` (§4.1) defeats the newcomer
   story.** Found by the first `java` heavy run: with no `JAVA_HOME` and no
   JDK on `PATH`, `redhat.java`'s `activate` rejects ("Java 21 or more
   recent is required…"), and the editor then refuses to activate every
   extension that depends on it — `remoteexthost.log`: `Activating extension
   redhat.java failed due to an error`, and `java-core` never ran. The one
   extension whose job is to fix that situation cannot fix it from behind a
   hard dependency. The dependency is now **soft** (`getExtension` at
   activation; §4.3's hard error when absent or below `1.56.0`), and the pack
   keeps the two installed together. The distribution argument of §4.1
   ("uninstallable in a gallery that lacks the id") is real but weaker than
   an extension that is dead exactly when it is needed.
5. **The language server's own JDK is a write the RFC does not list.**
   §4.2 has the core write `java.configuration.runtimes`; that tells JDT.LS
   which JDKs *projects* use, not which JDK *it* runs on. A Che workspace
   with `mise` and no global `java` has no `JAVA_HOME`, no `java` on `PATH`,
   and `redhat.java` does not scan mise's install directory — so the server
   never starts. The core now also writes `java.jdt.ls.java.home` (workspace
   scope, through the manifest) when nothing else names a JDK ≥ 17, and the
   editor reloads. This is the whole of §2 point 1 and the RFC had only
   half of it.
6. **jsonc-parser's `main` is a UMD that cannot load in the extension host.**
   Its wrapper sees the host's AMD `define` and throws at bundle load —
   `Activating extension batlehub.java-core failed` with a stack inside
   `jsonc-parser/lib/umd/main.js`. esbuild's node platform picks `main` over
   `module`; `mainFields: ["module", "main"]` in `esbuild.mjs` bundles the
   ESM build. Found by heavy run 5; nothing in unit tests can see it.
7. **The heavy driver's output-channel reader must normalise NBSP.** The
   output editor renders U+00A0; a regex with a plain space over its lines
   never matches (`wrote java.jdt.ls.java.home` was in the log and the driver
   said it was not — run 6). The `view.mjs` of the BatleHub halves had the
   replace; `java.mjs` copied it with a plain space.
8. **The run-configuration "form" is the quick input, not a webview**
   (`media/run-editor/` of §6.1 does not exist). A multi-step quick input is
   native, themed and accessible for free; a webview form is a second UI to
   test for eight fields. Marked `ponytail:` in `src/run/editor.ts`; the
   webview comes back the day a field needs layout the quick input cannot give.
9. **The rename "preview threshold" setting does not exist.** VS Code's
   rename has its own preview (`Ctrl+Enter`); a threshold that forces it
   would need a rename provider wrapper around JDT.LS's, which is exactly the
   "nothing here is new code" §5.4 argues against. The keybinding, the menu
   entry and the mode check are the contribution.
10. **The stock Java extensions expose no setting that hides a view.**
    §4.2's coexistence prompt says "hide their redundant views and lenses
    through their own settings"; `vscode-maven`, `vscode-gradle` and
    `vscode-java-dependency` have no such setting — views are hidden by the
    user from the view's title menu. What a setting can quiet is quieted
    (`maven.showInExplorerContextMenu`, `java.dependency.syncWithFolderExplorer`,
    `gradle.showStoppedDaemons`), recorded in the manifest as `extSetting`
    entries; the panel's Build tab puts each back.
11. **One Groovy server, one classpath.** §6.3's "Gradle DSL and Jenkinsfile
    are `LanguageProvider` modes with their own classpath hints" has nowhere
    to put the hints: the Prominic server reads one `groovy.classpath` for
    the workspace. The satellite ships one language id with three file kinds.
12. **Tycho and a p2 target platform are not needed for the bundle (§6.2,
    §13).** Plain Maven + bnd over the jars the pinned redhat.java VSIX ships
    gives the same guarantee a target platform gives — the bundle compiles
    against exactly the server it is loaded into — without hours of p2
    download and without a p2 mirror to cache in CI (`~/.m2` and the VSIX
    are the caches). Cost: `org.eclipse.jdt.core` and `org.eclipse.jdt.ls.core`
    export their packages **unversioned**, so decision 26's `Import-Package`
    ranges exist only where the exporter versions them (`gson`,
    `core.runtime`); the pin is the VSIX version. And no
    `AbstractProjectsManagerBasedTest`: layer 1b is JUnit 5 over
    `ASTParser`-built units — the same `Engine` the handler runs.
13. **The first inspections are syntactic, not semantic.** §5.3 says
    "anything that needs types or the classpath runs inside the language
    server"; running there was the point, and bindings need a project and a
    classpath the tests do not have. Eleven rules work on the AST alone with
    named ceilings (a shadowed field can hide a use; `missingOverride` covers
    Object's three methods); a binding-aware rule is one flag in
    `Engine.parse`. Only the accessors delegate is in the bundle; the other
    generators stay on Red Hat's pickers, which is what those need anyway.
14. **`jdt:build` is a Java toolchain step CI must run before `package`**, or
    the VSIX ships without the jar (redhat.java then logs a missing bundle
    and the Generate menu falls back — nothing else breaks). `task check`
    builds it; the `check` job of `ci.yaml` gained the JDK, `jdt/deps.sh`
    and the Maven build before packaging.
15. **A command registered twice fails the whole activation, after most of it
    ran.** `batlehub.java.openPanel` was registered by v0.1's placeholder and
    again by the panel module; `registerCommand` throws, `activate` rejects,
    the editor marks the extension failed — but the status bar, the commands
    and the detection registered before the throw keep working, so the
    failure looked like "the panel never loads" and "java-groovy never
    registers" (a satellite's `activate()` of a failed core rejects). Found
    by heavy run 9 through the extension host log; nothing in unit tests can
    see it, and the layer 2 host test would (it asserts activation).
16. **The command palette's fuzzy ranking is not a lookup.** Typing
    `>Java: Show log` ranks `Java: Show the JDT log` first, `>Tasks: Run Task`
    ranks `Tasks: Rerun All Running Tasks` first; a driver that presses Enter
    runs the wrong command and reads the wrong channel. `runCommand` now
    clicks the row whose title matches exactly. Run 9's classpath, tasks and
    generate phases all failed on this alone.
17. **Measured performance in this workspace (run 9, VS Code 1.136.1 web,
    the browser sidecar):** activation 1 122 ms, first detection 397 ms,
    status bar 2.7 s after page load, Standard mode 2.2 s after the reload
    with JDT.LS's workspace already imported once. The gate in `view.sh`
    (`HEAVY_PERF_FACTOR` widens it on a slower runner): status bar < 10 s,
    detection < 3 s, ready < 60 s, activation < 5 s, panel first paint
    < 30 s.
18. **The heavy suite itself runs inside the container's budget.** Three
    runs were killed for memory in this 16 GiB tools container (rust-analyzer
    of the workspace's own editor holds 4.9 GB): the editor, a 2 GiB JDT.LS
    and a Groovy JVM with the JDK's default quarter-of-RAM heap on top. The
    suite now starts JDT.LS at `-Xmx1G` and every other JVM the editor spawns
    at `-XX:MaxRAMPercentage=6` through `JAVA_TOOL_OPTIONS` — §2 point 7,
    measured on the suite that tests it. The Groovy satellite caps its own:
    `-Xmx512m` in `server.ts`'s argv.
19. **A webview bundle path is only as stable as esbuild's `outbase`.** With
    two entry points esbuild wrote `dist/webview/panel/main.js`; when the
    run-editor webview was cut to one, the same config wrote
    `dist/webview/main.js` and the VSIX shipped a stale 62-byte
    `panel/main.js` beside it — the panel showed "Loading…" forever (runs
    9–10). `outbase: "media"` and `rmSync("dist")` before every build.
20. **Maven's `<server>` username/password would never have authenticated
    against BatleHub.** The hub's extractor normalises `Bearer`, NuGet's
    header, cargo's bare token and Galaxy's `Token` scheme — and no HTTP
    Basic. Revision 3's `<server>` block (a password) was a token Maven
    would have sent as Basic and BatleHub would have refused. The block now
    carries `<configuration><httpHeaders>` with `Authorization: Bearer`,
    which Maven's transport sends for that server id; the `registry` heavy
    half resolves a dependency through the hub with that file to prove it.
21. **BatleHub serves Maven under `/proxy/<name>/maven2`, not `/proxy/<name>`.**
    The first registry run's Maven hit the hub 20 times and got 404 on the
    `default` route: the mirror URL the core derived lacked `/maven2`.
    `mavenUrl()` now appends it, accepts a full registry URL as given, and a
    bare hub origin becomes `/proxy/maven/maven2`; the verdict URL parser
    accepts the suffix.
22. **The build tool needs the JDK's treatment too.** Run 17's `maven
    compile` task launched `mvn` from `PATH` and got mise's "No version is
    set for shim: mvn": in the newcomer's workspace Maven is installed by the
    manager exactly like the JDK, and a shim that fails is worse than a
    binary that is absent. Detection now resolves `MAVEN_HOME`/`GRADLE_HOME`,
    then `mise ls maven|gradle --json`, and the task provider uses that home
    before `PATH` (§4.1's "Maven configurations (…, `MAVEN_HOME`)" was the
    half of it the RFC had).
23. **`1.57.0` is not the only version that is not where the RFC says.**
   The RFC's `mise`-first default holds in this workspace (temurin 21 and 25
   installed by mise), but `mise` sets no global version, so its `java`
   shim on `PATH` *fails* rather than being absent — a `PATH` scan that
   trusts the shim gets an error, not a JDK. Detection reads
   `mise ls java --json` and never the shim.

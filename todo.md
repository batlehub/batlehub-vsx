# todo — the Java series

**State on 2026-09-18.** [RFC 0001](docs/rfc/0001-java-env.md) is
**Implemented** (revision 8): phases 0–8 landed, proven in the real editor
(`task heavy:view:java`, seventeen steps from `STATUS-OK` to `DESKTOP-OK`
plus the performance gate), and the six things revision 7 owed in code are
written (§15.7). Phase 9 is deliberately not earned.

The running log this file used to be is gone: what was found while
implementing RFC 0001 now lives in that RFC's §15, which is where a reader
will look for it. This file is the **todo** — what is not done yet.

The numbered queue below is [RFC 0001 §14 "The order of work"](docs/rfc/0001-java-env.md#the-order-of-work-revision-7),
same numbering so the two never drift. Each RFC owns its own phases; what is
written here is the first step and what blocks it.

---

## Now

- [ ] **Commit and push the revision 8 work.** It is in the working tree,
      unsigned: `git add -A && git commit -S -s -F .git/COMMIT_MSG_RFC0001`
      (the message passes `cog verify`), then the PR. `task check` is green
      and heavy run 3 is green; CI has not seen any of it.
- [ ] **Watch the first CI run for the new `DESKTOP` step.** It starts a
      second editor with `JAVA_HOME` set. On a runner the `heavy-java` job
      still moves `/usr/lib/jvm` away — that is what creates the *newcomer*,
      not a workaround for the race (§15.5), and the two steps now prove
      opposite preconditions in one job.

## The order of work

1. ~~RFC 0001 revision 7 and what it owed in code~~ — **done**, revision 8.

2. ~~RFC 0008 phase 0 — the gate, measured~~ — **done**, revision 3.
      `SMOKE-OK` on ILS-263.4702.0: the numbers are in that RFC's
      [§11 Measured](docs/rfc/0008-kotlin-satellite.md). The gate **passes**,
      so phase 1 stays the bundled server of decision 1, not the bridge. Three
      things it found that phase 1 owes: the server runs `mvn` from `PATH` and
      a `mise` workspace has no `mvn` (open question 1, answered); `-Xmx1g`
      caps the server and not its daemons, 2.8 GB for the tree (new question
      4, RFC 0003's to settle); and the VSIX would be 352 MB, which nobody has
      checked against Open VSX's limit (new question 5).
3. ~~RFC 0007 phase 1 — the switching aid itself~~ — **done**, revision 3.
      `IMPORT-TRUST-OK`, `IMPORT-PLAN-OK`, `IMPORT-OK` in the real editor:
      `Format Document` on the fixture is byte-for-byte what IDEA 2026.1.3's
      own headless formatter produced from the same `.idea/codeStyles/`.
      Two things only the real client could say, both in that RFC now: the
      experimental-flag prompt is itself a write, so the trust gate has to
      run ahead of it; and `[java].editor.detectIndentation` must be turned
      off or the indent half of the import silently does nothing.
      **Next in this RFC is phase 2** (`templates.ts`), which needs no other
      RFC.
4. ~~RFC 0012 phase 1 — chain completion~~ — **done**, revision 3.
      `CHAIN-WRITE-OK`, `CHAIN-OK`, `UNDO-OK`; `chainMs` 169 ms against a
      800 ms gate, 80 ms more than with the feature off. It was not small:
      the measurement found that JDT.LS 1.61's computer answers **only**
      chains to project reference types — never a primitive, never a JDK
      type — so the RFC's own use case 2 (`String s = ` → `g.greet()`) could
      never have passed, and the fixture gained `Config.java`/`Server.java`.
      It also labels depth ≥ 2 wrongly (`h.getConfig.getServer()`) and sorts
      every chain last. All five findings are in that RFC's §11 Measured.
- [ ] **Still owed by RFC 0012 phase 1: file the upstream issue.** Nobody
      here has filed it, and [RFC 0012](docs/rfc/0012-chain-completion.md)
      open question 1 ("upstream first?") cannot be decided until it has been
      seen: the recommendation there is to build phase 2 only if the
      measurement earns it **and** the issue has no owner by the next
      `redhat.java` pin bump. It is ready to file, below — posting it is
      outward-facing and under the maintainer's name, so it waits for them.

      **Repository:** [`eclipse-jdtls/eclipse.jdt.ls`](https://github.com/eclipse-jdtls/eclipse.jdt.ls)
      (the server `redhat.java` bundles, and the owner of
      `ChainCompletionProposalComputer`).

      **Searched 2026-09-18: nothing like it exists, so this is a new
      report.** Fourteen chain-related hits in that repository, all
      **closed** feature work from 2023–24 — #2544 *Add chain completions
      support*, #2730, #2835, #2935 *Improve chain completions*. Its four
      open issues mentioning "chain" are unrelated (Lombok fluent accessors,
      localized errors, a how-to question, a dependabot bump).
      `redhat-developer/vscode-java` has nothing open either; its #3008
      *Add support for chain completions settings* is closed. Re-check
      before filing — the search was
      `repo:eclipse-jdtls/eclipse.jdt.ls chain` over all states.

      **Where the bug most likely lives**, worth naming in the report:
      [PR #2935](https://github.com/eclipse-jdtls/eclipse.jdt.ls/pull/2935)
      (merged 2024-09-07) reworked "how the chain completions are
      transformed into `CompletionItem`s … reusing the same logic which is
      used for normal completions". That is exactly the code that builds
      `label` and `insertText`, and the final segment being right while the
      intermediate ones are not fits a path that renders the edge symbol
      with the normal-completion logic and the rest by concatenation.

      **This is not evidence that upstream is unresponsive** — it is
      evidence that nobody has asked. Four merged improvement PRs on this
      one feature in two years is an actively maintained corner. None of
      [RFC 0001 decision 1's four red flags](docs/rfc/0018-rust-syntactic-tier.md)
      is anywhere near firing on the strength of it; see
      [RFC 0018](docs/rfc/0018-rust-syntactic-tier.md) §2.2, which is parked
      for exactly this kind of moment.

      **Title:** Chain completion: `label` and `insertText` drop the `()` of
      every segment but the last

      ---

      With `java.completion.chain.enabled: true`, a chain proposal of depth
      ≥ 2 comes back with a `label` that is not valid Java and an
      `insertText` that does not compile. Only `textEdit.newText` is
      correct, so a client that honours `insertText` — which LSP permits
      when no `textEdit` is applied — inserts broken code, and *every*
      client shows the malformed label.

      **Version.** `org.eclipse.jdt.ls.core` 1.61.0.202609021834, as shipped
      in `redhat.java` 1.56.0. JDK 21 (Temurin 21.0.11), Linux x64.

      **Reproduction.** Three classes in one package:

      ```java
      public class Server { public int getPort() { return 8080; } }
      public class Config { public Server getServer() { return new Server(); } }
      public class Holder { public Config getConfig() { return new Config(); } }
      ```

      then, with the caret at `§`:

      ```java
      public class Probe {
        void m() {
          Holder h = new Holder();
          Server s = §;
        }
      }
      ```

      `textDocument/completion` with `context.triggerKind = 1` (Invoked).

      **Observed** — one chain item, with:

      ```jsonc
      {
        "label":      "h.getConfig.getServer() : Server",  // not Java
        "insertText": "h.getConfig.getServer",             // does not compile
        "textEdit":   { "newText": "h.getConfig().getServer()" },  // correct
        "kind": 2,
        "sortText": "999999979"
      }
      ```

      **Expected.** `label` and `insertText` to carry the same expression as
      `textEdit.newText`: `h.getConfig().getServer()`. The `()` is present on
      the final segment in all three, so the omission looks like the
      intermediate `ChainElement`s being rendered without their
      parentheses while the last one is rendered with them.

      **A second observation, if it is useful.** At depth 1 the label is
      correct (`config.getServer() : Server`), which is why this is easy to
      miss — a one-hop chain, the common case in a small test, looks fine.

      ---

      **Two more things measured at the same time** — worth mentioning in the
      issue or filing separately, both being *behaviour* rather than bugs, so
      they are the feature request half of open question 1:

      - the computer answers only chains to **project reference types**: from
        the same root it proposes `config.getServer()` for `Server s = ` and
        nothing at all for `int port = ` or `String host = `
        (`isPrimitiveOrBoxedPrimitive` and the excluded-types gate). IDEA's
        best-known example of the feature is exactly the refused case;
      - every chain carries `sortText` `999999979`, so chains always sort
        below every ordinary proposal, whatever their relevance.

      **Our numbers, for the issue:** on a two-module Maven fixture, ten
      invocations, median — 169 ms with chain completion on, 89 ms with it
      off, so 80 ms for the feature. That is cheap; the limits above are
      about coverage, not cost.

      **To file it** once the text is agreed:
      `gh issue create --repo eclipse-jdtls/eclipse.jdt.ls --title "…" --body-file <file>`
- [ ] **5 · [RFC 0003](docs/rfc/0003-server-run-step-kinds.md) phase 1 — the managed process.**
      `src/process/` (`managed.ts`, `budget.ts`, `sweep.ts`, `history.ts`),
      the sum in `resources.ts` and its line in the `JDK` tab,
      `processes.json` in `Report a problem`. This is the memory rule of
      §7.1 getting its mechanism, and **everything after it depends on it**.
      The server kinds stay in [RFC 0017](docs/rfc/0017-server-kinds.md), parked.
- [ ] **6 · [RFC 0010](docs/rfc/0010-spring-boot-satellite.md) + [RFC 0011](docs/rfc/0011-quarkus-satellite.md), together.**
      Their phase 1 is *one* change in the core, not three: the contract 1.1
      members the changelog schedules (`process.start`, `process.declare`,
      `registerRunStepKind`, `registerRunTemplate` with `upsertTask` and
      `extraArgs`, `manifest.writeSetting`, `writeCredential`). Blocked by 5.
      This is the contract's first minor bump — `registry.token()` goes at the
      same time (it is deprecated in 1.0 and has no satellite consumer).
- [ ] **7 · [RFC 0015](docs/rfc/0015-generate-shortcuts.md) phase 0 then 1.**
      Phase 0 is Team A's, not ours: they fill that RFC's §2.1 from
      [`docs/diary/team-a.md`](docs/diary/team-a.md) and each row is classified
      — delegate, already covered, or refused with a reason. Then
      `Builders.java` + `Withers.java`, their golden files, the two menu
      entries, `options.ts`, the Lombok step, `SHORTCUTS-OK`.
      **Blocked on a team's real list, on purpose: do not guess it.**
- [ ] **8 · [RFC 0013](docs/rfc/0013-spell-checking.md) phase 1 — cspell, nothing else.**
      Pack membership, the row in the Inspections view with its
      `not available` state through `coexistence.ts`, the team word list in
      `cspell.json`.
- [ ] **9 · [RFC 0016](docs/rfc/0016-inspections-growth.md) phase 0 then 1.**
      Phase 0 verifies, ships nothing: SonarLint from Open VSX in che-code
      *and* the web build, its `source`/`code` shape, classpath reuse, peak
      RSS on `maven-multi` and on a Team A project, the licence. Phase 1 is
      the read path and the rows.
- [ ] **10 · [RFC 0002](docs/rfc/0002-headless-engine-mcp.md) phase 0 — the live editor as an MCP server.**
      The five tool schemas in `packages/java-rules/verbs.ts` and
      `src/mcp/` over the running JDT.LS; edits applied unsaved as one undo
      step. The command-line twin is second, not first. This is the goal's
      "drivable by the developer *and* their agents" half.
- [ ] **11 · [RFC 0005](docs/rfc/0005-shared-inspection-profiles.md) and [RFC 0006](docs/rfc/0006-shared-project-config.md).**
      Both start with a pure module and a JSON schema that give completion
      before anything reads the file. 0005 phase 1 is what RFC 0007 phase 4
      waits on.
- [ ] **12 · RFC 0008's remaining phases, then [RFC 0009](docs/rfc/0009-scala-satellite.md).**
      0009 phase 0 (Metals in the heavy editor, `metals.javaHome` by hand) can
      only start after 0003. Its Coursier half is gone until BatleHub accepts
      what Coursier sends.

**Outside the order:** [RFC 0014](docs/rfc/0014-batlehub-theme.md), the colour
theme — a Product RFC, independent, built whenever someone wants to. **Done**
(revision 3): `extensions/batlehub-theme`, three variants derived from
`DESIGN.md` and held by `test/contrast.test.ts`, the nightly drift job, and
the `THEME-*` steps of the java heavy half — `ALL-OK` on 2026-09-19. One
thing left, and it is taste rather than code: **keywords are dim ink. The
screenshot is in §11 open question 1; decide whether ink+bold reads better
and record it.** Fixing the suite's `setTheme` to actually apply a
theme (it typed the name into the command palette) also means RFC 0001's
three-theme panel screenshots are three different themes for the first time.

**Parked, each with its named trigger:**
[0017](docs/rfc/0017-server-kinds.md) (a team deploys to Tomcat/Jetty/WildFly/Karaf),
[0018](docs/rfc/0018-rust-syntactic-tier.md) (decision 1's memory measurement, or
three diary entries),
[0004](docs/rfc/0004-run-config-sources.md) (behind 0003, no team asking yet).

## Found while building, owed by RFC 0001

- [ ] **`Java: Fix all inspections in file` corrupts the file.** On the
      `maven-multi` fixture it turns `this.people.add(p)` into `.add(p)` and
      `people.size() == 0` into `.isEmpty()` — the receiver of every fix that
      copies a node is dropped, and the result does not compile.
      **The bundle is not at fault**: `Engine.applyFixAll` produces the right
      text, and `task jdt:test` is green. The bug is `Engine.edits()`
      (`jdt/batlehub-jdt-core/src/main/java/batlehub/jdt/core/Engine.java`),
      which serialises an `ASTRewrite`'s edit tree into flat LSP `TextEdit`s:
      `createCopyTarget` produces a `CopySourceEdit`/`CopyTargetEdit` pair
      whose text only exists once the *tree* is applied to a document, so
      `flatten()` emits the outer `ReplaceEdit` with an empty replacement.
      Anything that goes through `batlehub.inspections.fixAll` is affected;
      `Engine.apply`, which the unit tests use, applies the tree and is fine.
      The lazy fix is to stop serialising the tree at all: apply it to a copy
      of the document in `edits()` and return one `TextEdit` over the changed
      span (trim the common prefix and suffix so it is not the whole file).
      **It has been invisible because the heavy assertion is too weak** —
      `INSPECTIONS-OK` only checks that `isEmpty()` appears somewhere, which
      broken output satisfies. Once the fix lands, assert the buffer against
      a golden the way RFC 0007's `IMPORT-OK` does.

## Standing debt — owed by no RFC, and still true

- [ ] **`runCommand` in the heavy driver fails silently on a wrong title.**
      It types the title and, when no row matches exactly, presses Enter —
      running whatever the palette ranked first. `View: Revert File` (the real
      title is `File: Revert File`) therefore never reverted anything for as
      long as it has been there, and steps 9 and 10 were leaving dirty
      buffers; nothing noticed until RFC 0007's step saved one. The titles are
      fixed. The helper still fails silently: make it throw when the typed
      title matches no row.

- [ ] **Layer 2 has never run in this workspace.** `task ext:host`
      (`@vscode/test-electron`) needs a display; there is no Xvfb and no GTK
      in the tools container. It runs in CI's `host` job and was green on a
      runner. The real-editor proof here is the heavy suite in the browser
      sidecar. Nothing to fix unless the devfile grows a display.
- [ ] **No pixel comparison of the panel.** Screenshots are taken in Dark
      Modern, Light Modern and Dark High Contrast and kept as artifacts;
      §10's `pixelmatch` gate is not wired, because a renderer-dependent gate
      needs someone to stand behind its threshold. Decide: wire it with a
      number, or delete the row from §10.
- [ ] **The nightly matrix has never run on a runner.** It is written
      (`.github/workflows/nightly.yaml`, VS Code stable × previous ×
      `redhat.java` 1.56.0 / 1.55.0 / pre-release, `17 3 * * *`) and waits for
      its schedule. Its first green run is what makes the next item real.
- [ ] **The `registry` heavy half has never run on a runner.** It needs
      Postgres and a BatleHub; it is nightly-only (`heavy-registry`). It has
      been proven *here*, against BatleHub release binaries and the sidecar.
- [ ] **Phase 9, the satellite split.** Not earned: no satellite needs its own
      release cadence, and the one contract consumer is held by
      `tests/contract`. Note that [RFC 0002](docs/rfc/0002-headless-engine-mcp.md)
      phase 1 creates `packages/java-rules`, which is half of it — when that
      lands, re-read decision 31 rather than assuming the split follows.

## Recurring

- [ ] **Bump `TESTED_REDHAT_JAVA`** (`extensions/java-core/src/server/mode.ts`)
      each time the nightly passes a newer `redhat.java`. It is *not*
      `MIN_REDHAT_JAVA`: below the minimum is a hard error, above the tested
      version is a warning that never blocks (§7.1, decision 8). They hold the
      same value today, which is exactly how they get confused.
- [ ] **Read the nightly's drift issues** before any `redhat.java` minimum
      bump; Renovate opens those as their own PRs on purpose.
- [ ] **Keep the diaries filled.** [`docs/diary/`](docs/diary/) is what pulls
      a trigger: a gap with no Appendix A row gets one added, three dated
      entries un-park an RFC. Nothing else does.
- [ ] **`task rfc:index`** after any RFC header change; `task check` runs
      `rfc:index:check` and will fail the docs build on drift.

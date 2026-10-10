# Java: settings and commands

Every key shares the `batlehub.java.*` prefix (`java.*` is `redhat.java`'s
namespace). **Environment keys are absent by default**: the value is
detected, shown in the Java panel with its origin (`detected: mise`,
`set by you`), and re-detected by `Java: Detect environment`. A key you set
is an override and wins until you clear it. Only taste keys have plain
defaults. This table is checked against `package.json` by `task lint`
(`scripts/check-settings-doc.mjs`): a key missing from either side fails.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `batlehub.java.jdk.sources` | `["mise","sdkman","env","wellKnown"]` | Where JDKs are looked for, in order. Empty: only what `java.configuration.runtimes` lists |
| `batlehub.java.jdk.installVia` | detected | `auto` (first of mise, sdkman found), `mise`, `sdkman`, `none` |
| `batlehub.java.jdk.matchProject` | `true` | Pick the runtime the build file asks for rather than the newest installed |
| `batlehub.java.generate.getterPrefix` | `get` | Generator option (JDT bundle) |
| `batlehub.java.generate.booleanPrefix` | `is` | Generator option (JDT bundle) |
| `batlehub.java.generate.fluentSetters` | `false` | Setters return `this` |
| `batlehub.java.generate.finalFields` | `keepSetters` | `keepSetters` or `skipSetters` for final fields |
| `batlehub.java.completion.chain` | `auto` | Chained-call completion: `auto` (BatleHub's chains on every completion, ranked, `int`/`String` included), `shortcut` (the server's own, on Ctrl+Space), `off` |
| `batlehub.java.completion.chainBudgetMs` | `150` | Time budget of one chain search (`auto`); `0` is the server's 3 s, below 30 is raised to 30 |
| `batlehub.java.completion.chainMaxDepth` | `3` | Longest chain proposed, every segment counted (`config.getServer().getPort()` is 3) |
| `batlehub.java.report.url` | `""` | Where `Report a problem` opens its issue; empty is the GitHub template of batlehub-vsx |
| `batlehub.java.log.level` | `info` | `error`, `warn`, `info`, `debug`, `trace` |
| `batlehub.java.statusBar.items` | `{}` | Satellite status bar items by id, shown or hidden |
| `batlehub.java.resources.warnBelow` | `2Gi` | Container memory under which the status bar warns; empty disables |
| `batlehub.java.resources.budgetMiB` | `8192` | What the declared caps of managed processes are summed against before a start: the pod's memory request, clamped to the cgroup limit |
| `batlehub.java.run.stopGraceMs` | `10000` | Grace a managed process gets after `SIGTERM` before `SIGKILL` |
| `batlehub.java.run.defaultMemoryMiB` | `512` | What a `process` step of an orchestrated run declares when it names no `memoryMiB` |
| `batlehub.java.run.showTerminals` | `true` | A terminal per `process` and `server` step, kept open after the stop; off: the debug console only |
| `batlehub.java.mcp.enabled` | `true` | The Java tools (`java_status`, `java_inspect`, `java_fix`, `java_generate`, `java_rename`) offered to agents over MCP, on the language server this editor already runs; edits arrive unsaved. See [Agents](./agents) |
| `batlehub.java.inspections.enabled` | `true` | Show the BatleHub inspections (JDT bundle) |
| `batlehub.java.inspections.severityOverrides` | `{}` | Rule id → `error`, `warning`, `info`, `hint`, `off` |
| `batlehub.java.inspections.sonar` | `auto` | `auto`: SonarLint's findings in Java files join the Inspections view as `sonar/<ruleKey>` (read, never re-emitted) and its server is counted in the resource sum; without SonarLint, one row says so. `off`: neither |
| `batlehub.java.inspections.sonar.estimatedCapMiB` | `768` | What SonarLint's language server counts as in the resource sum when `sonarlint.ls.vmargs` names no `-Xmx` (measured: about 600 MiB on a small project) |
| `batlehub.java.maven.configurations` | detected | Named configurations; absent is one per `~/.m2/settings*.xml` |
| `batlehub.java.maven.activeConfiguration` | — | The active configuration (workspace) |
| `batlehub.java.maven.activeProfiles` | — | Profiles for every goal and the language server's import (workspace) |
| `batlehub.java.registry.enabled` | `ask` | `ask`, `true`, `false`; `false` removes every trace |
| `batlehub.java.registry.url` | detected | The BatleHub registry; empty is the one `batlehub-vsx` is signed into |
| `batlehub.java.coexistence` | `{}` | Written by the core: your answer to hiding the stock extensions' views |
| `batlehub.java.experimental` | `{}` | Feature flags, e.g. `{ "intellijImport": true }` |

## Keys of other extensions the core keeps in sync

Written at **workspace** scope only, each write recorded in
`.batlehub/java/local/written.json` so [`Java: Remove BatleHub settings`](./removal)
restores it:

| Key | When |
| --- | --- |
| `java.configuration.runtimes` | every detection: every runtime found, the resolved one `default` |
| `java.jdt.ls.java.home` | when `redhat.java` has no JDK to run on (no `JAVA_HOME`, none on `PATH`) — the newest ≥ 17 found |
| `java.configuration.maven.userSettings` | switching the active Maven configuration |

## Commands

| Command | Does |
| --- | --- |
| Java: Detect environment | Re-run every detection; overrides are kept |
| Java: Pick the JDK | The runtimes found, "Install a JDK…", "Detect again" |
| Java: Install a JDK… | Delegates to mise or sdkman in a terminal; detection re-runs when it closes |
| Java: Switch the language server mode | `Standard` / `LightWeight` through `redhat.java`'s own command |
| Java: Reload the Java projects | Asks JDT.LS to re-import the first folder's build file |
| Java: Show the container's resources | The cgroup limit and what this workspace plans to run, in the log |
| Java: Remove BatleHub settings | Lists the manifest, asks, replays it backwards |
| Java: Show log | The `BatleHub Java` output channel (credentials redacted) |
| Java: Open the Java panel | The panel (the JDK quick pick until it exists) |
| Java: Dump the classpath (spike) | RFC 0001 spike (a): the classpath JDT.LS resolved, into the log |

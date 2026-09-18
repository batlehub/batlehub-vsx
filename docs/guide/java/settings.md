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
| `batlehub.java.report.url` | `""` | Where `Report a problem` opens its issue; empty is the GitHub template of batlehub-vsx |
| `batlehub.java.log.level` | `info` | `error`, `warn`, `info`, `debug`, `trace` |
| `batlehub.java.statusBar.items` | `{}` | Satellite status bar items by id, shown or hidden |
| `batlehub.java.resources.warnBelow` | `2Gi` | Container memory under which the status bar warns; empty disables |
| `batlehub.java.inspections.enabled` | `true` | Show the BatleHub inspections (JDT bundle) |
| `batlehub.java.inspections.severityOverrides` | `{}` | Rule id → `error`, `warning`, `info`, `hint`, `off` |
| `batlehub.java.maven.configurations` | detected | Named configurations; absent is one per `~/.m2/settings*.xml` |
| `batlehub.java.maven.activeConfiguration` | — | The active configuration (workspace) |
| `batlehub.java.maven.activeProfiles` | — | Profiles for every goal and the language server's import (workspace) |
| `batlehub.java.registry.enabled` | `ask` | `ask`, `true`, `false`; `false` removes every trace |
| `batlehub.java.registry.url` | detected | The BatleHub registry; empty is the one `batlehub-vsx` is signed into |
| `batlehub.java.coexistence` | `{}` | Written by the core: your answer to hiding the stock extensions' views |
| `batlehub.java.experimental` | `{}` | Feature flags, e.g. `{ "intellijImport": true }` |

## Keys of other extensions the core keeps in sync

Written at **workspace** scope only, each write recorded in
`.batlehub/java/written.json` so [`Java: Remove BatleHub settings`](./removal)
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

# Quarkus

`batlehub.java-quarkus` — in the **BatleHub Java Pack: Frameworks**, not in the
default pack — runs Quarkus dev mode the way the rest of BatleHub Java runs
anything long-lived: with the core's JDK and Maven, a declared memory cap, a
readiness probe and a real stop. It is inert in a workspace without Quarkus.
Design and measurements: [RFC 0011](../../rfc/0011-quarkus-satellite.md).

## What it detects

A Maven module importing `quarkus-bom` (platform or core, named literally or
through properties, as `quarkus create app` writes it) or using
`quarkus-maven-plugin`; a Gradle build with `id 'io.quarkus'` or an
`enforcedPlatform(…quarkus-bom…)`, its version read from `gradle.properties`.
The **BatleHub Java: Quarkus** channel says what it found:
`detected Quarkus 3.40.1 (maven, module quarkus-fixture)`.

## Dev mode

**Quarkus: Start dev mode** (or the Quarkus tab's `Start`, or
`Java: New run configuration…` → *Quarkus dev mode*) starts a `batlehub-run`
of one `quarkus-dev` step — a debug session, so the Run view's Stop works:

- `quarkus:dev` (Gradle: `quarkusDev`) with exactly what a `batlehub-java`
  task gets: the wrapper or your Maven, `-s`, `-P`, the resolved JDK in
  `JAVA_HOME` and on `PATH`; `-Ddebug=false`, so no JDWP port is open
  unless you debug;
- **1 024 MiB declared** (`batlehub.java.quarkus.devMemoryMiB`) and summed
  against the budget before it starts — see [resources](./resources.md);
- **ready** when `GET /q/health/ready` answers (the path is
  `batlehub.java.quarkus.readiness`; empty means the `Listening on:` log
  line, for a project without `quarkus-smallrye-health`);
- the port from `%dev.quarkus.http.port`, then `quarkus.http.port`, then
  8080 — or `batlehub.java.quarkus.devPort`.

A second start is refused, naming the pid and the port, with `Stop` and
`Open Dev UI`. **Quarkus: Stop dev mode** sends `q`, then `SIGTERM` to the
process group after 5 s — nothing is left holding the port. Measured on the
fixture: ready in about 30 s, peak RSS 600–780 MiB.

## Debug

**Quarkus: Debug dev mode** is the same step with `debug: true`: dev mode
opens JDWP on `localhost:5005` (`batlehub.java.quarkus.debugPort`) and the
core attaches the Java debugger as a child of the run. Breakpoints work as
in any Java session. It needs `vscjava.vscode-java-debug`; without it, or
with `debugPort: 0`, the button says why and stays disabled.

## Extensions

The Quarkus tab lists the project's `io.quarkus*` extensions. `Add…` offers
the platform's catalogue — its descriptor, from your local Maven repository
or Gradle's cache, with each extension's name; the BOM when the descriptor
is not there yet — and `Remove…` the installed ones. Either runs
`quarkus:add-extension` / `remove-extension` (Gradle: `addExtension` /
`removeExtension`) as a `batlehub-java` task with
`-DquarkusRegistryClient=false`, then reloads the Java projects.
`registry.quarkus.io` is never contacted: the descriptor comes through your
build's repositories (and so through BatleHub's registry link, when it is
on).

## application.properties

Completion and validation are Red Hat's `redhat.vscode-quarkus` and
`redhat.vscode-microprofile` — recommend them in the project's
`.vscode/extensions.json`. Their MicroProfile server needs a JDK 21 or newer
and finds none in a fresh Che workspace; when that is the case the
satellite writes **`java.home`** (workspace scope, through the manifest, so
`Java: Remove BatleHub settings` restores it) to the newest JDK ≥ 21 the
core found. `redhat.java` shows its "configuration changed, please reload"
notice once; reload, and `quarkus.http.` completes. `java.home` does not move
JDT.LS: `java.jdt.ls.java.home` wins.

Without the Red Hat pair, one warning says so, with `Install`; dev mode,
the tab and the catalogue work unchanged.

## Settings

| Setting | Default | Does |
| --- | --- | --- |
| `batlehub.java.quarkus.enabled` | `true` | Off: the satellite registers nothing |
| `batlehub.java.quarkus.devPort` | `0` | Dev mode's HTTP port; `0` reads `application.properties` |
| `batlehub.java.quarkus.debugPort` | `5005` | The JDWP port of `Debug dev mode`; `0` disables it |
| `batlehub.java.quarkus.readiness` | `/q/health/ready` | The probe's path; empty: the `Listening on:` log line |
| `batlehub.java.quarkus.devMemoryMiB` | `1024` | The cap dev mode declares |
| `batlehub.java.quarkus.bridge` | `auto` | `never`: do not write `java.home` |
| `batlehub.java.statusBar.items` | `{ "quarkus.dev": false }` | `true` shows `$(play) Quarkus :8081` while dev mode runs |

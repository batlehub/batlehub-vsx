# Kotlin

`batlehub.java-kotlin` brings JetBrains' Kotlin language server to `.kt`
files, beside the Java support: hover, completion, diagnostics, navigation,
for Gradle (Kotlin or Groovy DSL) and Maven projects, mixed Java + Kotlin
modules included. Design: [RFC 0008](../../rfc/0008-kotlin-satellite.md).

It is not in the Java pack: a workspace that has Kotlin installs it — Team
B's devfile, or a `.vscode/extensions.json` recommendation.

## The server

The extension carries no server. On the first Kotlin file of a trusted
workspace it downloads **JetBrains' current release** of `kotlin-server`
(about 350 MB, unpacked to about 1.2 GB under the extension's storage),
checks it against the sha256 JetBrains publishes beside it, and keeps that
one version. Two reasons it is not bundled:

- **A release expires** about four weeks after it ships — the server then
  refuses to start (`This build of kotlin-server has expired`). The
  extension asks for the latest release once a day, and when a server
  stops on its expiry the panel says so: **Restart** fetches the current one.
- **It runs on Java 25**, which its own JetBrains Runtime provides. Your
  project still builds on the JDK BatleHub Java resolved for the folder
  (passed to the server's Gradle or Maven import as `JAVA_HOME`).

No JetBrains account is involved: the standalone server needs none, unlike
JetBrains' own VS Code extension, which asks each developer to activate a
license.

## What to expect

- **The first diagnostic of a session is slow** — about a minute after the
  first edit, while the analyser warms up; then they follow as you type.
  Hover and completion answer within seconds from the start.
- **Maven projects need a real `mvn` on the server's `PATH`.** The server
  imports a Maven project by running `mvn` itself; in a `mise` workspace the
  `mvn` shim fails ("No version is set") and the import with it — set a
  global Maven (`mise use -g maven@3.9`). Gradle projects use their wrapper.
- **`build.gradle.kts`** opens with Kotlin colouring (redhat.java's grammar)
  and the server's Gradle import reads it, but the server answers no hover
  inside a Gradle script (measured with 263.6379.0).
- **Memory**: the server is capped at `-Xmx1G`, but with the Gradle and
  Kotlin daemons it starts the tree is about 2.8 GB; it is declared at
  2800 MiB in [the container's resources](./resources.md), beside JDT.LS.
- **Untrusted workspace**: nothing is downloaded or started until you trust
  it; trusting starts it.
- There is no Kotlin grammar of its own: a `.kt` file is coloured by the
  server once it runs.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `batlehub.java.kotlin.enabled` | `true` | `false`: no server (another Kotlin extension serves `.kt`) |
| `batlehub.java.kotlin.server.xmx` | `1G` | the server JVM's heap |
| `batlehub.java.kotlin.server.args` | `[]` | extra JVM arguments |
| `batlehub.java.kotlin.server.version` | `latest` | or a release such as `263.6379.0` |
| `batlehub.java.kotlin.server.home` | — | an unpacked `kotlin-server` directory to run instead of downloading (offline, air-gapped, a mirror's copy) |

The **Kotlin** tab of the Java panel shows the server's state, version and
place, the project's JDK and the declared memory, with **Restart** and
**Show the log** (`BatleHub Java: Kotlin`). The status bar item is off by
default (`batlehub.java.statusBar.items`: `"kotlin.server": true`).

## Beside another Kotlin extension

With `fwcd.kotlin` or `JetBrains.kotlin-server` installed too, one question
asks which server stays: turning off `fwcd.kotlin`'s writes
`kotlin.languageServer.enabled: false`, turning off BatleHub's writes
`batlehub.java.kotlin.enabled: false` — both in the workspace settings,
undone by [Remove BatleHub settings](./removal.md).

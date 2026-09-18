# BatleHub Java (`java-core`)

One core for Java in VS Code and che-code, over `redhat.java` (RFC 0001 of
this repository, `docs/rfc/0001-java-env.md`):

- **JDK**: detected from `mise`, sdkman, `JAVA_HOME` and the well-known
  directories; the runtime the build asks for is picked; a missing one is
  installed by the manager you already have. Written to
  `java.configuration.runtimes` (workspace) so the language server sees what
  the status bar says.
- **The container's memory** is a diagnostic: below `batlehub.java.resources.warnBelow`
  the status bar warns and the JDK tab says what gets killed first.
- **One status bar item**, the **Java panel** (JDK · Build · Run · Profiles),
  **run configurations** in a form over `launch.json`, an **IDEA-style
  context menu** (Generate, Refactor, Go to), goals and tasks through the
  Task API, Maven configurations and profiles, the dependency tree, the
  optional BatleHub registry link.
- **Clean removal**: `Java: Remove BatleHub settings` replays the manifest of
  every foreign write, restoring rather than deleting.

The guide is under `docs/guide/java/` of the repository. Settings share the
`batlehub.java.*` prefix; every environment key is detected unless you set it.

## Why `redhat.java` is not an `extensionDependencies` entry

RFC 0001 §4.1 made it one. Implementing phase 2 showed why it cannot be:
when `redhat.java` finds no JDK — the newcomer's case, §2 point 1 — its
`activate` rejects, and the editor then refuses to activate every extension
that declares it as a dependency. The core would fail exactly when it is
needed. So the dependency is soft (`extensions.getExtension` at activation,
the hard error of §4.3 when it is absent or too old), and the pack keeps the
two installed together.

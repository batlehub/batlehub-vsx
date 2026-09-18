# Run configurations, the menus, the panel

## Run configurations

`Java: New run configuration…` / `Edit run configurations…` (Run tab, or
the palette) is a form — name, main class picked from the workspace's
`main` methods, project, program and VM arguments, environment, working
directory, before-launch task — over `.vscode/launch.json` entries of
`type: "java"`. The stock debugger reads them unchanged; BatleHub's own
fields sit under `"batlehub": {}` inside the entry and are ignored by it.
Comments and keys the form does not know survive every edit. Templates:
Application and Remote (attach). "Copy this one" duplicates an entry.

Without `vscjava.vscode-java-debug` the editor still writes `launch.json`;
Run/Debug is greyed out and says why. Run and Debug gutter lenses on `main`
and tests are the debugger's and the test runner's own.

## Import from IntelliJ

Behind `batlehub.java.experimental.intellijImport` (the Run tab's
Experimental section): `Java: Import IntelliJ run configurations` reads
`.idea/runConfigurations/*.xml` and `workspace.xml`'s RunManager and writes
`launch.json` entries for Application, Remote and class-scoped JUnit
configurations. The plan is shown before anything is written; skipped
entries say why; nothing in `.idea/` is modified.

## The IDEA-style context menu

Right-click in a Java file: **Generate** (getters and setters, constructor,
`toString`, `equals`/`hashCode`, delegates, override — grouped, over
`redhat.java`'s own generators; the BatleHub bundle's, with the
`batlehub.java.generate.*` options, once it is loaded), **Refactor** (rename
`Shift+F6`, extract method/variable/constant/field, inline, change
signature, organize imports) and **Go to** (declaration, type, implementation,
usages, super method `Ctrl+U`, type hierarchy `Ctrl+H`, symbols). Entries
that need the full language server are disabled outside Standard mode with
the reason, and offer the switch.

## The Java panel

The `Java` activity bar container holds the **Projects** explorer and the
**Java** panel with its tabs: **JDK** (runtimes with origin, the project's
requirement, Detect, Install, the container's resources, the server mode),
**Build** (tool, goals, Maven configurations, the registry link, the stock
extensions' coexistence, satellite status bar items), **Run** (the
configurations, the experimental flags), **Profiles** (Maven profiles), and
the satellites' tabs. Everything edits the same `settings.json` keys the
Settings UI does; every environment value shows its origin (`detected: mise`,
`set by you`) with "Clear override". Keyboard: the tabs follow the ARIA tabs
pattern (arrows, Home, End).

## Report a problem

`Java: Report a problem` writes one zip locally — versions, the detection
snapshot with home paths and user names redacted, the container limits,
the `BatleHub Java` channels, the workspace-scope `java.*` and
`batlehub.java.*` settings; never tokens, never source — and opens a
prefilled GitHub issue (or `batlehub.java.report.url`) you read before
submitting. Nothing is uploaded until you do.

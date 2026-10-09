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

## Orchestrated runs

A `batlehub-run` entry of `launch.json` starts **steps in order**, each
waited on by a readiness probe, and stops what it started **in reverse**
when the last step ends, when a step fails, or when you press Stop. It is a
debug session: the Run view, the Stop button and the debug console are its
whole UI.

```jsonc
{
  "type": "batlehub-run",
  "request": "launch",
  "name": "Acceptance",
  "steps": [
    { "task": "batlehub-java: maven package" },
    { "process": ["java", "-Xmx256m", "-jar", "app/target/app.jar"], "memoryMiB": 384,
      "ready": { "http": "http://localhost:8080/health" } },
    { "launch": "Run IT" }
  ]
}
```

| Step | Starts | Ready, unless `ready` says otherwise |
| --- | --- | --- |
| `task` | a `tasks.json` label or a provided task | it exited 0 |
| `launch` | another `launch.json` entry, as a child session | it started; the last step: it exited 0 |
| `process` | an argument array — never a shell string — with the resolved JDK in `JAVA_HOME` and on `PATH`, in a terminal `step N: <command>` | alive after `intervalMs` |
| `server` | a step kind a satellite registered (none ships in the core) | the kind's own probe |
| only `ready` | nothing: it waits for something already running (a sidecar) | the probe |

Probes: `{ "port": 8080 }`, `{ "http": "…", "status": 200 }`, `{ "log":
"Started in" }` (a regex over the step's output), `{ "exit": 0 }`; each
with `timeoutMs` (60 000) and `intervalMs` (500). A `process` or `server`
step is a managed process: it declares `memoryMiB`
(`batlehub.java.run.defaultMemoryMiB`, 512, when it says nothing), which is
summed against the budget before it starts — see
[Resources](./resources.md).

`Java: New run configuration…` → *Orchestrated run (steps)* writes one with
a first `process` step; add the others in `launch.json`, where the schema
completes them. The debug console reads, for the run above:

```text
step 1 exited 0
step 2 ready (http http://localhost:8080/health in 3.1 s)
step 3 exited 0
stopping 3 (Run IT) … already done
stopping 2 (java) … stopped (term) · peak 212 MiB of 384 in 0.3 s
stopping 1 (batlehub-java: maven package) … already done
```

Not every debugger reports an exit code: the Java debugger does, js-debug
(a `node` launch) does not. A last `launch` step whose debugger says nothing
ends the run with `step 3 ended (its debugger reports no exit code)`; write
`"ready": { "exit": 0 }` on it to make the missing code a failure instead.
Nothing runs in an untrusted workspace.

## Import from IntelliJ

Behind `batlehub.java.experimental.intellijImport` (the Run tab's
Experimental section): `Java: Import from IntelliJ` reads
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

# Groovy, Gradle DSL and Jenkinsfile

`batlehub.java-groovy` is the one satellite of v1 and the first consumer of
`java-core`'s contract (RFC 0001 §6.3). It ships the Prominic Groovy
language server (`groovy-language-server-all.jar`, Apache-2.0) inside its
VSIX — nothing is downloaded at runtime — and starts it on the JDK the core
resolved, with the classpath JDT.LS reported.

## What opens as Groovy

One language id, three file kinds: `*.groovy` (and `.gvy`, `.gy`, `.gsh`),
`*.gradle` (the Gradle DSL) and `Jenkinsfile`. The same server answers all
three: hover, go to definition, references, document and workspace symbols,
rename, completion on a member being typed, diagnostics.

## How it plugs in

At activation the satellite asks the core for its API, asserts contract
major 1 (a mismatch is refused with both versions named, and the satellite
does nothing), and registers:

- a **language provider** — the core calls it with the resolved JDK, the
  workspace folder and the classpath; the server is spawned as
  `<jdk>/bin/java -jar …` (an argument array, no shell);
- a **status bar item** `groovy.server`, hidden by default; show it with
  `"batlehub.java.statusBar.items": { "groovy.server": true }` or from the
  Java panel's Build tab;
- a **panel tab** `Groovy` with the server's state, its JDK and the
  classpath count.

Commands: `Java: Restart the Groovy language server`, `Java: Show the Groovy
log` (the `BatleHub Java: Groovy` output channel).

## When it cannot run

| Condition | Behaviour |
| --- | --- |
| untrusted workspace | the server is a process: it does not start; syntax colouring stays |
| no JDK resolved by the core | one warning per session, pointing at `Java: Install a JDK…` |
| the server fails to start | one warning per session; syntax colouring stays; the log says why |

## Maintaining the server

`task groovy:fetch` puts the jar in `extensions/java-groovy/server/` from the
Open VSX extension that carries a prebuilt one, verified against the checksum
pinned in `.tasks/groovy.yaml`; `server/NOTICE.md` records origin and licence.
`task groovy:smoke` starts it on the mise JDK 21 and checks `initialize`,
hover, completion and symbols over LSP against `tests/heavy/fixtures/groovy-project`
— decision 7's condition, run for real. `task groovy:contract` is layer 5:
the satellite type-checked against the current `api.d.ts`, and, once tagged
releases exist, the last tagged VSIX of each side installed beside the
other's build.

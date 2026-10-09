# BatleHub Java: Quarkus

A satellite of [BatleHub Java](../java-core) for Quarkus projects ([RFC 0011](../../docs/rfc/0011-quarkus-satellite.md)).

- **Dev mode is a managed process**: `Run > Quarkus dev mode` (or the tab's
  `Start`) runs `quarkus:dev` with the core's JDK, Maven, settings and
  profiles, declares its memory, waits on `/q/health/ready`, and stops it —
  `q`, then `SIGTERM` to the process group — when the run is stopped.
- **Debug dev mode** attaches the Java debugger on localhost (Quarkus's
  `-Ddebug`); without it dev mode runs with no debug port open.
- **A Quarkus tab** in the Java panel: dev mode's state, pid and port, the
  Dev UI link, the installed extensions with `Add…` / `Remove…` — the
  platform's catalogue read from your local repository, the build tool
  editing the POM or the Gradle script, nothing fetched from
  `registry.quarkus.io`.
- **The MicroProfile language server** (`redhat.vscode-microprofile`) gets
  the JDK BatleHub Java resolved when it has none of its own.

It starts nothing in an untrusted workspace and never kills a process it did
not start.

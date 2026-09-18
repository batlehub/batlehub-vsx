# JDKs

## Detection

`batlehub.java.jdk.sources` is the order (default `mise`, `sdkman`, `env`,
`wellKnown`):

| Source | What is read |
| --- | --- |
| `mise` | `mise ls java --json`, every installed version |
| `sdkman` | `$SDKMAN_DIR/candidates/java/*` (default `~/.sdkman`) |
| `env` | `JAVA_HOME`, `JDK_HOME` |
| `wellKnown` | `~/.jdks`, `/usr/lib/jvm`, `/opt/java`, `/usr/java`, `/usr/local/java`, macOS's `/Library/Java/JavaVirtualMachines`, Windows' `Program Files` |

Each candidate is a JDK when it has a `release` file; its version and vendor
come from there. What `java.configuration.runtimes` already lists is merged
in. Detection runs at activation, on `Java: Detect environment`, and when a
setting changes; in an untrusted workspace the sources that run a command
(`mise`) are skipped and the rest still read.

## Resolution

For each workspace folder: the build's requirement
(`maven.compiler.release` / `target` / `source`, the compiler plugin's
`<release>`, Gradle's `toolchain { languageVersion }`,
`sourceCompatibility`, `options.release`) → the installed runtime that
matches (the exact major, else the lowest in range) → otherwise the newest
installed, with a `⚠ JDK 17 (project wants 21)` in the status bar → otherwise
none, and an offer to install.

The result is written to `java.configuration.runtimes` at workspace scope so
`redhat.java` sees what the status bar says; `batlehub.java.jdk.matchProject:
false` always takes the newest.

## The language server's own JDK

`redhat.java` needs a JDK ≥ 17 to run JDT.LS and finds it through
`java.jdt.ls.java.home`, `JDK_HOME`, `JAVA_HOME` or `PATH`. A fresh Che
workspace with `mise` and no global `java` version has none of those — the
first thing a newcomer hits (RFC 0001 §2 point 1). When that is the case
the core writes `java.jdt.ls.java.home` (workspace scope, recorded in the
manifest) to the newest JDK it found; `redhat.java` asks for a reload, and
the editor works.

## Install

`Java: Install a JDK…` (also from the quick pick behind the status bar item)
asks the manager which versions it offers and runs the install in a
terminal you can read:

```sh
mise use -g java@temurin-21.0.11+10.0.LTS     # mise
sdk install java 21.0.5-tem                    # sdkman
```

`batlehub.java.jdk.installVia` picks the manager (`auto`: the first of
`mise`, `sdkman` found). The extension never downloads, extracts or
checksums a JDK itself: the JDK belongs to the manager, shows up in its own
tooling, and is detected like any other. With no manager at all the answer is
this page — install `mise` (`curl https://mise.run | sh`) or sdkman, then
`Java: Detect environment`.

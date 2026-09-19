# Maven, Gradle, the explorer and the registry link

## Goals and tasks

`Java: Run a Maven goal / Gradle task…` (also from the panel's Build tab and
the explorer's module context menu) runs the goal through the Task API as a
task of type `batlehub-java`, in an integrated terminal, with the resolved
JDK on `PATH` and in `JAVA_HOME`, the active Maven configuration's
`-s`/`-t`, and the active profiles as `-P`. The wrapper (`mvnw`, `gradlew`)
comes first, then the configuration's `mavenHome`, then the detected home
(`MAVEN_HOME` / `GRADLE_HOME`, else the newest mise install — a mise shim on
`PATH` with no global version set fails rather than being absent), and only
then the `PATH` tool; argument arrays, never a shell string.

The same tasks are writable by hand and reusable as `preLaunchTask`:

```jsonc
// .vscode/tasks.json
{ "type": "batlehub-java", "tool": "maven", "goal": "clean package", "args": ["-DskipTests"], "profiles": ["ci"] }
```

In an untrusted workspace nothing the project controls runs: not the
wrapper, not `mvn` on `PATH` — the build file is repository code
(decision 40). Detection still answers, because `mise ls maven --json` from
your home directory is a fact about the machine, not something the project
can steer.

## The explorer

The **Projects** view (activity bar, `Java`): folder → the JDK it resolved →
modules (from the POM hierarchy or `settings.gradle`) → sources, tests,
resources, dependencies. Dependencies come from `mvn dependency:tree` /
`gradle dependencies`; a version that lost a conflict says so (`lost to
2.0.9`), and with the registry link on, each node carries BatleHub's
verdict (`$(verified)` allowed, `$(warning)` warned, `$(error)` held).

## Maven configurations and profiles

A configuration is a named settings file with optional toolchains, home,
env and default profiles. Absent `batlehub.java.maven.configurations`, one
is detected per `~/.m2/settings*.xml`. Switching (Build tab, or
`Java: Maven: switch the configuration`) writes
`java.configuration.maven.userSettings` at workspace scope through the
manifest and re-imports.

Profiles (`Java: Maven: choose the active profiles`, the Profiles tab) are
stored in `batlehub.java.maven.activeProfiles`, passed as `-P` to every
goal, and — for the language server's import, which has no `-P` — written
where m2e reads them: `activeProfiles=` in each module's
`.settings/org.eclipse.m2e.core.prefs`, then a re-import. Whether JDT.LS
honours that file is RFC 0001's spike (a), measured by the heavy suite;
the fallback (`Java: Maven: apply the profiles through a settings overlay`)
copies the active settings file with `<activeProfiles>` added under
`.batlehub/java/`, 0600, after adding the `.gitignore` line — and refuses
without it, because a settings file may carry credentials.

`Java: Maven: effective POM` runs `help:effective-pom` and opens it as a
diff against the raw POM.

## Gradle

Tasks come from `gradle tasks --all`, dependency insight from
`gradle :module:dependencies --configuration runtimeClasspath`, the Java
requirement from the toolchain block. The wrapper is preferred; there is no
Gradle download by the extension.

## The BatleHub registry link

`batlehub.java.registry.enabled` is `ask` by default: on the first
Maven/Gradle project one notification proposes to route the build through
BatleHub; "Never" writes `false` to the workspace. Enabled, the core writes:

- `~/.m2/settings.xml`: a `<mirror>` and a `<server>` carrying the token as
  an `Authorization: Bearer` header (BatleHub reads no Basic scheme), inside
  `<!-- batlehub:… -->` fences it owns, file mode 0600;
- `~/.gradle/init.d/batlehub.gradle`: every repository replaced by the
  mirror, the token as a bearer header.

The registry URL is `batlehub.java.registry.url`, or the one `batlehub-vsx`
is signed into (`/proxy/maven/maven2` on its origin — BatleHub serves a Maven registry under `/proxy/<name>/maven2`); the token comes from
`batlehub-vsx`'s `token()` export — the core never opens the credential
file. Signed out or absent: the mirror is written without a token and the
status bar says so. `false` removes only the core's own blocks; so does
`Java: Remove BatleHub settings`.

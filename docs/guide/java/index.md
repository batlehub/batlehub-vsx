# Java in VS Code, the BatleHub way

`batlehub.java-core` is one extension over `redhat.java` that adds what a
developer coming from IntelliJ IDEA misses around the language: which JDK
runs, how the container's memory is spent, run configurations in a form,
an IDEA-style context menu, Maven and Gradle in one place, and — optionally —
the BatleHub registry as the build's mirror. The design is
[RFC 0001](/rfc/0001-java-env).

## Install

`batlehub.java-pack` installs the family: the core, `java-groovy`,
`redhat.java`, the Microsoft debugger and test runner, and the IntelliJ
keymap. The core alone needs only `redhat.java` (≥ 1.56.0, the version pinned
in its `package.json`).

## The first minute

1. Open a Maven or Gradle folder. The status bar gains one item, **Java**:
   `✓` ready, `⟳` importing, `⚠` something to look at, `✗` a hard error. Its
   tooltip names the JDK, the build tool, the Maven configuration and
   profiles, and the language server's mode.
2. The JDK was detected — from `mise`, sdkman, `JAVA_HOME`, the well-known
   directories — and the one the build asks for was picked
   (`maven.compiler.release`, the Gradle toolchain). No JDK? The item says
   so and `Java: Install a JDK…` delegates to the manager you have.
3. In a Che workspace, if the container's memory is below what the language
   server, a Gradle daemon and the Groovy server would need, the item turns
   `⚠` once and links [resources](./resources), which gives the devfile
   values.

Nothing is downloaded by the extension, nothing leaves the machine, and
every write outside its own settings is recorded so
[`Java: Remove BatleHub settings`](./removal) can undo it.

- [JDKs](./jdk)
- [The container's resources](./resources)
- [Settings and commands](./settings)
- [Clean removal](./removal)

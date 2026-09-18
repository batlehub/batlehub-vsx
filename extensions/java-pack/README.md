# BatleHub Java Pack

Installs, together: `batlehub.java-core` (the JDK manager, the Java panel,
run configurations, Maven, Gradle, the IDEA-style menu),
`batlehub.java-groovy` (Groovy, Gradle DSL, Jenkinsfile), `redhat.java`
(the language server), the Microsoft debugger and test runner, and the
IntelliJ keymap.

Nothing but the pack lives here. The debugger and the test runner are
`extensionPack` entries rather than hard dependencies of the core: the pack
installs them together, and a gallery that lacks one still installs the core
(RFC 0001 §4.1, decision 32).

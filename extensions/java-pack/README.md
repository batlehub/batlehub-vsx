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

## Not in the pack: the BatleHub theme

`batlehub.batlehub-theme` — BatleHub Dark, Light and High Contrast, from
BatleHub's design system (RFC 0014). It is deliberately neither installed nor
recommended here: a colour theme is a personal choice and nothing in the pack
needs it. The screenshots in these READMEs use **BatleHub Dark**. Install it
from the gallery and pick it with `Preferences: Color Theme`.

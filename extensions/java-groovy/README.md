# BatleHub Java: Groovy (`java-groovy`)

The one satellite of RFC 0001 v1, and the first consumer of `java-core`'s
contract: Groovy, the Gradle DSL (`*.gradle`) and `Jenkinsfile` open as
Groovy and are answered by the Prominic Groovy language server
(`groovy-language-server-all.jar`, Apache-2.0, shipped in the VSIX —
nothing is downloaded at runtime), started on the JDK `java-core` resolved
and given the classpath JDT.LS reported.

- Registers through `registerLanguage`, a hidden-by-default status bar item
  (`batlehub.java.statusBar.items: { "groovy.server": true }` shows it, also
  from the Java panel's Build tab) and a `Groovy` panel tab.
- Commands: `Java: Restart the Groovy language server`, `Java: Show the Groovy log`.
- Untrusted workspace: the server does not start; colouring stays.
- If the server fails to start: one warning per session, colouring stays.

`server/NOTICE.md` names the jar's origin and checksum; `task groovy:fetch`
puts it in place before packaging.

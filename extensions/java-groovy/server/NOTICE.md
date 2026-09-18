# The Groovy language server this extension ships

`groovy-language-server-all.jar` — the Prominic/GroovyLanguageServer
`groovy-language-server` (<https://github.com/GroovyLanguageServer/groovy-language-server>),
**Apache License 2.0**, a fat jar bundling Apache Groovy 4 (Apache-2.0; its
`META-INF/NOTICE`, `LICENSE` and the ANTLR / ASM licence files ship inside
the jar) and the Eclipse LSP4J runtime (EPL-2.0).

Source of the prebuilt jar: the Open VSX extension
`DontShaveTheYak.groovy-guru` 0.6.0 (Apache-2.0, `extension/bin/`), built
2022-08-28 from the Prominic sources. `task groovy:fetch` downloads that
VSIX, extracts the jar here and checks it against the pinned checksum:

```
sha256  febdd9c63380a36ff1a814fbb40b86102df6cde9692ac815328e91b8516bce05
```

The jar is not committed; the VSIX carries it (RFC 0001 §4.2: nothing is
downloaded at runtime). Building a newer server from the Prominic sources
needs Gradle and is a follow-up, not a v0.1 requirement (decision 7 accepts
the server as-is or not at all).

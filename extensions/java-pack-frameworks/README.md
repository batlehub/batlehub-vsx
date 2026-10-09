# BatleHub Java Pack: Frameworks

Installs the framework satellites of BatleHub Java:

- `batlehub.java-quarkus` — Quarkus dev mode as a managed process, the
  Quarkus tab, the extensions catalogue ([guide](https://github.com/batleforc/batlehub-vsx/blob/main/docs/guide/java/quarkus.md));
- `batlehub.java-spring` — Spring profiles beside the Maven ones, the
  instances dashboard, the run template and run step
  ([guide](https://github.com/batleforc/batlehub-vsx/blob/main/docs/guide/java/spring.md)).

Each brings the core with it and stays inert in a workspace without its
framework.

It is separate from the BatleHub Java Pack on purpose. That pack's default is
the Java language server plus one framework server (RFC 0001 §7.1); this one
is opt-in, so a framework's satellite exists only where it is wanted.

## Not in the pack: the vendors' framework extensions

`redhat.vscode-quarkus` / `redhat.vscode-microprofile` (Quarkus) and
`vmware.vscode-spring-boot` (Spring Boot Tools) give the config files their
completion, validation and hover. Each starts its own language server —
another JVM — so they are not installed for every workspace: recommend them
in the project's `.vscode/extensions.json` (or its devfile), where that JVM
earns its memory.

```jsonc
// a Quarkus project
{ "recommendations": ["redhat.vscode-quarkus", "redhat.vscode-microprofile"] }
// a Spring Boot project
{ "recommendations": ["vmware.vscode-spring-boot"] }
```

Without them everything the satellites do works unchanged; each satellite's
log says what is missing.

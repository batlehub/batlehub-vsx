# Spring Boot

`batlehub.java-spring` — in the **BatleHub Java Pack: Frameworks**, not in the
default pack — puts a Spring Boot project in the Java panel: its profiles
beside the Maven ones, the running instances, a run template and a run step.
Properties completion, bean navigation and the live hover stay
`vmware.vscode-spring-boot`'s; this satellite runs no language server.
Design and measurements: [RFC 0010](../../rfc/0010-spring-boot-satellite.md).

## What it detects

A Maven module whose parent chain reaches `spring-boot-starter-parent` —
read from disk through `relativePath`, then from `~/.m2`, nothing run — or
that imports `spring-boot-dependencies`, or depends on anything in
`org.springframework.boot`; a Gradle script applying
`org.springframework.boot`. A corporate parent not yet in `~/.m2` ends the
walk: the tab says `version unknown`, names the parent, and asks for one
build. The **BatleHub Java: Spring** channel says what it found:
`detected Spring Boot 4.1.1 (maven, module spring-boot-fixture)`.

## Profiles

The Spring tab lists the profiles declared in
`application*.{yml,yaml,properties}` — the file suffix
(`application-dev.yml`) and each document's
`spring.config.activate.on-profile` — as toggles, and the `server.port` each
sets. The Maven profiles are shown beside them, read-only: two systems, two
lists. `Pair with the Maven profiles of the same name` ticks the Spring ones
that match, once, on click. The ticked list is
`batlehub.java.spring.activeProfiles`, written through the manifest.

## Run it

**`Java: New run configuration…` → *Spring Boot application*** writes a
`java` launch: the `@SpringBootApplication` class (a file scan; several →
asked), the module, `-Dspring.profiles.active=` the ticked profiles, in the
**debug console** — in the integrated terminal, Stop ended the session and
left the JVM holding its port. A profile ticked later does not rewrite
entries already written.

**In an ordered run**, `{ "server": "spring-boot" }` is a step: the core runs
`spring-boot:run` (Gradle: `bootRun`) with the ticked profiles as a managed
process — 768 MiB declared (`batlehub.java.spring.runMemoryMiB`; measured
peak on the fixture: 454) —, ready when `/actuator/health` answers, stopped
by `SIGTERM`, which Boot answers with its graceful shutdown. See
[orchestrated runs](./run.md#orchestrated-runs).

```jsonc
{
  "type": "batlehub-run", "request": "launch", "name": "Acceptance",
  "steps": [
    { "server": "spring-boot" },
    { "task": "batlehub-java: maven verify" }
  ]
}
```

## Instances

The tab polls `http://localhost:<port>/actuator/health` on every port the
config files set (or `batlehub.java.spring.dashboard.ports`) every 5 s in a
trusted workspace, whoever started the app — a run configuration, a task,
a terminal. Each instance is a row: health, the **application context's**
uptime and its restarts, the active profiles (when `env` is exposed).

- **Uptime** needs `metrics` exposed. It is the context's: a devtools
  restart keeps the JVM, so the JVM's own uptime would never reset.
- **Open** shows the instance in the editor's simple browser.
- **Stop** is enabled only for an instance the editor started; one started
  elsewhere says so and is left alone — nothing is hunted by port.
- **Restart** POSTs `/actuator/restart` when it is exposed (Spring Cloud's —
  plain Boot 4 has none), else touches devtools'
  `spring.devtools.restart.trigger-file` when the config names one, else is
  disabled with the reason: with devtools, saving a class restarts the app
  by itself.

`batlehub.java.statusBar.items: { "spring.instances": true }` shows
`$(pulse) Spring :8081` in the status bar.

To see everything, expose what the rows read:

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,env,metrics
```

## Spring Tools' JDK

`vmware.vscode-spring-boot` starts its language server on
`spring-boot.ls.java.home`, else redhat.java's embedded JRE, else
`java.home`, `JAVA_HOME`, `PATH` — and refuses anything older than **Java
21**. A fresh Che workspace has none of those (the Open VSX `redhat.java`
carries no JRE), so the satellite writes `spring-boot.ls.java.home` — at
workspace scope, through the manifest, so `Java: Remove BatleHub settings`
restores it — to the newest JDK ≥ 21 the core found. Reload once, and
hovering `server.port` in `application.yml` shows its documentation. The
server is counted in the container's sum as an estimate, 1 536 MiB
(VMware's 1 GiB default heap plus the usual margin).

Without Spring Boot Tools, one warning says so, with `Install`; the tab, the
template, the dashboard and the run step work unchanged.

## Settings

| Setting | Default | Does |
| --- | --- | --- |
| `batlehub.java.spring.enabled` | `true` | Off: the satellite registers nothing |
| `batlehub.java.spring.activeProfiles` | `[]` | The profiles the template and the run step pass |
| `batlehub.java.spring.dashboard.ports` | `[]` | The ports polled; empty: those the config files set, else 8080 |
| `batlehub.java.spring.dashboard.pollMs` | `5000` | How often the instances are polled |
| `batlehub.java.spring.runMemoryMiB` | `768` | The cap a `spring-boot` step declares |
| `batlehub.java.spring.bridge` | `auto` | `never`: do not write `spring-boot.ls.java.home` |
| `batlehub.java.statusBar.items` | `{ "spring.instances": false }` | `true` shows the instances in the status bar |

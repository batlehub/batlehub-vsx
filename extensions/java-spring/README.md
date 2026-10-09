# BatleHub Java: Spring Boot

A satellite of [BatleHub Java](../java-core) for Spring Boot projects ([RFC 0010](../../docs/rfc/0010-spring-boot-satellite.md)).

- **Detection** from the core's project model: the parent chain (read from
  disk and `~/.m2`, nothing run), a `spring-boot-dependencies` import, an
  `org.springframework.boot` dependency, or the Gradle plugin.
- **A Spring tab** in the Java panel: the Boot version, the main class, the
  Spring profiles declared in `application*.{yml,yaml,properties}` as
  toggles beside the Maven profiles, and the port each profile sets.
- **`Spring Boot application`**, a run template: the `@SpringBootApplication`
  class, the module, `-Dspring.profiles.active` from the ticked profiles.
- **Spring Tools' language server** (`vmware.vscode-spring-boot`) gets the
  JDK BatleHub Java resolved — `spring-boot.ls.java.home`, a JDK 21 or
  newer — when it has none of its own.

Properties completion, bean navigation and the live hover stay VMware's;
this satellite runs no language server of its own.

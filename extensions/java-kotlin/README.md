# BatleHub Java: Kotlin

Kotlin and the Gradle Kotlin DSL (`build.gradle.kts`) for BatleHub Java,
through JetBrains' Kotlin language server. The server is downloaded on first
use — JetBrains' current standalone release, checked against the checksum
JetBrains publishes — and runs on the Java 25 it ships with; the project is
built on the JDK BatleHub Java resolved for the folder.

Needs `batlehub.java-core`. Guide: `docs/guide/java/kotlin.md`. Design: RFC 0008.

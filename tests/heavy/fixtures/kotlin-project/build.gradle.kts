// No toolchain block on purpose: the server brings its own JVM and the smoke
// only imports the project. The core's JDK story is RFC 0001's, not Kotlin's.
plugins {
    kotlin("jvm") version "2.4.20" apply false
}

subprojects {
    group = "com.acme"
    version = "1.0.0-SNAPSHOT"
    repositories {
        mavenCentral()
    }
}

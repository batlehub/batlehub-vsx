plugins {
    kotlin("jvm")
    application
}

dependencies {
    implementation(project(":lib"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

application {
    mainClass = "com.acme.app.Main"
}

tasks.named<Test>("test") {
    useJUnitPlatform()
}

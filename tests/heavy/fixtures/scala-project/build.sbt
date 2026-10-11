// The Scala fixture of RFC 0009 §2.1: sbt 1.x, `core` and `app`, `app`
// depending on `core` and holding Java beside Scala, one MUnit test.
ThisBuild / scalaVersion := "3.3.8"
ThisBuild / organization := "com.acme"

lazy val core = project
  .settings(libraryDependencies += "org.scalameta" %% "munit" % "1.1.1" % Test)

lazy val app = project.dependsOn(core)

lazy val root = (project in file(".")).aggregate(core, app)

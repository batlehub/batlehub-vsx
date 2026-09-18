import { describe, expect, it } from "vitest";
import {
  includedProjects,
  isJavaBuild,
  requiredJavaOf as gradleRequired,
} from "../src/build/gradle/script";
import {
  parsePom,
  requiredJavaOf,
  toolchainVersions,
} from "../src/build/maven/pom";

const POM = `<?xml version="1.0"?>
<project>
  <!-- <module>commented</module> -->
  <parent><groupId>org.acme</groupId><artifactId>parent</artifactId><version>1.0</version></parent>
  <artifactId>app</artifactId>
  <packaging>pom</packaging>
  <properties>
    <maven.compiler.release>\${java.version}</maven.compiler.release>
    <java.version>21</java.version>
  </properties>
  <modules><module>core</module><module>web</module></modules>
  <profiles>
    <profile><id>dev</id><dependencies><dependency><groupId>x</groupId></dependency></dependencies></profile>
    <profile><id>ci</id></profile>
  </profiles>
</project>`;

describe("pom reading", () => {
  it("reads coordinates through the parent, modules, profiles, properties", () => {
    const p = parsePom(POM);
    expect(p).toMatchObject({
      groupId: "org.acme",
      artifactId: "app",
      version: "1.0",
      packaging: "pom",
      modules: ["core", "web"],
      profiles: ["dev", "ci"],
      hasParent: true,
      parentRelativePath: "../pom.xml",
    });
    expect(p.properties["java.version"]).toBe("21");
  });
  it("finds the Java requirement through properties, the plugin, and 1.8", () => {
    expect(requiredJavaOf(POM)).toEqual({
      min: 21,
      origin: "maven.compiler.release",
    });
    expect(
      requiredJavaOf(
        "<project><properties><maven.compiler.target>1.8</maven.compiler.target></properties></project>",
      ),
    ).toEqual({ min: 8, origin: "maven.compiler.target" });
    expect(
      requiredJavaOf(
        "<project><build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>17</release></configuration></plugin></plugins></build></project>",
      ),
    ).toEqual({ min: 17, origin: "maven-compiler-plugin <release>" });
    expect(
      requiredJavaOf(
        "<project><properties><maven.compiler.release>${from.parent}</maven.compiler.release></properties></project>",
        { "from.parent": "11" },
      ),
    ).toEqual({ min: 11, origin: "maven.compiler.release" });
    expect(requiredJavaOf("<project/>")).toBeUndefined();
    expect(
      toolchainVersions(
        "<toolchains><toolchain><type>jdk</type><provides><version>17</version></provides></toolchain><toolchain><type>jdk</type><provides><version>1.8</version></provides></toolchain></toolchains>",
      ),
    ).toEqual([17, 8]);
  });
});

describe("gradle reading", () => {
  it("finds the toolchain, compatibility and release spellings", () => {
    expect(
      gradleRequired(
        "java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }",
      ),
    ).toEqual({ min: 21, origin: "toolchain languageVersion" });
    expect(
      gradleRequired(
        "java {\n  toolchain {\n    languageVersion.set(JavaLanguageVersion.of(17))\n  }\n}",
      ),
    ).toEqual({ min: 17, origin: "toolchain languageVersion" });
    expect(
      gradleRequired("sourceCompatibility = JavaVersion.VERSION_1_8"),
    ).toEqual({ min: 8, origin: "sourceCompatibility" });
    expect(gradleRequired("sourceCompatibility = '11'")).toEqual({
      min: 11,
      origin: "sourceCompatibility",
    });
    expect(
      gradleRequired(
        "// languageVersion = JavaLanguageVersion.of(99)\ntasks.withType(JavaCompile) { options.release = 17 }",
      ),
    ).toEqual({ min: 17, origin: "options.release" });
    expect(gradleRequired("plugins { id 'java' }")).toBeUndefined();
  });
  it("lists included projects and recognises a Java build", () => {
    expect(
      includedProjects(
        "rootProject.name = 'x'\ninclude 'app', ':lib'\ninclude(\"tools:cli\")",
      ),
    ).toEqual(["app", "lib", "tools/cli"]);
    expect(isJavaBuild("plugins { id 'java-library' }")).toBe(true);
    expect(isJavaBuild("plugins {\n  `java-library`\n}")).toBe(true);
    expect(isJavaBuild("apply plugin: 'groovy'")).toBe(true);
    expect(isJavaBuild("plugins { id 'base' }")).toBe(false);
  });
});

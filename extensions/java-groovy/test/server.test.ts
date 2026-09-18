import { describe, expect, it } from "vitest";
import {
  CONTRACT_MAJOR,
  launch,
  settingsFor,
  statusText,
  tabHtml,
} from "../src/server";

describe("the Groovy satellite's pure parts", () => {
  it("launches the jar on the core's JDK with an argument array", () => {
    expect(
      launch("/jdk/21", "/ext/server/groovy-language-server-all.jar"),
    ).toEqual({
      command: "/jdk/21/bin/java",
      args: ["-Xmx512m", "-jar", "/ext/server/groovy-language-server-all.jar"],
    });
  });
  it("maps the core's classpath onto the server's groovy.classpath setting", () => {
    expect(settingsFor(["/m2/a.jar", "/w/core/target/classes"])).toEqual({
      groovy: { classpath: ["/m2/a.jar", "/w/core/target/classes"] },
    });
    expect(settingsFor([])).toEqual({ groovy: { classpath: [] } });
  });
  it("names every state in the status bar, hidden-by-default item", () => {
    expect(statusText("running")).toEqual({
      text: "$(check) Groovy",
      tooltip: "Groovy language server: running",
    });
    expect(statusText("failed").tooltip).toContain("syntax colouring");
    expect(statusText("untrusted").text).toBe("$(circle-slash) Groovy");
  });
  it("escapes what it puts in the panel and pins contract major 1", () => {
    expect(
      tabHtml({ state: "running", jdk: "<script>", classpath: 3, jar: "x" }),
    ).toContain("&lt;script&gt;");
    expect(CONTRACT_MAJOR).toBe(1);
  });
});

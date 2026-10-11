import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensure, installed, latestVersion } from "../src/fetch";
import {
  isExpired,
  launch,
  parseSha256,
  releaseUrls,
  statusText,
  tabHtml,
  versionOfTag,
} from "../src/server";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "kotlin-"));
  dirs.push(d);
  return d;
};
afterAll(() =>
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

const INFO = {
  minRequiredJavaVersion: 25,
  launch: [
    {
      os: "Linux",
      javaExecutablePath: "jbr/bin/java",
      vmOptionsFilePath: "bin/intellij-server.vmoptions",
      bootClassPathJarNames: ["platform-loader.jar", "util.jar"],
      additionalJvmArguments: [
        "-Xbootclasspath/a:$IDE_HOME/lib/nio-fs.jar",
        "--add-opens=java.base/java.io=ALL-UNNAMED",
      ],
      mainClass: "com.intellij.ls.server.MainImpl",
    },
  ],
};

describe("the server's launch (RFC 0008 revision 5)", () => {
  it("is the server's own, from product-info.json, with our heap", () => {
    const { command, args } = launch(
      "/s",
      INFO,
      "-Xms128m\n-Xmx2048m\n-ea\n# a comment\n",
      {
        xmx: "1G",
        extra: ["-Dx=1"],
        systemPath: "/sys",
      },
    );
    expect(command).toBe("/s/jbr/bin/java");
    expect(args).toEqual([
      "-Xmx1G",
      "-ea",
      "-Xbootclasspath/a:/s/lib/nio-fs.jar",
      "--add-opens=java.base/java.io=ALL-UNNAMED",
      "-Dx=1",
      "-cp",
      "/s/lib/platform-loader.jar:/s/lib/util.jar",
      "com.intellij.ls.server.MainImpl",
      "--stdio",
      "--system-path",
      "/sys",
    ]);
  });

  it("knows JetBrains' release names, checksums and expiry", () => {
    expect(releaseUrls("263.6379.0").archive).toBe(
      "https://download.jetbrains.com/language-server/kotlin-server/263.6379.0/kotlin-server-263.6379.0.tar.gz",
    );
    expect(() => releaseUrls("../x")).toThrow();
    expect(versionOfTag("kotlin-lsp/v263.6379.0")).toBe("263.6379.0");
    expect(versionOfTag("v1")).toBeUndefined();
    expect(
      parseSha256(`${"ab".repeat(32)} *kotlin-server-263.6379.0.tar.gz\n`),
    ).toBe("ab".repeat(32));
    expect(isExpired("WARN - The EAP build has expired, exiting")).toBe(true);
    expect(isExpired("License gate: Licensed")).toBe(false);
    expect(statusText("expired").tooltip).toMatch(/Restart fetches/);
    expect(
      tabHtml({ state: "running", version: "1.2.3", classpath: 0, jdk: "<b>" }),
    ).toContain("&lt;b&gt;");
  });
});

describe("the download (RFC 0008 revision 5)", () => {
  // A release archive as JetBrains ships it: one top directory.
  const archive = () => {
    const src = tmp();
    const top = path.join(src, "kotlin-server-1.2.3");
    mkdirSync(top);
    writeFileSync(path.join(top, "product-info.json"), JSON.stringify(INFO));
    const tgz = path.join(src, "a.tar.gz");
    execFileSync("tar", ["czf", tgz, "-C", src, "kotlin-server-1.2.3"]);
    return readFileSync(tgz);
  };
  const server = (bytes: Buffer, sum: string) =>
    (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith(".sha256"))
        return new Response(`${sum} *kotlin-server-1.2.3.tar.gz`);
      if (u.endsWith(".tar.gz")) return new Response(bytes);
      if (u.includes("api.github.com"))
        return Response.json({ tag_name: "kotlin-lsp/v1.2.3" });
      return new Response("", { status: 404 });
    }) as typeof fetch;

  it("unpacks a checked release in place, and keeps one version", async () => {
    const bytes = archive();
    const sum = createHash("sha256").update(bytes).digest("hex");
    const dir = tmp();
    mkdirSync(path.join(dir, "1.0.0"));
    mkdirSync(path.join(dir, "system"));
    const steps: string[] = [];
    const home = await ensure(
      dir,
      "1.2.3",
      (m) => steps.push(m),
      server(bytes, sum),
    );
    expect(home).toBe(path.join(dir, "1.2.3"));
    expect(installed(dir, "1.2.3")).toBe(home);
    expect(existsSync(path.join(dir, "1.0.0"))).toBe(false);
    expect(existsSync(path.join(dir, "system"))).toBe(true);
    expect(steps).toEqual([
      "downloading kotlin-server 1.2.3",
      "unpacking kotlin-server 1.2.3",
    ]);
    expect(await latestVersion(server(bytes, sum))).toBe("1.2.3");
  });

  it("refuses an archive whose checksum is not JetBrains'", async () => {
    const dir = tmp();
    await expect(
      ensure(dir, "1.2.3", () => {}, server(archive(), "0".repeat(64))),
    ).rejects.toThrow(/refused/);
    expect(installed(dir, "1.2.3")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { checkContract } from "../src/api";
import {
  gate,
  MIN_REDHAT_JAVA,
  newerThanTested,
  serverJdkOf,
  serverNeedsJdk,
  TESTED_REDHAT_JAVA,
  versionAtLeast,
} from "../src/server/mode";
import { anonymise, passes, redact } from "../src/redact";

describe("server-mode gating (decision 36)", () => {
  it("enables everything in Standard and nothing else, with a reason", () => {
    expect(gate("Standard")).toEqual({
      rename: true,
      generate: true,
      inspections: true,
      workspaceCommands: true,
    });
    expect(gate("LightWeight").rename).toBe(false);
    expect(gate("LightWeight").reason).toContain("LightWeight");
    expect(gate("Hybrid").reason).toContain("starting");
    expect(gate(undefined).generate).toBe(false);
  });
  it("compares the pinned minimum", () => {
    expect(versionAtLeast("1.56.0", MIN_REDHAT_JAVA)).toBe(true);
    expect(versionAtLeast("1.57.2026091208", "1.56.0")).toBe(true);
    expect(versionAtLeast("1.55.1", "1.56.0")).toBe(false);
    expect(versionAtLeast("1.56", "1.56.0")).toBe(true);
  });
});

describe("the language server's own JDK (§4.2, revision 7)", () => {
  it("writes only when redhat.java itself found none, and never under a running server", async () => {
    let asked = 0;
    const running = (yes: boolean) => () => {
      asked++;
      return Promise.resolve(yes);
    };
    const base = {
      activationFailed: false,
      javaRequirement: {},
      running: running(false),
    };
    // The newcomer: redhat.java rejected because there is no JDK at all.
    await expect(
      serverNeedsJdk({ ...base, activationFailed: true }),
    ).resolves.toBe(true);
    // A desktop or a CI runner: /usr/lib/jvm is a JDK the core does not scan.
    // Writing there started a second JDT.LS on the same jdt_ws (§15.5).
    await expect(
      serverNeedsJdk({ ...base, running: running(true) }),
    ).resolves.toBe(false);
    await expect(serverNeedsJdk(base)).resolves.toBe(false);
    // Neither fact decided, so far — and nothing has asked the server yet:
    // `serverRunning()` settles when the server does, and awaiting it on
    // every activation cost seven seconds of it (§15.1).
    expect(asked).toBe(0);
    // Activated, resolved nothing: now "is it running" is the question.
    await expect(
      serverNeedsJdk({ ...base, javaRequirement: undefined }),
    ).resolves.toBe(true);
    await expect(
      serverNeedsJdk({
        ...base,
        javaRequirement: undefined,
        running: running(true),
      }),
    ).resolves.toBe(false);
    expect(asked).toBe(2);
  });
  it("names the JRE the server runs on, the tooling one first", () => {
    expect(
      serverJdkOf({
        tooling_jre: "/j/21",
        tooling_jre_version: 21,
        java_home: "/j/17",
        java_version: 17,
      }),
    ).toBe("Java 21 (/j/21)");
    expect(serverJdkOf({ java_home: "/j/17" })).toBe("/j/17");
    expect(serverJdkOf(undefined)).toBeUndefined();
    expect(serverJdkOf({})).toBeUndefined();
  });
  it("warns above the newest version the nightly passed, never below (§7.1)", () => {
    expect(newerThanTested(TESTED_REDHAT_JAVA)).toBe(false);
    expect(newerThanTested("1.57.2026091208")).toBe(true);
    expect(newerThanTested("1.55.0")).toBe(false);
  });
});

describe("contract major refusal (§4.3)", () => {
  it("names both versions", () => {
    expect(checkContract({ major: 1, minor: 0 }, 1)).toBeUndefined();
    expect(checkContract({ major: 1, minor: 2 }, 2)).toContain(
      "2 does not match the core's 1.2",
    );
  });
});

describe("redaction is a property of the sink", () => {
  it("removes tokens, passwords and home paths", () => {
    expect(redact("Authorization: Bearer abc.def-ghi")).toBe(
      "Authorization: Bearer <redacted>",
    );
    expect(redact("token=bh_pat_ABC123 and password: hunter2;")).toBe(
      "token=<redacted> and password=<redacted>;",
    );
    expect(
      redact("<server><id>x</id><password>s3cr3t</password></server>"),
    ).toContain("<password>&lt;redacted&gt;</password>");
    expect(
      redact(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      ),
    ).toBe("<jwt redacted>");
    expect(anonymise("/home/max/.m2 by max", "/home/max", "max")).toBe(
      "~/.m2 by <user>",
    );
  });
  it("filters by level", () => {
    expect(passes("info", "warn")).toBe(true);
    expect(passes("info", "debug")).toBe(false);
    expect(passes("trace", "trace")).toBe(true);
    expect(passes("error", "warn")).toBe(false);
  });
});

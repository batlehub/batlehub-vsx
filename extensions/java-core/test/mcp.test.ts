import { describe, expect, it } from "vitest";
import { projectRows, type Row } from "@batlehub/java-rules/rules";
import { McpSession } from "@batlehub/java-rules/protocol";
import { socketPath } from "../src/mcp/server";
import {
  checkArgs,
  parseSymbol,
  toolSchemas,
  VERBS,
} from "@batlehub/java-rules/verbs";

const row = (code: string, severity: Row["severity"] = "warning"): Row => ({
  ruleId: code.split("/")[1]!,
  area: code.split("/")[0]!,
  code,
  message: code,
  severity,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
});

describe("the tool table (RFC 0002 §4.2)", () => {
  it("is the five tools, the same on both surfaces but dryRun's default", () => {
    const live = toolSchemas("live");
    const stdio = toolSchemas("stdio");
    expect(live.map((t) => t.name)).toEqual([
      "java_status",
      "java_inspect",
      "java_fix",
      "java_generate",
      "java_rename",
    ]);
    const strip = (s: unknown) =>
      JSON.parse(
        JSON.stringify(s).replace(/"default":(true|false)/g, '"default":null'),
      );
    expect(strip(live)).toEqual(strip(stdio));
    const rename = (s: typeof live) =>
      s.find((t) => t.name === "java_rename")!.inputSchema;
    expect(rename(live).properties.dryRun!.default).toBe(false);
    expect(rename(stdio).properties.dryRun!.default).toBe(true);
    expect(rename(live).required).toEqual(["symbol", "newName"]);
  });
  it("every required argument is enforced and every unknown one refused", () => {
    for (const v of VERBS)
      for (const [k, a] of Object.entries(v.args))
        if (a.required)
          expect(() => checkArgs(v.name, {}, "live")).toThrow(
            new RegExp(`required|${k}`),
          );
    expect(() => checkArgs("java_status", { x: 1 }, "live")).toThrow(
      "unknown argument x",
    );
    expect(() =>
      checkArgs(
        "java_generate",
        { what: "toString", file: "A.java", line: 1 },
        "live",
      ),
    ).toThrow("must be one of");
    expect(() =>
      checkArgs(
        "java_generate",
        { what: "getters", file: "A.java", line: 1.5 },
        "live",
      ),
    ).toThrow("must be integer");
    expect(checkArgs("java_fix", { paths: ["core"] }, "stdio")).toEqual({
      paths: ["core"],
      dryRun: true,
    });
  });
  it("parses a symbol or a position, and refuses the rest", () => {
    expect(parseSymbol("com.acme.core.Greeter#greet")).toEqual({
      kind: "type",
      type: "com.acme.core.Greeter",
      member: "greet",
    });
    expect(parseSymbol("Greeter")).toEqual({
      kind: "type",
      type: "Greeter",
      member: undefined,
    });
    expect(parseSymbol("core/src/A.java:3:9")).toEqual({
      kind: "position",
      path: "core/src/A.java",
      line: 3,
      col: 9,
    });
    for (const bad of ["", "a..b", "a#b#c", "A.java:0:1", "1abc", "a b"])
      expect(() => parseSymbol(bad)).toThrow();
  });
});

describe("the report rule (RFC 0002 §4.1, use case 8)", () => {
  it("keeps the project's severity and marks what the developer's overrides change", () => {
    const raw = [
      row("unused/privateField"),
      row("style/redundantThis", "info"),
      row("collections/sizeIsZero"),
    ];
    const out = projectRows(raw, {
      enabled: true,
      severityOverrides: { redundantThis: "off", sizeIsZero: "warning" },
    });
    expect(out.map((r) => [r.code, r.severity, r.differsFromEditor])).toEqual([
      ["unused/privateField", "warning", undefined],
      ["style/redundantThis", "info", true],
      ["collections/sizeIsZero", "warning", undefined],
    ]);
    expect(
      projectRows(raw, { enabled: false, severityOverrides: {} }).every(
        (r) => r.differsFromEditor,
      ),
    ).toBe(true);
  });
});

describe("the MCP session", () => {
  const session = (call = async () => ({ ok: 1 })) => {
    const sent: string[] = [];
    return {
      s: new McpSession("live", "0.1.0", call, (l) => sent.push(l)),
      sent,
    };
  };
  const ask = async (s: McpSession, m: object) =>
    JSON.parse((await s.handle(JSON.stringify({ jsonrpc: "2.0", ...m })))!);

  it("initializes, lists, calls, and answers nothing to a notification", async () => {
    const { s } = session();
    const init = await ask(s, {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(init.result.protocolVersion).toBe("2025-03-26");
    expect(init.result.serverInfo.name).toBe("batlehub-java");
    expect(
      await s.handle(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      ),
    ).toBeUndefined();
    expect(
      (await ask(s, { id: 2, method: "tools/list" })).result.tools,
    ).toHaveLength(5);
    const r = await ask(s, {
      id: 3,
      method: "tools/call",
      params: { name: "java_status", arguments: {} },
    });
    expect(r.result.structuredContent).toEqual({ ok: 1 });
    expect((await ask(s, { id: 4, method: "nope" })).error.code).toBe(-32601);
  });
  it("turns a tool failure and a bad argument into isError results", async () => {
    const { s } = session(async () => {
      throw new Error("not trusted");
    });
    const r = await ask(s, {
      id: 1,
      method: "tools/call",
      params: { name: "java_status", arguments: {} },
    });
    expect(r.result).toMatchObject({
      isError: true,
      content: [{ text: "not trusted" }],
    });
    const bad = await ask(s, {
      id: 2,
      method: "tools/call",
      params: { name: "java_rename", arguments: { symbol: "A" } },
    });
    expect(bad.result.content[0].text).toMatch("newName is required");
  });
  it("frames by newline across chunks", async () => {
    const { s, sent } = session();
    const line = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" });
    s.feed(line.slice(0, 10));
    s.feed(`${line.slice(10)}\n{"jsonrpc":"2.0","id":8,"method":"ping"}\n`);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.map((l) => JSON.parse(l).id)).toEqual([7, 8]);
    expect(sent.every((l) => l.endsWith("\n"))).toBe(true);
  });
});

describe("the socket path", () => {
  it("stays under a unix socket's length limit", () => {
    expect(socketPath("/home/u/.storage/abc")).toBe(
      "/home/u/.storage/abc/mcp/java.sock",
    );
    const long = socketPath(`/${"x".repeat(120)}`);
    expect(Buffer.byteLength(long)).toBeLessThan(100);
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseLine, splitComplete } from "../src/protocol";
import { FileTail } from "../src/tail";

describe("notification protocol", () => {
  it("accepts legacy levels and safely filters JSON actions", () => {
    expect(parseLine("warn|Take care")).toEqual({
      level: "warn",
      message: "Take care",
      actions: [],
    });
    expect(
      parseLine(
        '{"level":"error","message":"broken","actions":[{"label":"Open","type":"url","url":"https://example.test"},{"type":"shell"}]}',
      ),
    ).toEqual({
      level: "error",
      message: "broken",
      actions: [{ label: "Open", type: "url", url: "https://example.test" }],
    });
  });

  it("keeps malformed JSON visible and buffers partial writes", () => {
    expect(parseLine("{not json")).toMatchObject({ level: "info", message: "{not json" });
    expect(splitComplete("one\ntwo")).toEqual({ lines: ["one"], rest: "two" });
  });
});

describe("FileTail", () => {
  it("reads appended complete lines once and recovers after truncation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "che-notify-"));
    const file = path.join(directory, "notify");
    fs.writeFileSync(file, "old\n");
    const tail = new FileTail();
    tail.start(file);
    fs.appendFileSync(file, "one\ntwo");
    expect(tail.read(file)).toEqual(["one"]);
    fs.appendFileSync(file, "\n");
    expect(tail.read(file)).toEqual(["two"]);
    fs.writeFileSync(file, "new\n");
    expect(tail.read(file)).toEqual(["new"]);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

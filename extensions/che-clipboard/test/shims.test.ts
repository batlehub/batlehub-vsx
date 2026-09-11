import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, writeShims, type Clipboard } from "../src/shims";

// The whole chain, as the terminal sees it: sh runs the shim, the shim runs
// node with client.js, the client speaks to the socket, the socket writes an
// in-memory clipboard. `execFile`, not `spawnSync`: the server lives in this
// process and a blocking spawn would starve it.
const run = (file: string, args: string[], input = "") =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const p = execFile(file, args, { encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({ code: typeof err?.code === "number" ? err.code : err ? 1 : 0, stdout, stderr }),
    );
    p.stdin!.end(input);
  });

let dir: string;
let fail = false;
const clipboard: Clipboard & { text: string } = {
  text: "",
  async readText() {
    if (fail) throw new Error("Document is not focused");
    return this.text;
  },
  async writeText(t) {
    if (fail) throw new Error("Document is not focused");
    this.text = t;
  },
};
let server: ReturnType<typeof serve>;

beforeAll(() => {
  dir = writeShims(fs.mkdtempSync(path.join(os.tmpdir(), "che-clipboard-")), process.execPath, "");
  const sock = path.join(dir, "s");
  // Rewritten with the socket path once the directory is known.
  writeShims(dir, process.execPath, sock);
  server = serve(sock, clipboard);
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const shim = (name: string) => path.join(dir, name);

describe("pbcopy / pbpaste", () => {
  it("round-trips text, utf-8 and newlines included", async () => {
    const text = "héllo\nwörld\n";
    expect(await run(shim("pbcopy"), [], text)).toMatchObject({ code: 0, stdout: "", stderr: "" });
    expect(clipboard.text).toBe(text);
    expect(await run(shim("pbpaste"), [])).toMatchObject({ code: 0, stdout: text });
  });

  it("reports a clipboard failure on stderr and exits 1", async () => {
    fail = true;
    try {
      const r = await run(shim("pbpaste"), []);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("Document is not focused");
      expect(await run(shim("pbcopy"), [], "x")).toMatchObject({ code: 1 });
    } finally {
      fail = false;
    }
  });

  it("passes the extra environment on, quoted", async () => {
    const d = writeShims(fs.mkdtempSync(path.join(os.tmpdir(), "che-env-")), process.execPath, "", {
      LD_LIBRARY_PATH: "/a b/lib:/c'd",
    });
    expect(fs.readFileSync(path.join(d, "pbcopy"), "utf8")).toContain(
      `LD_LIBRARY_PATH='/a b/lib:/c'\\''d' ELECTRON_RUN_AS_NODE='1' exec`,
    );
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("exits 1 when nothing listens", async () => {
    const dead = writeShims(
      fs.mkdtempSync(path.join(os.tmpdir(), "che-dead-")),
      process.execPath,
      path.join(dir, "nope"),
    );
    const r = await run(path.join(dead, "pbcopy"), [], "x");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^clipboard: /);
    fs.rmSync(dead, { recursive: true, force: true });
  });
});

describe("xclip", () => {
  it("writes the clipboard selection and ignores the primary one", async () => {
    clipboard.text = "";
    expect(await run(shim("xclip"), ["-selection", "clipboard"], "one")).toMatchObject({ code: 0 });
    expect(clipboard.text).toBe("one");
    expect(await run(shim("xclip"), ["-selection", "primary"], "two")).toMatchObject({ code: 0 });
    expect(clipboard.text).toBe("one");
  });

  it("reads text with -o, in either spelling", async () => {
    clipboard.text = "read me";
    expect(
      await run(shim("xclip"), ["-selection", "clipboard", "-t", "text/plain", "-o"]),
    ).toMatchObject({ code: 0, stdout: "read me" });
    expect(await run(shim("xclip"), ["-sel", "clip", "-out"])).toMatchObject({
      code: 0,
      stdout: "read me",
    });
  });

  it("lists text targets only and holds no image", async () => {
    expect(
      await run(shim("xclip"), ["-selection", "clipboard", "-t", "TARGETS", "-o"]),
    ).toMatchObject({ code: 0, stdout: "UTF8_STRING\ntext/plain\n" });
    expect(
      await run(shim("xclip"), ["-selection", "clipboard", "-t", "image/png", "-o"]),
    ).toMatchObject({ code: 1, stdout: "" });
  });
});

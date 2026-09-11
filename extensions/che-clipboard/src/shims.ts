// pbcopy, pbpaste and xclip as shell scripts on the terminal's PATH. Each one
// hands its job over a unix socket to the extension host, the only process in
// the pod that can reach the editor's clipboard. Nothing here imports vscode,
// so the whole chain (shell → node client → socket → clipboard) is tested as
// plain Node.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

/** The slice of `vscode.env.clipboard` used. */
export interface Clipboard {
  readText(): PromiseLike<string>;
  writeText(text: string): PromiseLike<void>;
}

/**
 * One request per connection: a `copy` or `paste` line, then the payload,
 * then EOF. The reply is one status byte, `0` or `1`, followed by the pasted
 * text or the error message.
 */
export function serve(sock: string, clipboard: Clipboard): net.Server {
  fs.rmSync(sock, { force: true });
  const server = net.createServer({ allowHalfOpen: true }, (c) => {
    const chunks: Buffer[] = [];
    c.on("data", (d) => chunks.push(d));
    c.on("error", () => {});
    c.on("end", async () => {
      const req = Buffer.concat(chunks).toString("utf8");
      const nl = req.indexOf("\n");
      const cmd = nl < 0 ? req : req.slice(0, nl);
      const body = nl < 0 ? "" : req.slice(nl + 1);
      try {
        if (cmd === "copy") {
          await clipboard.writeText(body);
          c.end("0");
        } else if (cmd === "paste") c.end(`0${await clipboard.readText()}`);
        else c.end(`1unknown request ${JSON.stringify(cmd)}\n`);
      } catch (e) {
        c.end(`1${e instanceof Error ? e.message : String(e)}\n`);
      }
    });
  });
  server.listen(sock);
  return server;
}

// The client the shims run with the extension host's own node, so nothing has
// to be installed in the container. Plain JS in a string on purpose: it is
// written next to the shims at activation and exercised end to end by the test.
const CLIENT_JS = `"use strict";
const net = require("node:net");
const [mode, sock] = process.argv.slice(2);
const out = [];
const c = net.connect(sock);
c.on("error", (e) => {
  process.stderr.write("clipboard: " + e.message + "\\n");
  process.exit(1);
});
c.on("data", (d) => out.push(d));
c.on("end", () => {
  const r = Buffer.concat(out);
  const ok = r[0] === 48;
  (ok ? process.stdout : process.stderr).write(r.subarray(1));
  process.exitCode = ok ? 0 : 1;
});
c.write(mode + "\\n");
if (mode === "copy") process.stdin.pipe(c);
else c.end();
`;

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * `env` is what the node needs and a terminal does not have: che-code's node
 * finds libnode through the LD_LIBRARY_PATH of the extension host alone.
 */
export function shimFiles(
  node: string,
  client: string,
  sock: string,
  env: Record<string, string> = {},
): Record<string, string> {
  // ELECTRON_RUN_AS_NODE: on a desktop editor `process.execPath` is Electron.
  const vars = Object.entries({ ...env, ELECTRON_RUN_AS_NODE: "1" })
    .map(([k, v]) => `${k}=${sq(v)}`)
    .join(" ");
  const run = (mode: string) => `${vars} exec ${sq(node)} ${sq(client)} ${mode} ${sq(sock)}`;
  return {
    "client.js": CLIENT_JS,
    pbcopy: `#!/bin/sh\n# che-clipboard: the editor's clipboard, through the extension host.\n${run("copy")}\n`,
    pbpaste: `#!/bin/sh\n# che-clipboard: the editor's clipboard, through the extension host.\n${run("paste")}\n`,
    // The subset of xclip Claude Code uses: write the clipboard and the
    // primary selection, read text, list TARGETS, read an image. Only text is
    // held, so an image read fails and TARGETS names text only.
    xclip: `#!/bin/sh
# che-clipboard: the subset of xclip Claude Code uses, on the editor's clipboard.
mode=copy sel=clipboard target=
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-out) mode=paste ;;
    -sel*) sel=$2; shift ;;
    -t|-target) target=$2; shift ;;
  esac
  shift
done
if [ "$mode" = paste ]; then
  case "$target" in
    TARGETS) printf 'UTF8_STRING\\ntext/plain\\n'; exit 0 ;;
    image/*) exit 1 ;;
  esac
elif [ "$sel" = primary ]; then
  # The same text was just written to the clipboard selection; one write is enough.
  cat >/dev/null
  exit 0
fi
${run("$mode")}
`,
  };
}

/** Write the shims into `dir` (created 0700) and return it. */
export function writeShims(
  dir: string,
  node: string,
  sock: string,
  env: Record<string, string> = {},
): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = shimFiles(node, path.join(dir, "client.js"), sock, env);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, { mode: name.endsWith(".js") ? 0o644 : 0o755 });
  }
  return dir;
}

// `node mcp-relay.js <socket>`: the stdio MCP server an agent outside the
// editor spawns (RFC 0002 decision 16). It pipes bytes to the live editor's
// socket and nothing else — no JVM, no parsing, no state.
import * as net from "node:net";

const sock = net.connect(process.argv[2] ?? "");
process.stdin.pipe(sock).pipe(process.stdout);
sock.on("error", (e) => {
  process.stderr.write(
    `batlehub-java: ${e.message} — is VS Code open on this workspace with batlehub.java.mcp.enabled?\n`,
  );
  process.exit(1);
});
sock.on("close", () => process.exit(0));

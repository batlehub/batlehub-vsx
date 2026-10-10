// The Model Context Protocol's server half, as much as five tools need:
// newline-delimited JSON-RPC 2.0 (the stdio transport's framing, which the
// relay carries byte for byte), `initialize`, `ping`, `tools/list`,
// `tools/call`. No `vscode`, no SDK: the transport is the caller's.
import { checkArgs, toolSchemas, type Surface } from "./verbs.ts";

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;

interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
}

/** One connection: feed it chunks, it calls `send` with each framed reply. */
export class McpSession {
  private buffer = "";
  // Plain fields, not parameter properties: Node runs this file by
  // stripping types, which only works for erasable syntax.
  private readonly surface: Surface;
  private readonly version: string;
  private readonly call: Call;
  private readonly send: (line: string) => void;

  constructor(
    surface: Surface,
    version: string,
    call: Call,
    send: (line: string) => void,
  ) {
    this.surface = surface;
    this.version = version;
    this.call = call;
    this.send = send;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) void this.handle(line).then((r) => r && this.send(`${r}\n`));
    }
  }

  /** One frame in, the framed reply out (undefined for a notification). */
  async handle(line: string): Promise<string | undefined> {
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      return reply(null, undefined, { code: -32700, message: "parse error" });
    }
    if (m.id === undefined) return undefined; // notifications: initialized, cancelled
    switch (m.method) {
      case "initialize": {
        const asked = m.params?.protocolVersion as string | undefined;
        return reply(m.id, {
          protocolVersion:
            asked && VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "batlehub-java", version: this.version },
        });
      }
      case "ping":
        return reply(m.id, {});
      case "tools/list":
        return reply(m.id, { tools: toolSchemas(this.surface) });
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        try {
          const out = await this.call(
            name,
            checkArgs(name, m.params?.arguments, this.surface),
          );
          return reply(m.id, {
            content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
            structuredContent: out,
          });
        } catch (e) {
          // A tool's failure is a result the agent reads, not a protocol error.
          return reply(m.id, {
            content: [{ type: "text", text: (e as Error).message }],
            isError: true,
          });
        }
      }
      default:
        return reply(m.id, undefined, {
          code: -32601,
          message: `method not found: ${m.method}`,
        });
    }
  }
}

function reply(
  id: Message["id"],
  result: unknown,
  error?: { code: number; message: string },
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    ...(error ? { error } : { result }),
  });
}

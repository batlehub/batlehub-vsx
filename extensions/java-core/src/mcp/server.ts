// The live editor as an MCP server (RFC 0002 phase 0, §5.4, decision 16):
// the five tools over the JDT.LS the editor already runs — its buffers,
// unsaved ones included, and no second JVM. An agent outside the editor
// reaches it through `dist/mcp-relay.js`, a stdio↔unix-socket pipe; the
// socket is `0600` in a `0700` directory, and no TCP port is opened.
// Edits are applied unsaved, one `applyEdit` (one undo step) per call.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { cfg, readSettings } from "../config";
import type { Core } from "../extension";
import { applyLspEdit } from "../generate/menu";
import { projectRows, type Row } from "@batlehub/java-rules/rules";
import { log } from "../log";
import { wire } from "../wire";
import { McpSession } from "@batlehub/java-rules/protocol";
import { parseSymbol } from "@batlehub/java-rules/verbs";

type LspEdit = { changes: Record<string, LspTextEdit[]> };
type LspTextEdit = {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
};

// ponytail: a directory over 2000 files is refused rather than paged; add paging when an agent needs a whole large repo.
const MAX_FILES = 2000;

/** The socket path: in the extension's storage when it fits a unix socket's ~108 bytes, else under the temp dir. */
export function socketPath(storage: string): string {
  const own = path.join(storage, "mcp", "java.sock");
  if (Buffer.byteLength(own) < 100) return own;
  const hash = crypto.createHash("sha256").update(storage).digest("hex");
  return path.join(
    os.tmpdir(),
    `batlehub-${os.userInfo().uid}`,
    `java-${hash.slice(0, 12)}.sock`,
  );
}

class Tools {
  constructor(private readonly c: Core) {}

  private root(): vscode.WorkspaceFolder {
    const f = vscode.workspace.workspaceFolders?.[0];
    if (!f) throw new Error("no workspace folder is open");
    return f;
  }

  /** A workspace-relative path, refused when it leaves the workspace. */
  private uri(p: string): vscode.Uri {
    const root = this.root().uri.fsPath;
    const abs = path.resolve(root, p);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel))
      throw new Error(`${p} is outside the workspace`);
    return vscode.Uri.file(abs);
  }

  private rel(uri: string): string {
    return path.relative(this.root().uri.fsPath, vscode.Uri.parse(uri).fsPath);
  }

  private async javaFiles(ps: string[] | undefined): Promise<vscode.Uri[]> {
    const out: vscode.Uri[] = [];
    for (const p of ps?.length ? ps : ["."]) {
      const u = this.uri(p);
      const st = await vscode.workspace.fs.stat(u);
      if (st.type & vscode.FileType.Directory)
        out.push(
          ...(await vscode.workspace.findFiles(
            new vscode.RelativePattern(u, "**/*.java"),
            "**/{target,build,bin,out,node_modules,.git}/**",
            MAX_FILES + 1,
          )),
        );
      else out.push(u);
    }
    if (out.length > MAX_FILES)
      throw new Error(
        `more than ${MAX_FILES} Java files: name a narrower path`,
      );
    return out;
  }

  /** The refusals of §6.4, as a sentence the agent can relay. */
  private gate(bundle: boolean): void {
    if (!this.c.trusted())
      throw new Error(
        "the workspace is not trusted: trust it in the editor first",
      );
    const g = this.c.server.gate();
    if (!g.workspaceCommands)
      throw new Error(
        `the Java language server is not in Standard mode — ${g.reason ?? ""}`,
      );
    if (bundle && !this.c.bundle?.available)
      throw new Error(
        "the BatleHub JDT bundle is not loaded: restart the Java language server (Java: Restart Language Server)",
      );
  }

  private exec<T>(command: string, ...args: unknown[]): Thenable<T> {
    return vscode.commands.executeCommand<T>(
      "java.execute.workspaceCommand",
      command,
      ...args,
    );
  }

  /** Apply unless dry run; what the agent is told either way. */
  private async finish(edit: LspEdit, dryRun: boolean) {
    const files = Object.keys(edit.changes).length;
    const edits = Object.values(edit.changes).reduce((n, l) => n + l.length, 0);
    const applied = !dryRun && edits > 0 && (await applyLspEdit(edit));
    if (!dryRun && edits > 0 && !applied)
      throw new Error("the editor refused the edit");
    return {
      files,
      edits,
      applied,
      ...(applied
        ? {
            note: "applied as unsaved changes: one undo reverts it; the developer saves",
          }
        : {}),
      edit: {
        changes: Object.fromEntries(
          Object.entries(edit.changes).map(([u, l]) => [this.rel(u), l]),
        ),
      },
    };
  }

  async java_status() {
    const ext = vscode.extensions.getExtension("redhat.java");
    const r = this.c.snapshot()?.folders[0]?.resolution.runtime;
    return {
      trusted: this.c.trusted(),
      jdk: r ? `${r.name} (${r.version}, ${r.source})` : null,
      server: {
        redhatJava: ext ? String(ext.packageJSON.version) : null,
        mode: this.c.server.mode ?? null,
        jdk: this.c.server.serverJdk() ?? null,
        error: this.c.server.error ?? null,
      },
      bundle: this.c.bundle?.available ?? false,
      edits: "applied unsaved, one undo step per call",
    };
  }

  async java_inspect(a: { paths?: string[] }) {
    this.gate(true);
    const editor = readSettings().inspections;
    const findings: (Row & { path: string; differsFromEditor?: true })[] = [];
    const files = await this.javaFiles(a.paths);
    for (const u of files) {
      const raw = await this.exec<Row[]>(
        "batlehub.inspections.list",
        u.toString(),
      );
      for (const r of projectRows(raw ?? [], editor))
        findings.push({ path: this.rel(u.toString()), ...r });
    }
    return { files: files.length, findings };
  }

  async java_fix(a: { paths?: string[]; rule?: string; dryRun: boolean }) {
    this.gate(true);
    const merged: LspEdit = { changes: {} };
    for (const u of await this.javaFiles(a.paths)) {
      const e = await this.exec<Partial<LspEdit> | undefined>(
        "batlehub.inspections.fixAll",
        u.toString(),
        a.rule ? a.rule.split("/").pop() : null,
      );
      for (const [k, l] of Object.entries(e?.changes ?? {}))
        if (l.length) merged.changes[k] = l;
    }
    return this.finish(merged, a.dryRun);
  }

  async java_generate(a: {
    what: "accessors" | "getters" | "setters";
    file: string;
    line: number;
    getterPrefix?: string;
    booleanPrefix?: string;
    fluentSetters?: boolean;
    dryRun: boolean;
  }) {
    this.gate(true);
    const uri = this.uri(a.file).toString();
    const at = { line: a.line - 1, character: 0 };
    const g = readSettings().generate;
    const edit = await this.exec<Partial<LspEdit> | undefined>(
      "batlehub.generate.accessors",
      {
        textDocument: { uri },
        range: { start: at, end: at },
        context: { diagnostics: [] },
      },
      JSON.stringify({
        ...g,
        ...(a.getterPrefix === undefined
          ? {}
          : { getterPrefix: a.getterPrefix }),
        ...(a.booleanPrefix === undefined
          ? {}
          : { booleanPrefix: a.booleanPrefix }),
        ...(a.fluentSetters === undefined
          ? {}
          : { fluentSetters: a.fluentSetters }),
        kind: { accessors: 0, getters: 1, setters: 2 }[a.what],
      }),
    );
    return this.finish({ changes: edit?.changes ?? {} }, a.dryRun);
  }

  async java_rename(a: { symbol: string; newName: string; dryRun: boolean }) {
    this.gate(false);
    const { uri, position } = await this.resolve(a.symbol);
    // A type rename moves its file: a disk write the tool never makes
    // (§4.2), and its WorkspaceEdit's `entries()` would silently drop the
    // move, leaving the class in a file of the old name.
    const at = findSymbol(
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      )) ?? [],
      (d) => d.selectionRange.contains(position),
    );
    if (at && TYPE_KINDS.has(at.kind))
      throw new Error(
        `${a.symbol} is a type: renaming it moves its file, which this tool never does — rename it in the editor (F2)`,
      );
    const we = await vscode.commands.executeCommand<
      vscode.WorkspaceEdit | undefined
    >("vscode.executeDocumentRenameProvider", uri, position, a.newName);
    if (!we) throw new Error(`the server cannot rename ${a.symbol}`);
    const edit: LspEdit = { changes: {} };
    for (const [u, l] of we.entries())
      edit.changes[u.toString()] = l.map((e) => ({
        range: {
          start: {
            line: e.range.start.line,
            character: e.range.start.character,
          },
          end: { line: e.range.end.line, character: e.range.end.character },
        },
        newText: e.newText,
      }));
    return this.finish(edit, a.dryRun);
  }

  /** `Type[#member]` through the server's workspace and document symbols, or a position (§4.2). */
  private async resolve(
    s: string,
  ): Promise<{ uri: vscode.Uri; position: vscode.Position }> {
    const ref = parseSymbol(s);
    if (ref.kind === "position")
      return {
        uri: this.uri(ref.path),
        position: new vscode.Position(ref.line - 1, ref.col - 1),
      };
    const simple = ref.type.split(".").pop()!;
    const found = (
      (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        simple,
      )) ?? []
    ).filter(
      (i) =>
        i.location.uri.scheme === "file" &&
        i.name === simple &&
        (i.containerName ? `${i.containerName}.${i.name}` : i.name) ===
          ref.type,
    );
    if (!found.length) throw new Error(`no type ${ref.type} in the workspace`);
    const uri = found[0]!.location.uri;
    if (!ref.member)
      return { uri, position: await this.namePosition(uri, simple) };
    const syms =
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      )) ?? [];
    const type = findSymbol(syms, (d) => d.name === simple);
    const members = (type?.children ?? []).filter(
      (d) => d.name === ref.member || d.name.startsWith(`${ref.member}(`),
    );
    if (!members.length)
      throw new Error(`no member ${ref.member} in ${ref.type}`);
    if (members.length > 1)
      throw new Error(
        `${s} is ambiguous (${members.map((m) => m.name).join(", ")}): use path:line:col`,
      );
    return { uri, position: members[0]!.selectionRange.start };
  }

  private async namePosition(
    uri: vscode.Uri,
    name: string,
  ): Promise<vscode.Position> {
    const syms =
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      )) ?? [];
    const t = findSymbol(syms, (d) => d.name === name);
    if (!t) throw new Error(`no type ${name} in ${uri.fsPath}`);
    return t.selectionRange.start;
  }
}

const TYPE_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Struct,
]);

function findSymbol(
  list: vscode.DocumentSymbol[],
  f: (d: vscode.DocumentSymbol) => boolean,
): vscode.DocumentSymbol | undefined {
  for (const d of list) {
    if (f(d)) return d;
    const inner = findSymbol(d.children ?? [], f);
    if (inner) return inner;
  }
  return undefined;
}

function listen(c: Core, sock: string, relay: string): vscode.Disposable {
  const tools = new Tools(c) as unknown as Record<
    string,
    (a: Record<string, unknown>) => Promise<unknown>
  >;
  const version = String(c.context.extension.packageJSON.version);
  fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(sock), 0o700);
  // ponytail: a second window on the same workspace takes the socket over; one window per workspace is the Che shape.
  fs.rmSync(sock, { force: true });
  const server = net.createServer((conn) => {
    conn.setEncoding("utf8");
    const session = new McpSession(
      "live",
      version,
      async (name, args) => {
        const t0 = Date.now();
        try {
          return await tools[name]!.call(tools, args);
        } finally {
          log.info(`mcp: ${name} in ${Date.now() - t0} ms`);
        }
      },
      (line) => conn.write(line),
    );
    conn.on("data", (d: string) => session.feed(d));
    conn.on("error", (e) => log.debug(`mcp connection: ${e.message}`));
  });
  server.on("error", (e) => log.warn(`mcp: ${e.message}`));
  server.listen(sock, () => {
    fs.chmodSync(sock, 0o600);
    log.info(`mcp: listening on ${sock} (relay ${relay})`);
  });
  return new vscode.Disposable(() => {
    server.close();
    fs.rmSync(sock, { force: true });
  });
}

/** The `.mcp.json` entry an agent outside the editor uses (§9: written by the developer, never by the extension). */
export function mcpConfig(relay: string, sock: string) {
  return {
    mcpServers: {
      "batlehub-java": { command: "node", args: [relay, sock] },
    },
  };
}

wire((c: Core) => {
  const storage = (c.context.storageUri ?? c.context.globalStorageUri).fsPath;
  const sock = socketPath(storage);
  const relay = path.join(c.context.extensionPath, "dist", "mcp-relay.js");
  let running: vscode.Disposable | undefined;
  const apply = () => {
    const on = cfg().get<boolean>("mcp.enabled", true);
    if (on && !running) running = listen(c, sock, relay);
    if (!on && running) {
      running.dispose();
      running = undefined;
      log.info("mcp: disabled by batlehub.java.mcp.enabled");
    }
  };
  apply();
  c.context.subscriptions.push(
    { dispose: () => running?.dispose() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("batlehub.java.mcp.enabled")) apply();
    }),
    vscode.commands.registerCommand(
      "batlehub.java.mcp.copyConfig",
      async () => {
        await vscode.env.clipboard.writeText(
          JSON.stringify(mcpConfig(relay, sock), null, 2),
        );
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            "Java: the MCP configuration is on the clipboard — paste it into your agent's .mcp.json.",
          ),
        );
      },
    ),
  );
});

# Agents (MCP)

An agent working beside the open editor — Claude Code in the workspace's
terminal, or any MCP client — can use the same Java operations the editor
has, on the language server the editor is already running. It sees the files
you have not saved, and it starts no second JVM. Design:
[RFC 0002](../../rfc/0002-headless-engine-mcp.md) phase 0.

## Connect an agent

Run **Java: Copy the MCP configuration for agents** and paste the result
into the agent's `.mcp.json`:

```json
{
  "mcpServers": {
    "batlehub-java": {
      "command": "node",
      "args": ["<extension>/dist/mcp-relay.js", "<storage>/mcp/java.sock"]
    }
  }
}
```

The relay is a pipe from the agent's stdio to a unix socket only your user
can open (`0600`). No TCP port is opened. The editor has to be open on the
workspace. The path contains the extension's version, so copy it again after
an update. BatleHub Java never writes `.mcp.json` itself.

## The tools

| Tool | What it does |
| --- | --- |
| `java_status` | The JDK, the language server and its mode, whether the BatleHub bundle is loaded |
| `java_inspect` | The BatleHub inspections of files or directories, one row per finding |
| `java_fix` | Every fix in the files, or one rule's (`rule: "collections/sizeIsZero"`), as one edit |
| `java_generate` | Getters and/or setters for the type at a line, with the prefixes and fluent setters as arguments |
| `java_rename` | A rename across every module: `com.acme.core.Greeter#greet`, or `path:line:col` |

Paths are relative to the workspace and cannot leave it.

## What an agent can and cannot do

- **Edits arrive unsaved.** A tool that edits applies one edit to the
  editor: the files turn dirty, one **Undo** takes the whole call back, and
  you save. A tool never saves and never writes to disk. `dryRun: true`
  returns the edit without applying it. **With auto save on, the editor
  saves the agent's edit like any other.** The browser build of VS Code
  saves after a delay by default (`files.autoSave: afterDelay`). Set
  `files.autoSave` to `off` if you want to review before anything reaches
  disk. Undo still takes the call back either way.
- **The workspace has to be trusted, and the server in Standard mode.**
  Otherwise the tool answers with the reason and does nothing.
- **Findings are the project's, not yours.** `java_inspect` reports at the
  bundle's severities. Your own `batlehub.java.inspections.severityOverrides`
  do not change what the agent is told: a row they change or hide is marked
  `"differsFromEditor": true`.
- Turn the whole thing off with `batlehub.java.mcp.enabled: false`.

## Without an editor

An agent with no VS Code beside it (a CI job, a routine) uses the command
line's own MCP server: the same five tools over stdio, with **`dryRun`
defaulting to `true`**. Here `dryRun: false` writes to disk, and it refuses
when a file changed since the server read it or a symlink leads out of the
workspace. It starts one Java language server for the session, with a 1 GiB
cap (`--heap` changes it), and stops it when the agent disconnects.

```json
{
  "mcpServers": {
    "batlehub-java": {
      "command": "node",
      "args": ["<batlehub-vsx>/engine/cli.ts", "mcp", "--workspace", "<project>"]
    }
  }
}
```

It needs Node 24, a JDK 21 or newer, and this repository checked out with
`pnpm install` and `task jdt:build`. `batlehub java mcp` from `batlehub-cli`
takes its place once the CLI ships it ([RFC 0002](../../rfc/0002-headless-engine-mcp.md)
phase 6). The same verbs exist as commands: `node engine/cli.ts --help`.

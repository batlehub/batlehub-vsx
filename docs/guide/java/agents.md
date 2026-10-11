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
    "batlehub-java": { "command": "batlehub-cli", "args": ["java", "mcp"] }
  }
}
```

It needs `batlehub-cli`, Node 22 or newer and a JDK 21 or newer. The same
verbs exist as commands: [the command line](./engine.md).

/** Wire AI coding agents to `ide-notify`. Pure text in, text out: no file access, no vscode. */

type Hook = { type: "command"; command: string };
type Matcher = { matcher?: string; hooks?: Hook[] };

/** Claude Code `settings.json`: add `Notification` and `Stop` hooks, keep everything else. */
export function withClaudeHooks(settings: string, cli: string): { text: string; changed: boolean } {
  const parsed: unknown = settings.trim() ? JSON.parse(settings) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("settings.json is not a JSON object");
  const root = parsed as { hooks?: Record<string, Matcher[]> };
  const hooks = (root.hooks ??= {});
  let changed = false;
  for (const event of ["Notification", "Stop"]) {
    const entries = (hooks[event] ??= []);
    if (entries.some((entry) => entry.hooks?.some((hook) => hook.command?.includes("ide-notify"))))
      continue;
    entries.push({ hooks: [{ type: "command", command: cli }] });
    changed = true;
  }
  return { text: `${JSON.stringify(root, null, 2)}\n`, changed };
}

/** Codex `config.toml`: set the top-level `notify`, unless the user already has one. */
export function withCodexNotify(config: string, cli: string): { text: string; changed: boolean } {
  const topLevel = config.split(/^\s*\[/m)[0] ?? "";
  if (/^\s*notify\s*=/m.test(topLevel)) return { text: config, changed: false };
  // Top-level keys must precede the first table, so the line goes first.
  return { text: `notify = [${JSON.stringify(cli)}]\n${config}`, changed: true };
}

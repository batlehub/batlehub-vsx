export type Level = "info" | "warn" | "error";
export type Action =
  | { label: string; type: "url"; url: string }
  | { label: string; type: "file"; path: string; line?: number }
  | { label: string; type: "command" | "shell"; command: string; args?: unknown[] }
  | { label: string; type: "copy"; text: string };

export interface Notification {
  level: Level;
  message: string;
  actions: Action[];
}

const levels = new Set<Level>(["info", "warn", "error"]);

function action(value: unknown): Action | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const label = item.label;
  if (typeof label !== "string" || !label.trim() || typeof item.type !== "string") return undefined;
  if (item.type === "url" && typeof item.url === "string")
    return { label, type: "url", url: item.url };
  if (item.type === "file" && typeof item.path === "string") {
    return {
      label,
      type: "file",
      path: item.path,
      ...(Number.isInteger(item.line) && Number(item.line) > 0 ? { line: Number(item.line) } : {}),
    };
  }
  if ((item.type === "command" || item.type === "shell") && typeof item.command === "string") {
    return {
      label,
      type: item.type,
      command: item.command,
      ...(Array.isArray(item.args) ? { args: item.args } : {}),
    };
  }
  if (item.type === "copy" && typeof item.text === "string")
    return { label, type: "copy", text: item.text };
  return undefined;
}

/** Parse one append-only `.ide-notify` line. Invalid JSON remains useful text. */
export function parseLine(line: string): Notification | undefined {
  const text = line.trim();
  if (!text) return undefined;
  const legacy = /^(info|warn|error)\|([\s\S]*)$/.exec(line);
  if (legacy) return { level: legacy[1] as Level, message: legacy[2] ?? "", actions: [] };
  if (!text.startsWith("{")) return { level: "info", message: line, actions: [] };
  try {
    const item = JSON.parse(text) as Record<string, unknown>;
    const message = typeof item.message === "string" ? item.message : "";
    const actions = Array.isArray(item.actions)
      ? item.actions.map(action).filter((a): a is Action => !!a)
      : [];
    if (!message.trim() && !actions.length) return undefined;
    return {
      level:
        typeof item.level === "string" && levels.has(item.level as Level)
          ? (item.level as Level)
          : "info",
      message,
      actions,
    };
  } catch {
    return { level: "info", message: line, actions: [] };
  }
}

/** Return complete lines only; a partial final write stays buffered for the next poll. */
export function splitComplete(input: string): { lines: string[]; rest: string } {
  const parts = input.split("\n");
  return { lines: parts.slice(0, -1), rest: parts.at(-1) ?? "" };
}

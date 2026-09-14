import { spawn } from "node:child_process";
import type { Notification } from "./protocol";

export type Forwarder =
  | {
      type: "webhook";
      url: string;
      headers?: Record<string, string>;
      levels?: Notification["level"][];
    }
  | { type: "command"; command: string; args?: string[]; levels?: Notification["level"][] };

export interface ForwardedNotification {
  version: 1;
  emittedAt: string;
  notification: Notification;
}

export function parseForwarders(value: unknown): Forwarder[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): Forwarder[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const validLevels =
      item.levels === undefined ||
      (Array.isArray(item.levels) &&
        item.levels.every((level) => level === "info" || level === "warn" || level === "error"));
    if (!validLevels) return [];
    if (item.type === "webhook" && typeof item.url === "string") {
      try {
        const url = new URL(item.url);
        if (url.protocol !== "https:" && url.protocol !== "http:") return [];
        const headers = Object.fromEntries(
          Object.entries(item.headers ?? {}).filter(
            ([name, header]) => typeof name === "string" && typeof header === "string",
          ),
        ) as Record<string, string>;
        return [
          {
            type: "webhook",
            url: url.toString(),
            ...(Object.keys(headers).length ? { headers } : {}),
            ...(item.levels ? { levels: item.levels as Notification["level"][] } : {}),
          },
        ];
      } catch {
        return [];
      }
    }
    if (
      item.type === "command" &&
      typeof item.command === "string" &&
      item.command.trim() &&
      (!item.args ||
        (Array.isArray(item.args) && item.args.every((argument) => typeof argument === "string")))
    ) {
      return [
        {
          type: "command",
          command: item.command,
          ...(item.args ? { args: item.args as string[] } : {}),
          ...(item.levels ? { levels: item.levels as Notification["level"][] } : {}),
        },
      ];
    }
    return [];
  });
}

export async function forward(
  notification: Notification,
  forwarders: Forwarder[],
  fetch_ = fetch,
): Promise<void> {
  const payload: ForwardedNotification = {
    version: 1,
    emittedAt: new Date().toISOString(),
    notification,
  };
  await Promise.all(
    forwarders
      .filter((forwarder) => !forwarder.levels || forwarder.levels.includes(notification.level))
      .map((forwarder) => send(forwarder, payload, fetch_)),
  );
}

async function send(forwarder: Forwarder, payload: ForwardedNotification, fetch_: typeof fetch) {
  if (forwarder.type === "webhook") {
    const response = await fetch_(forwarder.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...forwarder.headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`webhook ${forwarder.url} returned HTTP ${response.status}`);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    // No shell: the notification text is JSON on stdin and never becomes code.
    const child = spawn(forwarder.command, forwarder.args ?? [], {
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`command ${forwarder.command} exited ${code}: ${stderr.trim()}`)),
    );
    child.stdin.end(JSON.stringify(payload) + "\n");
  });
}

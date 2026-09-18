// One output channel per component — "BatleHub Java", "BatleHub Java: JDT",
// … — filtered by `batlehub.java.log.level` and redacted before anything is
// written (§4.2 "Logging"). `Report a problem` reads `linesOf()` back.
import * as vscode from "vscode";
import { Level, passes, redact } from "./redact";

const channels = new Map<string, vscode.OutputChannel>();
const kept = new Map<string, string[]>();
const KEEP = 2000;
let level: Level = "info";

export function setLogLevel(l: Level): void {
  level = l;
}

export function channelOf(component = ""): vscode.OutputChannel {
  const name = component ? `BatleHub Java: ${component}` : "BatleHub Java";
  let c = channels.get(name);
  if (!c) {
    c = vscode.window.createOutputChannel(name);
    channels.set(name, c);
  }
  return c;
}

function write(component: string, at: Level, message: string): void {
  if (!passes(level, at)) return;
  const line = `[${new Date().toISOString()}] [${at}] ${redact(message)}`;
  channelOf(component).appendLine(line);
  const name = component || "core";
  const lines = kept.get(name) ?? [];
  lines.push(line);
  if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
  kept.set(name, lines);
}

export const log = {
  error: (m: string, component = "") => write(component, "error", m),
  warn: (m: string, component = "") => write(component, "warn", m),
  info: (m: string, component = "") => write(component, "info", m),
  debug: (m: string, component = "") => write(component, "debug", m),
  trace: (m: string, component = "") => write(component, "trace", m),
};

/** What the channels hold, by component — already redacted. */
export function linesOf(): Record<string, string[]> {
  return Object.fromEntries(kept);
}

export function disposeLog(): void {
  for (const c of channels.values()) c.dispose();
  channels.clear();
}

// One output channel, "BatleHub", and a redaction rule: nothing that looks
// like a credential is ever written to it (RFC 0011 §4.6 — redaction is a
// property of the sink, not of each call site).
import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function channelOf(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("BatleHub");
  return channel;
}

const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const PAT = /bh_pat_[A-Za-z0-9._-]+/g;
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

export function redact(s: string): string {
  return s
    .replace(BEARER, "Bearer <redacted>")
    .replace(PAT, "bh_pat_<redacted>")
    .replace(JWT, "<jwt redacted>");
}

export function log(message: string): void {
  channelOf().appendLine(`[${new Date().toISOString()}] ${redact(message)}`);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}

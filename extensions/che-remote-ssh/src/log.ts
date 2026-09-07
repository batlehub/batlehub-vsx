// One output channel, "Che Remote SSH", and a redaction rule: nothing that
// looks like a credential is ever written to it. Redaction is a property of
// the sink, not of each call site, so a new log line cannot leak by being
// written carelessly.
//
// Patterns catch the shapes we know: a Bearer header and a JWT, which is
// what an id_token is. The client secret and the device code have no shape
// to match on, so they are registered as they are learned and masked by
// value. `log.ts` is the only module here that imports `vscode`.
import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function channelOf(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("Che Remote SSH");
  return channel;
}

const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

const literals = new Set<string>();

/**
 * Mask this exact value wherever it appears from now on. Used for the client
 * secret and the device code, which are indistinguishable from ordinary text.
 * Values shorter than eight characters are ignored: masking those would
 * scribble over unrelated words.
 */
export function maskLiteral(value: string | undefined): void {
  if (value && value.length >= 8) literals.add(value);
}

export function forgetLiterals(): void {
  literals.clear();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(s: string): string {
  let out = s
    .replace(PEM, "<private key redacted>")
    .replace(BEARER, "Bearer <redacted>")
    .replace(JWT, "<jwt redacted>");
  for (const literal of literals) {
    out = out.replace(new RegExp(escapeRegExp(literal), "g"), "<redacted>");
  }
  return out;
}

export function log(message: string): void {
  channelOf().appendLine(`[${new Date().toISOString()}] ${redact(message)}`);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
  forgetLiterals();
}

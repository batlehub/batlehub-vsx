// Redaction is a property of the sink (RFC 0001 §4.2 "Logging", §7): every
// line of every channel goes through here, and `Report a problem` collects
// only what came out of it. Pure, so it is tested as plain Node.

const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const PAT = /bh_pat_[A-Za-z0-9._-]+/g;
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const XML_SECRET = /<(password|passphrase|privateKey)>[^<]*<\/\1>/g;
const KV_SECRET =
  /\b(token|password|passwd|secret|apikey|api_key)\s*[=:]\s*["']?[^\s"'&;,]+/gi;

export function redact(s: string): string {
  return s
    .replace(BEARER, "Bearer <redacted>")
    .replace(PAT, "bh_pat_<redacted>")
    .replace(JWT, "<jwt redacted>")
    .replace(XML_SECRET, "<$1>&lt;redacted&gt;</$1>")
    .replace(KV_SECRET, (m, k: string) => `${k}=<redacted>`);
}

/** Home directories and user names out of a snapshot before it leaves the machine (§4.2 "Report a problem"). */
export function anonymise(s: string, home: string, user: string): string {
  let out = s;
  if (home) out = out.split(home).join("~");
  if (user && user.length > 2)
    out = out.replace(
      new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"),
      "<user>",
    );
  return out;
}

export type Level = "error" | "warn" | "info" | "debug" | "trace";
export const LEVELS: Level[] = ["error", "warn", "info", "debug", "trace"];

/** Whether a message at `at` is written when the configured level is `configured`. */
export function passes(configured: Level, at: Level): boolean {
  return LEVELS.indexOf(at) <= LEVELS.indexOf(configured);
}

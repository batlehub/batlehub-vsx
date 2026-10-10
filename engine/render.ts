// What `inspect` prints (RFC 0002 §4.2 "Output formats"): text for humans
// and grep, JSON with the bundle's rows verbatim, SARIF 2.1.0 for a forge's
// code-scanning view. Pure: rows in, a string out.
import type { Row } from "@batlehub/java-rules/rules";

export type Finding = Row & { path: string };
export type Severity = Row["severity"];

const RANK: Record<Severity, number> = {
  hint: 0,
  info: 1,
  warning: 2,
  error: 3,
};

/** Exit 1 when any finding is at or above `failOn` (§4.2 "Exit codes"). */
export function failed(findings: Finding[], failOn: Severity): boolean {
  return findings.some((f) => RANK[f.severity] >= RANK[failOn]);
}

/** `path:line:col code message`, 1-based, one line per finding. */
export function text(findings: Finding[]): string {
  return findings
    .map(
      (f) =>
        `${f.path}:${f.range.start.line + 1}:${f.range.start.character + 1} ${f.code} ${f.message}${f.fixTitle ? " [fix]" : ""}`,
    )
    .join("\n");
}

export function json(findings: Finding[], exit: number): string {
  return JSON.stringify({ findings, exit }, null, 2);
}

const LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  error: "error",
  warning: "warning",
  info: "note",
  hint: "note",
};

export function sarif(findings: Finding[], version: string): string {
  const rules = [...new Set(findings.map((f) => f.code))].sort();
  return JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "batlehub-java",
              version,
              informationUri:
                "https://batleforc.github.io/batlehub-vsx/guide/java/agents",
              rules: rules.map((id) => ({ id })),
            },
          },
          results: findings.map((f) => ({
            ruleId: f.code,
            level: LEVEL[f.severity],
            message: { text: f.message },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: f.path.split("\\").join("/") },
                  region: {
                    startLine: f.range.start.line + 1,
                    startColumn: f.range.start.character + 1,
                    endLine: f.range.end.line + 1,
                    endColumn: f.range.end.character + 1,
                  },
                },
              },
            ],
          })),
        },
      ],
    },
    null,
    2,
  );
}

/**
 * A unified diff of one file, three lines of context. The common head and
 * tail are cut first, so the line LCS only runs over what changed.
 */
// ponytail: O(n·m) LCS over the changed middle; a fix or a generator touches a few dozen lines, Myers if a whole-file rewrite ever needs it.
export function unifiedDiff(
  file: string,
  before: string,
  after: string,
): string {
  // A final newline ends the last line; it does not start an empty one.
  const lines = (t: string) =>
    (t.endsWith("\n") ? t.slice(0, -1) : t).split("\n");
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  // lcs[i][j]: the common length of am[i..] and bm[j..].
  const lcs = Array.from({ length: am.length + 1 }, () =>
    new Array<number>(bm.length + 1).fill(0),
  );
  for (let i = am.length - 1; i >= 0; i--)
    for (let j = bm.length - 1; j >= 0; j--)
      lcs[i]![j] =
        am[i] === bm[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { k: " " | "-" | "+"; l: string }[] = [];
  for (const l of a.slice(0, head)) ops.push({ k: " ", l });
  let i = 0;
  let j = 0;
  while (i < am.length || j < bm.length) {
    if (i < am.length && j < bm.length && am[i] === bm[j]) {
      ops.push({ k: " ", l: am[i++]! });
      j++;
    } else if (
      i < am.length &&
      (j === bm.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)
    )
      ops.push({ k: "-", l: am[i++]! });
    else ops.push({ k: "+", l: bm[j++]! });
  }
  for (const l of a.slice(a.length - tail)) ops.push({ k: " ", l });
  // Hunks: each change with three lines around it, close ones merged.
  const changed = ops.flatMap((o, n) => (o.k === " " ? [] : [n]));
  if (!changed.length) return "";
  const out = [`--- a/${file}`, `+++ b/${file}`];
  let n = 0;
  while (n < changed.length) {
    const from = Math.max(0, changed[n]! - 3);
    let to = changed[n]! + 3;
    while (n + 1 < changed.length && changed[n + 1]! - 3 <= to + 1)
      to = changed[++n]! + 3;
    n++;
    to = Math.min(ops.length - 1, to);
    const slice = ops.slice(from, to + 1);
    const before0 = ops.slice(0, from).filter((o) => o.k !== "+").length;
    const after0 = ops.slice(0, from).filter((o) => o.k !== "-").length;
    const aLen = slice.filter((o) => o.k !== "+").length;
    const bLen = slice.filter((o) => o.k !== "-").length;
    out.push(`@@ -${before0 + 1},${aLen} +${after0 + 1},${bLen} @@`);
    for (const o of slice) out.push(`${o.k}${o.l}`);
  }
  return out.join("\n");
}

// The pure half of the inspections bridge (RFC 0001 §4.2 "Inspections",
// §6.2): what the bundle's rows become client-side — severity overrides
// applied before display, grouping for the view, and the ping/restart
// decision of "The bundle is loaded at server start only". No `vscode`.

export interface Row {
  ruleId: string;
  area: string;
  code: string;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  fixTitle?: string;
}

export type Override = "error" | "warning" | "info" | "hint" | "off";

/** Overrides are keyed by `ruleId` or by `area/ruleId`; `off` drops the row. */
export function applyOverrides(
  rows: Row[],
  overrides: Record<string, string>,
): Row[] {
  const out: Row[] = [];
  for (const r of rows) {
    const o = (overrides[r.code] ?? overrides[r.ruleId]) as
      Override | undefined;
    if (o === "off") continue;
    out.push(o ? { ...r, severity: o } : r);
  }
  return out;
}

export interface Grouped {
  code: string;
  count: number;
  files: { uri: string; rows: Row[] }[];
}

/** rule → file → occurrence, rules with the most findings first. */
export function group(byUri: Record<string, Row[]>): Grouped[] {
  const byCode = new Map<string, Map<string, Row[]>>();
  for (const [uri, rows] of Object.entries(byUri)) {
    for (const r of rows) {
      let files = byCode.get(r.code);
      if (!files) byCode.set(r.code, (files = new Map()));
      let list = files.get(uri);
      if (!list) files.set(uri, (list = []));
      list.push(r);
    }
  }
  return [...byCode.entries()]
    .map(([code, files]) => ({
      code,
      count: [...files.values()].reduce((n, l) => n + l.length, 0),
      files: [...files.entries()].map(([uri, rows]) => ({ uri, rows })),
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export type PingOutcome =
  "loaded" | "restart-offered" | "not-standard" | "skipped";

/**
 * After activation: ping only in Standard mode; a failed ping while Standard
 * is the "installed or updated java-core, server not restarted" case and
 * earns the one restart offer per session.
 */
export function pingDecision(
  mode: string | undefined,
  pingOk: boolean | undefined,
  offeredBefore: boolean,
): PingOutcome {
  if (mode !== "Standard") return "not-standard";
  if (pingOk) return "loaded";
  if (pingOk === false && !offeredBefore) return "restart-offered";
  return "skipped";
}

// The last 50 managed processes (RFC 0003 §6.3), zipped by `Report a
// problem` as `processes.json`. No argv and no env: a `-Dpassword=` on a
// command line never reaches a report.
import * as fs from "node:fs";
import * as path from "node:path";

export interface HistoryEntry {
  id: string;
  declaredMiB: number;
  peakRssMiB?: number;
  startedAt: string;
  stoppedAt: string;
  stage: "graceful" | "term" | "kill" | "exited";
}

export const MAX_HISTORY = 50;

export function pushHistory(
  list: HistoryEntry[],
  e: HistoryEntry,
): HistoryEntry[] {
  return [...list, e].slice(-MAX_HISTORY);
}

export function readHistory(file: string): HistoryEntry[] {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(v) ? (v as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

export function appendHistory(file: string, e: HistoryEntry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(pushHistory(readHistory(file), e), null, 2),
  );
}

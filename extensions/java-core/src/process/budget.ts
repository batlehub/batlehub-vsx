// The sum of RFC 0003 §4.2: every declared cap against the pod's budget,
// before a start. Pure. The budget is the pod's memory *request* (a setting,
// 8 GiB by default: the cgroup exposes only the limit), never above the
// cgroup limit; with no limit (a laptop) nothing is ever "over".

export interface Declared {
  id: string;
  mib: number;
  /** For the JDK tab; the id when absent. */
  label?: string;
  /** Another extension's JVM (`process.declare`): estimated, not managed. */
  estimate?: boolean;
}

export function sum(declared: Declared[]): number {
  return declared.reduce((n, d) => n + d.mib, 0);
}

export function effectiveBudget(budgetMiB: number, limitMiB?: number): number {
  return limitMiB === undefined ? budgetMiB : Math.min(budgetMiB, limitMiB);
}

export function verdict(
  total: number,
  budgetMiB: number,
  limitMiB?: number,
): "fits" | "over" {
  if (limitMiB === undefined) return "fits";
  return total > effectiveBudget(budgetMiB, limitMiB) ? "over" : "fits";
}

/** The modal's sentence: `1 280 MiB declared of a 1 024 MiB budget`. */
export function overMessage(
  total: number,
  budgetMiB: number,
  limitMiB: number | undefined,
  what: string,
): string {
  const n = (x: number) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${what}: ${n(total)} MiB declared of a ${n(effectiveBudget(budgetMiB, limitMiB))} MiB budget`;
}

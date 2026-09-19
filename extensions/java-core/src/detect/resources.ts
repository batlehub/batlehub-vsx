// The container's resources as a diagnostic (RFC 0001 §4.2, decision 30):
// the cgroup limit against what this workspace is about to run. Pure —
// the file reader is injected, so the pod and the laptop are both a test.

export interface ResourceSnapshot {
  /** Bytes, or undefined on a laptop with no cgroup limit. */
  limit?: number;
  limitSource?: "cgroup2" | "cgroup1";
  /** What is about to run and how much each asks for, in bytes. */
  consumers: { name: string; bytes: number }[];
  planned: number;
}

export type ReadFile = (path: string) => string | undefined;

const CGROUP2 = "/sys/fs/cgroup/memory.max";
const CGROUP1 = "/sys/fs/cgroup/memory/memory.limit_in_bytes";
/** cgroup v1 reports "no limit" as a huge number; anything past 1 PiB is that. */
const UNLIMITED = 2 ** 50;

export function readCgroupLimit(read: ReadFile): {
  limit?: number;
  source?: "cgroup2" | "cgroup1";
} {
  const v2 = read(CGROUP2)?.trim();
  if (v2 !== undefined) {
    if (v2 === "max") return {};
    const n = Number(v2);
    return Number.isFinite(n) ? { limit: n, source: "cgroup2" } : {};
  }
  const v1 = read(CGROUP1)?.trim();
  if (v1 !== undefined) {
    const n = Number(v1);
    return Number.isFinite(n) && n < UNLIMITED
      ? { limit: n, source: "cgroup1" }
      : {};
  }
  return {};
}

const UNITS: Record<string, number> = {
  k: 2 ** 10,
  m: 2 ** 20,
  g: 2 ** 30,
  t: 2 ** 40,
};

/** `2Gi`, `2G`, `512Mi`, `1024k`, `2048` (bytes) → bytes; undefined when unreadable. */
export function parseSize(s: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt])?i?b?\s*$/i.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  return Math.round(unit ? n * UNITS[unit]! : n);
}

/** The `-Xmx` of a JVM argument string, in bytes; JDT.LS's default when absent. */
export function parseXmx(vmargs: string, fallback = 2 * 2 ** 30): number {
  let last: number | undefined;
  for (const m of vmargs.matchAll(/-Xmx(\d+(?:\.\d+)?[kmgt]?)/gi)) {
    const v = parseSize(m[1]!);
    if (v !== undefined) last = v;
  }
  return last ?? fallback;
}

export function formatSize(bytes: number): string {
  if (bytes >= 2 ** 30)
    return `${(bytes / 2 ** 30).toFixed(bytes % 2 ** 30 ? 1 : 0)} GiB`;
  if (bytes >= 2 ** 20) return `${Math.round(bytes / 2 ** 20)} MiB`;
  return `${bytes} B`;
}

export interface BudgetInput {
  read: ReadFile;
  jdtVmargs: string;
  /** Present when the workspace has a Gradle build: the daemon's default heap. */
  gradle: boolean;
  /** Present when java-groovy is installed. */
  groovy: boolean;
}

const GRADLE_DAEMON = 512 * 2 ** 20;
const GROOVY_SERVER = 512 * 2 ** 20;
/** The editor's own server, the terminal shell, the JVM off-heap: a floor, not a measurement. */
const BASELINE = 768 * 2 ** 20;

export function budget(input: BudgetInput): ResourceSnapshot {
  const { limit, source } = readCgroupLimit(input.read);
  const consumers = [
    { name: "editor + shell + JVM off-heap", bytes: BASELINE },
    {
      name: "JDT.LS (java.jdt.ls.vmargs -Xmx)",
      bytes: parseXmx(input.jdtVmargs),
    },
  ];
  if (input.gradle)
    consumers.push({ name: "Gradle daemon", bytes: GRADLE_DAEMON });
  if (input.groovy)
    consumers.push({ name: "Groovy language server", bytes: GROOVY_SERVER });
  return {
    limit,
    limitSource: source,
    consumers,
    planned: consumers.reduce((n, c) => n + c.bytes, 0),
  };
}

export interface Warning {
  /** One line: what gets killed first. */
  headline: string;
  detail: string;
}

/**
 * The warning of §4.3, or undefined. Below `warnBelow` the status bar turns ⚠;
 * `""` disables. Also warns when the planned sum exceeds the limit itself,
 * whatever the threshold: that is the OOMKilled pod of §2 point 7.
 */
export function resourceWarning(
  snap: ResourceSnapshot,
  warnBelow: string,
): Warning | undefined {
  if (snap.limit === undefined) return undefined;
  const threshold = warnBelow ? parseSize(warnBelow) : undefined;
  const under = threshold !== undefined && snap.limit < threshold;
  const over = snap.planned > snap.limit;
  if (!under && !over) return undefined;
  const biggest = [...snap.consumers].sort((a, b) => b.bytes - a.bytes)[0]!;
  return {
    headline: `Container memory is ${formatSize(snap.limit)}; this workspace plans ${formatSize(snap.planned)}. ${biggest.name} (${formatSize(biggest.bytes)}) is what gets killed first.`,
    detail: snap.consumers
      .map((c) => `${c.name}: ${formatSize(c.bytes)}`)
      .join("; "),
  };
}

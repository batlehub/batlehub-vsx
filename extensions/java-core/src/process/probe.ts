// The readiness probes of RFC 0003 §4.1, over any source: a managed process
// (its output and its exit), a wait step (nothing but the probe), a task or a
// launch (an exit code, no output). Messages name no subject: the caller
// prefixes its id or its step number.
import * as net from "node:net";
import type { Probe } from "../api-types";

export interface ProbeSource {
  /** The last output, for a `log` probe. */
  output?(): string;
  /** Resolves with the exit code when the source ends. */
  exited?: Promise<number | null>;
  /** Defined once it ended. */
  exitCode?(): number | null | undefined;
}

/** An `exit` probe whose source ended without a code (js-debug sends no `exited` event). */
export class NoExitCode extends Error {
  constructor(expected: number) {
    super(`ended without an exit code, expected ${expected}`);
    this.name = "NoExitCode";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

/** Resolves when ready; rejects with the reason, e.g. `not ready after 60 s: http 404 (last)`. */
export async function waitReady(p: Probe, src: ProbeSource): Promise<void> {
  const timeoutMs = p.timeoutMs ?? 60_000;
  const intervalMs = p.intervalMs ?? 500;
  const code = src.exitCode ?? (() => undefined);
  if (p.exit !== undefined) {
    const c = await Promise.race([
      src.exited ?? new Promise<never>(() => {}),
      sleep(timeoutMs).then(() => undefined),
    ]);
    if (c === undefined)
      throw new Error(`not ready after ${timeoutMs / 1000} s: still running`);
    if (c === null) throw new NoExitCode(p.exit);
    if (c !== p.exit) throw new Error(`exited ${c}, expected ${p.exit}`);
    return;
  }
  const re = p.log ? new RegExp(p.log, "m") : undefined;
  const until = Date.now() + timeoutMs;
  let last = "not checked";
  for (;;) {
    if (code() !== undefined)
      throw new Error(`exited ${code()} before it was ready`);
    let ok: boolean;
    if (p.port !== undefined) {
      ok = await portOpen(p.port);
      last = ok ? "open" : "closed";
    } else if (p.http) {
      try {
        const r = await fetch(p.http);
        ok = p.status !== undefined ? r.status === p.status : r.ok;
        last = `http ${r.status}`;
      } catch (e) {
        ok = false;
        last = (e as Error).message;
      }
    } else if (re) {
      ok = re.test(src.output?.() ?? "");
      last = "no match";
    } else {
      // No probe: alive after one interval.
      await sleep(intervalMs);
      if (code() !== undefined)
        throw new Error(`exited ${code()} before it was ready`);
      return;
    }
    if (ok) return;
    if (Date.now() >= until)
      throw new Error(`not ready after ${timeoutMs / 1000} s: ${last} (last)`);
    await sleep(intervalMs);
  }
}

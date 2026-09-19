// Modules of later phases register here so `activate` stays the list of
// RFC 0001 §6.1. Its own module, because `surface.ts` imports `wire` while
// `extension.ts` imports `surface.ts` for its side effect: a cycle through
// extension.ts would run `wire()` before the array exists.
import type { Core } from "./extension";

const wired: ((c: Core) => void)[] = [];

export function wire(f: (c: Core) => void): void {
  wired.push(f);
}

export function runWired(core: Core): void {
  for (const f of wired) f(core);
}

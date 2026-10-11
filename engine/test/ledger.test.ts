import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ledgerFile,
  putLine,
  readLedger,
  removeLine,
} from "@batlehub/java-rules/ledger";
import { ledgerCheck } from "../ops.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  dirs.push(d);
  return d;
};
afterAll(() =>
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

const GiB = 2 ** 30;

describe("the cap ledger (RFC 0003 decision 16, RFC 0002 use case 6)", () => {
  it("keys a module and its repository to one file", () => {
    const repo = tmp();
    mkdirSync(path.join(repo, ".git"));
    mkdirSync(path.join(repo, "core"));
    const cache = tmp();
    expect(ledgerFile(path.join(repo, "core"), cache)).toBe(
      ledgerFile(repo, cache),
    );
    expect(ledgerFile(tmp(), cache)).not.toBe(ledgerFile(repo, cache));
  });

  it("adds, replaces and removes a line, 0600, and drops dead pids on read", () => {
    const file = ledgerFile(tmp(), tmp());
    const live = new Set([1, 2]);
    const isAlive = (pid: number) => live.has(pid);
    putLine(
      file,
      { pid: 1, owner: "editor", label: "editor", bytes: GiB },
      isAlive,
    );
    putLine(
      file,
      { pid: 2, owner: "engine", label: "engine", bytes: GiB },
      isAlive,
    );
    putLine(
      file,
      { pid: 1, owner: "editor", label: "editor", bytes: 3 * GiB },
      isAlive,
    );
    expect(readLedger(file, isAlive).map((l) => [l.pid, l.bytes])).toEqual([
      [2, GiB],
      [1, 3 * GiB],
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    live.delete(1);
    expect(readLedger(file, isAlive).map((l) => l.pid)).toEqual([2]);
    removeLine(file, 2, "engine", isAlive);
    expect(readLedger(file, isAlive)).toEqual([]);
    expect(readLedger(path.join(tmp(), "none.json"))).toEqual([]);
  });

  it("refuses a cap that does not fit beside what runs, naming each", () => {
    const editor = {
      pid: 7,
      owner: "editor" as const,
      label: "the editor (planned)",
      bytes: 3 * GiB,
    };
    expect(() => ledgerCheck(GiB, 4 * GiB, [editor])).not.toThrow();
    expect(() => ledgerCheck(GiB, undefined, [editor])).not.toThrow();
    expect(() => ledgerCheck(2 * GiB, 4 * GiB, [editor])).toThrow(
      /declared cap 2 GiB and what already runs on this repository — the editor \(planned\): 3 GiB — do not fit the container's limit 4 GiB/,
    );
  });
});

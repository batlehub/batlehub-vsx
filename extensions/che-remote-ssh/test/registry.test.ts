import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { reclaimable } from "../src/lease";
import {
  forgetRecord,
  killRecord,
  readRecords,
  recordFileName,
  stillOurs,
  writeRecord,
  type ForwardRecord,
  type ProcessProbe,
} from "../src/registry";

const now = 1_800_000_000_000;

const record = (over: Partial<ForwardRecord> = {}): ForwardRecord => ({
  authority: "ssh-remote+weebo-dev-setup",
  namespace: "dev-ws-max",
  pod: "workspaceb089-5cbb-4nbdc",
  port: 38665,
  pid: 4242,
  since: now - 700_000,
  ...over,
});

const scratch = () => mkdtemp(path.join(tmpdir(), "che-remote-ssh-reg-"));

describe("recordFileName", () => {
  it("cannot escape the directory", () => {
    expect(recordFileName("../../etc/passwd")).not.toContain("/");
    expect(recordFileName("")).toBe("unnamed.forward");
  });
});

describe("records on disk", () => {
  it("survive the process that wrote them, which is the point", async () => {
    const dir = await scratch();
    await writeRecord(dir, record());
    await writeRecord(dir, record({ authority: "ssh-remote+other", pod: "pod-2", port: 1 }));
    expect((await readRecords(dir)).map((r) => r.port).sort((a, b) => a - b)).toEqual([1, 38665]);
    await forgetRecord(dir, "ssh-remote+other");
    expect((await readRecords(dir)).map((r) => r.authority)).toEqual([
      "ssh-remote+weebo-dev-setup",
    ]);
  });

  it("read as none when nothing was ever written", async () => {
    expect(await readRecords(path.join(await scratch(), "nothing"))).toEqual([]);
  });

  it("ignore a file that is not a record", async () => {
    const dir = await scratch();
    await writeRecord(dir, record());
    await writeFile(path.join(dir, "half.forward"), "{ truncated");
    await writeFile(path.join(dir, "wrong.forward"), JSON.stringify({ authority: "x" }));
    expect(await readRecords(dir)).toHaveLength(1);
  });
});

describe("stillOurs", () => {
  const alive: ProcessProbe = { alive: () => true };
  const dead: ProcessProbe = { alive: () => false };

  it("says no when nothing runs under that pid", () => {
    expect(stillOurs(record(), dead)).toBe(false);
  });

  it("accepts existence alone where no command line can be read", () => {
    expect(stillOurs(record(), alive)).toBe(true);
  });

  it("refuses a pid that has been reused by something else", () => {
    const reused: ProcessProbe = { alive: () => true, commandLine: () => "/usr/bin/firefox" };
    expect(stillOurs(record(), reused)).toBe(false);
  });

  it("refuses a forward onto another pod, which is another workspace's", () => {
    const other: ProcessProbe = {
      alive: () => true,
      commandLine: () => "kubectl port-forward -n dev-ws-max pod/someone-else 1:2022",
    };
    expect(stillOurs(record(), other)).toBe(false);
  });

  it("accepts the forward it recorded", () => {
    const ours: ProcessProbe = {
      alive: () => true,
      commandLine: () => `kubectl port-forward -n dev-ws-max pod/${record().pod} 38665:2022`,
    };
    expect(stillOurs(record(), ours)).toBe(true);
  });
});

describe("killRecord", () => {
  it("does not signal a pid that is no longer the forward", () => {
    const reused: ProcessProbe = { alive: () => true, commandLine: () => "/usr/bin/firefox" };
    expect(killRecord(record(), reused)).toBe(false);
  });

  it("does not signal a pid that has gone", () => {
    expect(killRecord(record(), { alive: () => false })).toBe(false);
  });
});

describe("reclaiming from the registry", () => {
  it("closes a tunnel whose window left, wherever it was opened from", () => {
    expect(reclaimable([record()], [], now, { ttlMs: 90_000, graceMs: 600_000 })).toHaveLength(1);
  });

  it("leaves one whose window still refreshes its lease", () => {
    const leases = [{ authority: "ssh-remote+weebo-dev-setup", updatedAt: now - 5_000 }];
    expect(reclaimable([record()], leases, now, { ttlMs: 90_000, graceMs: 600_000 })).toEqual([]);
  });
});

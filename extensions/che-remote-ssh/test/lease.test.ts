import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  leaseFileName,
  readLeases,
  reclaimable,
  removeLease,
  writeLease,
  type HandedOver,
} from "../src/lease";

const now = 1_800_000_000_000;
const opts = { ttlMs: 90_000, graceMs: 600_000 };

const handed = (over: Partial<HandedOver> = {}): HandedOver => ({
  namespace: "dev-ws-max",
  pod: "pod-1",
  authority: "ssh-remote+weebo-dev-setup",
  since: now - 700_000,
  ...over,
});

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "che-remote-ssh-lease-"));
}

describe("leaseFileName", () => {
  it("cannot escape the directory it is written in", () => {
    expect(leaseFileName("../../etc/passwd")).not.toContain("/");
    expect(leaseFileName("ssh-remote+weebo")).toBe("ssh-remote_weebo.lease");
  });

  it("still names something when the authority is unusable", () => {
    expect(leaseFileName("///")).toBe("_.lease");
    expect(leaseFileName("")).toBe("unnamed.lease");
  });
});

describe("leases on disk", () => {
  it("are written, read back and removed", async () => {
    const dir = await scratch();
    await writeLease(dir, "ssh-remote+a", now);
    await writeLease(dir, "ssh-remote+b", now);
    expect((await readLeases(dir)).map((l) => l.authority).sort()).toEqual([
      "ssh-remote+a",
      "ssh-remote+b",
    ]);
    await removeLease(dir, "ssh-remote+a");
    expect((await readLeases(dir)).map((l) => l.authority)).toEqual(["ssh-remote+b"]);
  });

  it("read as none when the directory does not exist", async () => {
    expect(await readLeases(path.join(await scratch(), "nothing"))).toEqual([]);
  });

  it("ignore a file that is not a lease", async () => {
    const dir = await scratch();
    await writeLease(dir, "ssh-remote+a", now);
    await writeFile(path.join(dir, "notes.txt"), "hello");
    await writeFile(path.join(dir, "broken.lease"), "{ half written");
    await writeFile(path.join(dir, "wrong.lease"), JSON.stringify({ authority: 12 }));
    expect((await readLeases(dir)).map((l) => l.authority)).toEqual(["ssh-remote+a"]);
  });

  it("removing one that was never there is not an error", async () => {
    const dir = await scratch();
    await removeLease(dir, "ssh-remote+ghost");
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("reclaimable", () => {
  it("leaves a forward alone while its window refreshes its lease", () => {
    const leases = [{ authority: "ssh-remote+weebo-dev-setup", updatedAt: now - 10_000 }];
    expect(reclaimable([handed()], leases, now, opts)).toEqual([]);
  });

  it("reclaims one whose window stopped refreshing, which is a window that crashed", () => {
    const leases = [{ authority: "ssh-remote+weebo-dev-setup", updatedAt: now - 200_000 }];
    expect(reclaimable([handed()], leases, now, opts)).toHaveLength(1);
  });

  it("reclaims one whose lease was removed, which is a window that closed", () => {
    expect(reclaimable([handed()], [], now, opts)).toHaveLength(1);
  });

  it("leaves a fresh forward alone: its window has not opened a folder yet", () => {
    expect(reclaimable([handed({ since: now - 1000 })], [], now, opts)).toEqual([]);
  });

  it("reclaims only the forwards nothing holds", () => {
    const held = handed({ authority: "ssh-remote+held", pod: "pod-held" });
    const dropped = handed({ authority: "ssh-remote+dropped", pod: "pod-dropped" });
    const leases = [{ authority: "ssh-remote+held", updatedAt: now }];
    expect(reclaimable([held, dropped], leases, now, opts).map((h) => h.pod)).toEqual([
      "pod-dropped",
    ]);
  });

  it("ignores a lease belonging to a window this one never opened", () => {
    const leases = [{ authority: "ssh-remote+someone-else", updatedAt: now }];
    expect(reclaimable([handed()], leases, now, opts)).toHaveLength(1);
  });
});

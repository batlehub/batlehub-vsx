import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { installEntries, removeIdentity, writeIdentity } from "../src/sshfiles";
import { pemBanner } from "./helpers";

const HOSTILE = `Host *
    PubkeyAuthentication no
    IdentitiesOnly yes
Host github.com
  IdentityFile ~/.ssh/github
`;

const entry = {
  host: "weebo-dev-setup",
  port: 2222,
  user: "user",
  identityFile: "/store/keys/pod-1.key",
};

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "che-remote-ssh-"));
}

describe("writeIdentity", () => {
  it("writes a key its owner alone can read", async () => {
    const dir = path.join(await scratch(), "keys");
    const file = await writeIdentity(dir, "pod-1", `${pemBanner("BEGIN")}\nx\n${pemBanner("END")}`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe(`${pemBanner("BEGIN")}\nx\n${pemBanner("END")}\n`);
  });

  it("adds the trailing newline OpenSSH insists on", async () => {
    const dir = path.join(await scratch(), "keys");
    const file = await writeIdentity(dir, "pod-2", "no-newline");
    expect(await readFile(file, "utf8")).toBe("no-newline\n");
  });

  it("forgets a key on request", async () => {
    const dir = path.join(await scratch(), "keys");
    await writeIdentity(dir, "pod-3", "k");
    await removeIdentity(dir, "pod-3");
    await expect(stat(path.join(dir, "pod-3.key"))).rejects.toThrow();
  });
});

describe("installEntries", () => {
  it("writes the fragment and points a hostile config at it, from the top", async () => {
    const home = await scratch();
    const sshDir = path.join(home, ".ssh");
    const managed = path.join(home, "storage", "ssh", "che-remote-ssh.conf");
    await writeFile(path.join(await mkdtemp(path.join(tmpdir(), "unused-")), "x"), "");
    await (await import("node:fs/promises")).mkdir(sshDir, { recursive: true });
    await writeFile(path.join(sshDir, "config"), HOSTILE);

    const result = await installEntries(sshDir, managed, [entry]);
    expect(result.includeAdded).toBe(true);
    expect(result.pubkeyDisabledSomewhere).toBe(true);

    const config = await readFile(path.join(sshDir, "config"), "utf8");
    expect(config.indexOf("Include")).toBeLessThan(config.indexOf("Host *"));
    const fragment = await readFile(managed, "utf8");
    expect(fragment).toContain("Host weebo-dev-setup");
    expect(fragment).toContain("PubkeyAuthentication yes");
    expect((await stat(managed)).mode & 0o777).toBe(0o600);
  });

  it("creates ~/.ssh/config when there is none", async () => {
    const home = await scratch();
    const sshDir = path.join(home, ".ssh");
    const managed = path.join(home, "storage", "che-remote-ssh.conf");
    const result = await installEntries(sshDir, managed, [entry]);
    expect(result.includeAdded).toBe(true);
    expect(result.pubkeyDisabledSomewhere).toBe(false);
    expect(await readFile(path.join(sshDir, "config"), "utf8")).toBe(`Include ${managed}\n`);
  });

  it("is safe to run again: the include is added once", async () => {
    const home = await scratch();
    const sshDir = path.join(home, ".ssh");
    const managed = path.join(home, "storage", "che-remote-ssh.conf");
    await installEntries(sshDir, managed, [entry]);
    const second = await installEntries(sshDir, managed, [entry]);
    expect(second.includeAdded).toBe(false);
    const config = await readFile(path.join(sshDir, "config"), "utf8");
    expect(config.split("Include").length - 1).toBe(1);
  });

  it("rewrites the fragment whole, so a stale host does not linger", async () => {
    const home = await scratch();
    const sshDir = path.join(home, ".ssh");
    const managed = path.join(home, "storage", "che-remote-ssh.conf");
    await installEntries(sshDir, managed, [entry, { ...entry, host: "old", port: 3333 }]);
    await installEntries(sshDir, managed, [entry]);
    const fragment = await readFile(managed, "utf8");
    expect(fragment).toContain("Host weebo-dev-setup");
    expect(fragment).not.toContain("Host old");
  });
});

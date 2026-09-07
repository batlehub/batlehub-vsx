import { describe, expect, it } from "vitest";
import {
  BEGIN,
  END,
  ensureIncluded,
  findsPubkeyDisabled,
  hostBlock,
  quote,
  renderManagedConfig,
} from "../src/sshconfig";

// The config that sent us here: a global block at the top of ~/.ssh/config
// turning key authentication off for every host below it.
const HOSTILE = `Host *
    PubkeyAuthentication no
    IdentitiesOnly yes
Host github.com
  HostName github.com
  User git
	IdentityFile ~/.ssh/github
`;

const entry = {
  host: "weebo-dev-setup",
  port: 2222,
  user: "user",
  identityFile: "/store/keys/pod.key",
};

describe("quote", () => {
  it("leaves a plain path alone and quotes one with a space", () => {
    expect(quote("/store/keys/pod.key")).toBe("/store/keys/pod.key");
    expect(quote("/My Store/pod.key")).toBe('"/My Store/pod.key"');
  });

  it("refuses a path holding a double quote, which ssh_config cannot escape", () => {
    expect(() => quote('/store/we"ird')).toThrow(/cannot be escaped/);
  });
});

describe("hostBlock", () => {
  it("states key authentication rather than relying on the default", () => {
    expect(hostBlock(entry, "linux")).toContain("PubkeyAuthentication yes");
  });

  it("points at the loopback forward", () => {
    const block = hostBlock(entry, "linux");
    expect(block).toContain("HostName 127.0.0.1");
    expect(block).toContain("Port 2222");
    expect(block).toContain("UserKnownHostsFile /dev/null");
  });

  it("uses the null device Windows understands", () => {
    expect(hostBlock(entry, "win32")).toContain("UserKnownHostsFile nul");
  });
});

describe("renderManagedConfig", () => {
  it("marks the file as ours, whole", () => {
    const text = renderManagedConfig([entry], "linux");
    expect(text.startsWith(BEGIN)).toBe(true);
    expect(text.trimEnd().endsWith(END)).toBe(true);
  });
});

describe("ensureIncluded", () => {
  it("puts the include above the first Host block, where it still wins", () => {
    const { text, changed } = ensureIncluded(HOSTILE, "/store/che.conf");
    expect(changed).toBe(true);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Include /store/che.conf");
    expect(lines.findIndex((l) => l.startsWith("Include "))).toBeLessThan(
      lines.findIndex((l) => l.startsWith("Host *")),
    );
  });

  it("keeps comments and global options that come before the first block", () => {
    const text = `# my ssh config\nServerAliveInterval 60\n\nHost *\n  PubkeyAuthentication no\n`;
    const out = ensureIncluded(text, "/store/che.conf").text;
    expect(out.split("\n").slice(0, 2)).toEqual(["# my ssh config", "ServerAliveInterval 60"]);
    expect(out.indexOf("Include")).toBeLessThan(out.indexOf("Host *"));
  });

  it("is idempotent, so activation can run it every time", () => {
    const once = ensureIncluded(HOSTILE, "/store/che.conf").text;
    const twice = ensureIncluded(once, "/store/che.conf");
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once);
  });

  it("appends when the file holds no block at all", () => {
    expect(ensureIncluded("", "/store/che.conf").text).toBe("Include /store/che.conf\n");
    expect(ensureIncluded("ServerAliveInterval 60", "/store/che.conf").text).toBe(
      "ServerAliveInterval 60\nInclude /store/che.conf\n",
    );
  });

  it("quotes an include path that needs it", () => {
    expect(ensureIncluded("", "/My Store/che.conf").text).toBe('Include "/My Store/che.conf"\n');
  });
});

describe("findsPubkeyDisabled", () => {
  it("spots the setting that makes a correct host entry fail anyway", () => {
    expect(findsPubkeyDisabled(HOSTILE)).toBe(true);
    expect(findsPubkeyDisabled("Host *\n  IdentitiesOnly yes\n")).toBe(false);
  });
});

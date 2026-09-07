import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildKubeconfig,
  chooseKubeconfig,
  contextNameOf,
  expandHome,
  renderKubeconfig,
  writeKubeconfig,
} from "../src/kubeconfig";

const base = { server: "https://che.example.dev:6443", token: "id-token" };

describe("contextNameOf", () => {
  it("names the context after the host", () => {
    expect(contextNameOf("https://che.example.dev:6443")).toBe("che-che.example.dev");
  });

  it("survives something that is not a URL", () => {
    expect(contextNameOf("nonsense")).toBe("che-nonsense");
  });
});

describe("buildKubeconfig", () => {
  it("points every part at one name and carries the token", () => {
    const c = buildKubeconfig({ ...base, namespace: "dev-ws-max" });
    const name = c["current-context"];
    expect(c.clusters[0]!.name).toBe(name);
    expect(c.users[0]!.user).toEqual({ token: "id-token" });
    expect(c.contexts[0]!.context).toEqual({ cluster: name, user: name, namespace: "dev-ws-max" });
  });

  it("prefers a CA over skipping verification, which kubectl refuses together", () => {
    const c = buildKubeconfig({
      ...base,
      certificateAuthority: "/etc/ca.pem",
      insecureSkipTlsVerify: true,
    });
    expect(c.clusters[0]!.cluster["certificate-authority"]).toBe("/etc/ca.pem");
    expect(c.clusters[0]!.cluster["insecure-skip-tls-verify"]).toBeUndefined();
  });

  it("skips verification only when asked and no CA is set", () => {
    const c = buildKubeconfig({ ...base, insecureSkipTlsVerify: true });
    expect(c.clusters[0]!.cluster["insecure-skip-tls-verify"]).toBe(true);
  });

  it("leaves the namespace out when there is none", () => {
    expect(buildKubeconfig(base).contexts[0]!.context).not.toHaveProperty("namespace");
  });
});

describe("renderKubeconfig", () => {
  it("is JSON, which kubectl reads as YAML", () => {
    const text = renderKubeconfig(base);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(JSON.parse(text).kind).toBe("Config");
  });
});

describe("writeKubeconfig", () => {
  it("writes the file readable by its owner alone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "che-remote-ssh-"));
    const file = path.join(dir, "nested", "kubeconfig.json");
    await writeKubeconfig(file, base);
    expect(JSON.parse(await readFile(file, "utf8")).users[0].user.token).toBe("id-token");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("expandHome", () => {
  it("expands a leading tilde, which no shell is here to expand", () => {
    expect(expandHome("~/.kube/lab.yaml", "/home/max")).toBe("/home/max/.kube/lab.yaml");
    expect(expandHome("~", "/home/max")).toBe("/home/max");
  });

  it("leaves an absolute path and a tilde inside a name alone", () => {
    expect(expandHome("/etc/kube.yaml", "/home/max")).toBe("/etc/kube.yaml");
    expect(expandHome("/etc/back~up.yaml", "/home/max")).toBe("/etc/back~up.yaml");
  });
});

describe("chooseKubeconfig", () => {
  const own = "/storage/kubeconfig.json";

  it("writes its own when nothing is configured", () => {
    expect(
      chooseKubeconfig({ configured: "", context: "", ownFile: own, home: "/home/max" }),
    ).toEqual({
      file: own,
      owned: true,
    });
  });

  it("never picks up the default kubeconfig on its own", () => {
    const choice = chooseKubeconfig({
      configured: "   ",
      context: "lab",
      ownFile: own,
      home: "/home/max",
    });
    expect(choice.file).toBe(own);
    expect(choice.owned).toBe(true);
  });

  it("uses a configured file as it is, and does not own it", () => {
    expect(
      chooseKubeconfig({
        configured: "~/.kube/lab.yaml",
        context: "lab",
        ownFile: own,
        home: "/home/max",
      }),
    ).toEqual({ file: "/home/max/.kube/lab.yaml", owned: false, context: "lab" });
  });

  it("drops a context that names nothing", () => {
    expect(
      chooseKubeconfig({
        configured: "/etc/k.yaml",
        context: "  ",
        ownFile: own,
        home: "/home/max",
      }),
    ).toEqual({ file: "/etc/k.yaml", owned: false });
  });

  it("ignores a context on the file it writes, which holds only one", () => {
    const choice = chooseKubeconfig({
      configured: "",
      context: "lab",
      ownFile: own,
      home: "/home/max",
    });
    expect(choice.context).toBeUndefined();
  });
});

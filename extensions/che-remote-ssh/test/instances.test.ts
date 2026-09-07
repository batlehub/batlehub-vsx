import { describe, expect, it } from "vitest";
import { forInstance, hostOf, type ClusterSettings } from "../src/instances";

const defaults: ClusterSettings = {
  apiServer: "https://default:6443",
  insecureSkipTlsVerify: false,
  certificateAuthority: "",
  kubectlPath: "kubectl",
  kubeconfig: "",
  context: "",
  namespace: "",
};

describe("hostOf", () => {
  it("reduces a URL and a bare host to the same key", () => {
    expect(hostOf("https://cde.example.dev/dashboard/")).toBe("cde.example.dev");
    expect(hostOf("cde.example.dev")).toBe("cde.example.dev");
    expect(hostOf("CDE.Example.Dev")).toBe("cde.example.dev");
    expect(hostOf("cde.example.dev:6443")).toBe("cde.example.dev");
  });

  it("answers nothing for nothing", () => {
    expect(hostOf("  ")).toBe("");
  });
});

describe("forInstance", () => {
  it("returns the defaults when no table is set", () => {
    expect(forInstance(defaults, undefined, "cde.example.dev")).toBe(defaults);
  });

  it("returns the defaults for a host the table does not name", () => {
    const table = { "other.example.dev": { kubeconfig: "/other.yaml" } };
    expect(forInstance(defaults, table, "cde.example.dev")).toBe(defaults);
  });

  it("applies the entry over the defaults", () => {
    const table = { "cde.example.dev": { kubeconfig: "/lab.yaml", context: "lab" } };
    const applied = forInstance(defaults, table, "https://cde.example.dev");
    expect(applied.kubeconfig).toBe("/lab.yaml");
    expect(applied.context).toBe("lab");
    expect(applied.apiServer).toBe("https://default:6443");
  });

  it("matches whether the key is a host or a URL", () => {
    const table = { "https://cde.example.dev/": { namespace: "dev-ws-max" } };
    expect(forInstance(defaults, table, "cde.example.dev").namespace).toBe("dev-ws-max");
  });

  it("treats an empty field as unset rather than as a blanking", () => {
    const withCa = { ...defaults, certificateAuthority: "/ca.pem" };
    const table = { "cde.example.dev": { certificateAuthority: "", kubeconfig: "/lab.yaml" } };
    const applied = forInstance(withCa, table, "cde.example.dev");
    expect(applied.certificateAuthority).toBe("/ca.pem");
    expect(applied.kubeconfig).toBe("/lab.yaml");
  });

  it("carries a false through, which is a value and not an absence", () => {
    const insecure = { ...defaults, insecureSkipTlsVerify: true };
    const table = { "cde.example.dev": { insecureSkipTlsVerify: false } };
    expect(forInstance(insecure, table, "cde.example.dev").insecureSkipTlsVerify).toBe(false);
  });
});

describe("several instances at once", () => {
  // The shape this extension is actually configured with: one Che per
  // cluster, one kubeconfig each, and no credential shared between them.
  const table = {
    "cde.batleforc.fr": { kubeconfig: "/git/weebo5/0.config/kubeconfig.yaml" },
    "cde.weebo.poc": { kubeconfig: "/git/poc/kubeconfig.yaml", namespace: "dev-ws-max" },
  };

  it("gives each host its own kubeconfig", () => {
    expect(forInstance(defaults, table, "https://cde.batleforc.fr").kubeconfig).toBe(
      "/git/weebo5/0.config/kubeconfig.yaml",
    );
    expect(forInstance(defaults, table, "https://cde.weebo.poc/dashboard/").kubeconfig).toBe(
      "/git/poc/kubeconfig.yaml",
    );
  });

  it("keeps one instance's extra settings out of the other", () => {
    expect(forInstance(defaults, table, "cde.batleforc.fr").namespace).toBe("");
    expect(forInstance(defaults, table, "cde.weebo.poc").namespace).toBe("dev-ws-max");
  });

  it("leaves a third Che on the defaults", () => {
    expect(forInstance(defaults, table, "cde.elsewhere.dev")).toBe(defaults);
  });
});

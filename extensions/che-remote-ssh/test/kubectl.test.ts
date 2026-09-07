import { describe, expect, it } from "vitest";
import {
  DEVWORKSPACE_NAME_LABEL,
  containerOrder,
  contextsArgs,
  devWorkspacesAllArgs,
  devWorkspacesArgs,
  parseContexts,
  parseDevWorkspaces,
  parsePods,
  podsArgs,
  portForwardArgs,
  readKeyArgs,
  runningPodOf,
  versionArgs,
  type KubectlContext,
} from "../src/kubectl";

const ctx: KubectlContext = { bin: "kubectl", kubeconfig: "/store/kubeconfig.json" };

describe("argument vectors", () => {
  it("name our kubeconfig first, on every call, so the default one is unreachable", () => {
    for (const args of [
      versionArgs(ctx),
      devWorkspacesArgs(ctx, "dev-ws-max"),
      podsArgs(ctx, "dev-ws-max"),
      portForwardArgs(ctx, "dev-ws-max", "pod-1", 2222),
      readKeyArgs(ctx, "dev-ws-max", "pod-1", "tools"),
    ]) {
      expect(args.slice(0, 2)).toEqual(["--kubeconfig", "/store/kubeconfig.json"]);
    }
  });

  it("filters pods by the DevWorkspace label when one is given", () => {
    expect(podsArgs(ctx, "dev-ws-max", "weebo-dev-setup")).toContain(
      `${DEVWORKSPACE_NAME_LABEL}=weebo-dev-setup`,
    );
    expect(podsArgs(ctx, "dev-ws-max")).not.toContain("-l");
  });

  it("binds the forward to loopback", () => {
    const args = portForwardArgs(ctx, "dev-ws-max", "pod-1", 2222);
    expect(args).toContain("2222:2022");
    expect(args.slice(-2)).toEqual(["--address", "127.0.0.1"]);
  });
});

describe("parseDevWorkspaces", () => {
  it("reads the fields the connection needs", () => {
    const json = JSON.stringify({
      items: [
        {
          metadata: { name: "weebo-dev-setup", namespace: "dev-ws-max" },
          status: { devworkspaceId: "workspaceb089", phase: "Running", mainUrl: "https://che/x" },
        },
        { metadata: { name: "half-started", namespace: "dev-ws-max" }, status: {} },
      ],
    });
    expect(parseDevWorkspaces(json)).toEqual([
      {
        name: "weebo-dev-setup",
        namespace: "dev-ws-max",
        id: "workspaceb089",
        phase: "Running",
        mainUrl: "https://che/x",
      },
      { name: "half-started", namespace: "dev-ws-max" },
    ]);
  });

  it("returns nothing rather than throw on a payload without items", () => {
    expect(parseDevWorkspaces("{}")).toEqual([]);
  });
});

describe("parsePods and runningPodOf", () => {
  const json = JSON.stringify({
    items: [
      {
        metadata: {
          name: "workspaceb089-5cbb-4nbdc",
          namespace: "dev-ws-max",
          labels: { [DEVWORKSPACE_NAME_LABEL]: "weebo-dev-setup" },
        },
        status: { phase: "Running" },
        spec: {
          containers: [{ name: "tools" }, { name: "che-code-sshd-page" }, { name: "che-gateway" }],
        },
      },
      {
        metadata: {
          name: "workspaceb089-old",
          namespace: "dev-ws-max",
          labels: { [DEVWORKSPACE_NAME_LABEL]: "weebo-dev-setup" },
        },
        status: { phase: "Terminating" },
      },
    ],
  });

  it("carries the DevWorkspace the pod belongs to", () => {
    expect(parsePods(json)[0]!.devworkspace).toBe("weebo-dev-setup");
  });

  it("picks the running pod and no other", () => {
    expect(runningPodOf(parsePods(json), "weebo-dev-setup")!.name).toBe("workspaceb089-5cbb-4nbdc");
    expect(runningPodOf(parsePods(json), "other")).toBeNull();
  });
});

describe("an explicit context", () => {
  const withContext: KubectlContext = { ...ctx, context: "lab" };

  it("is passed to every call, right after the kubeconfig", () => {
    for (const args of [
      versionArgs(withContext),
      devWorkspacesArgs(withContext, "dev-ws-max"),
      podsArgs(withContext, "dev-ws-max"),
      portForwardArgs(withContext, "dev-ws-max", "pod-1", 2222),
    ]) {
      expect(args.slice(0, 4)).toEqual([
        "--kubeconfig",
        "/store/kubeconfig.json",
        "--context",
        "lab",
      ]);
    }
  });

  it("is left out when none is named", () => {
    expect(versionArgs(ctx)).not.toContain("--context");
  });
});

describe("devWorkspacesAllArgs", () => {
  it("asks the whole cluster, for a credential allowed to", () => {
    const args = devWorkspacesAllArgs(ctx);
    expect(args.slice(0, 2)).toEqual(["--kubeconfig", "/store/kubeconfig.json"]);
    expect(args).toContain("-A");
  });
});

describe("contextsArgs", () => {
  it("names the file being inspected, and no context", () => {
    const args = contextsArgs("/home/max/.kube/lab.yaml");
    expect(args).toEqual([
      "--kubeconfig",
      "/home/max/.kube/lab.yaml",
      "config",
      "get-contexts",
      "-o",
      "name",
    ]);
    expect(args).not.toContain("--context");
  });
});

describe("parseContexts", () => {
  it("reads one name per line and drops the blanks", () => {
    expect(parseContexts("lab\nprod\n\n  staging  \n")).toEqual(["lab", "prod", "staging"]);
  });

  it("reads nothing from nothing", () => {
    expect(parseContexts("")).toEqual([]);
    expect(parseContexts("\n \n")).toEqual([]);
  });
});

describe("containers of a pod", () => {
  it("are read from the pod, the only place that says what runs", () => {
    // A DevWorkspace built from a parent devfile and editor contributions
    // has an empty spec.template.components, so this is the only source.
    const json = JSON.stringify({
      items: [
        {
          metadata: { name: "pod-1", namespace: "dev-ws-max", labels: {} },
          status: { phase: "Running" },
          spec: { containers: [{ name: "tools" }, { name: "che-code-sshd-page" }] },
        },
      ],
    });
    expect(parsePods(json)[0]!.containers).toEqual(["tools", "che-code-sshd-page"]);
  });

  it("are empty rather than missing when the pod declares none", () => {
    const json = JSON.stringify({
      items: [{ metadata: { name: "pod-1" }, status: {}, spec: {} }],
    });
    expect(parsePods(json)[0]!.containers).toEqual([]);
  });
});

describe("containerOrder", () => {
  it("tries the workspace's own containers before the gateway sidecar", () => {
    expect(containerOrder(["che-gateway", "tools", "che-code-sshd-page"])).toEqual([
      "tools",
      "che-code-sshd-page",
      "che-gateway",
    ]);
  });

  it("keeps the pod's order otherwise", () => {
    expect(containerOrder(["tools", "che-code-sshd-page"])).toEqual([
      "tools",
      "che-code-sshd-page",
    ]);
  });

  it("copes with nothing to order", () => {
    expect(containerOrder([])).toEqual([]);
  });
});

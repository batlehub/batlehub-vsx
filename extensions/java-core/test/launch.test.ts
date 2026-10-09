import { describe, expect, it } from "vitest";
import {
  duplicate,
  javaConfigs,
  readLaunch,
  removeConfig,
  TEMPLATES,
  upsertConfig,
  upsertLaunch,
  upsertTask,
} from "../src/run/configs";

const LAUNCH = `{
  // Use IntelliSense to learn about possible attributes.
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Node thing",
      "program": "x.js"
    },
    {
      "type": "java",
      "name": "Run App",
      "request": "launch",
      "mainClass": "com.example.App",
      "projectName": "app",
      "someFutureKey": { "kept": true } // unknown to us
    }
  ]
}
`;

describe("launch.json round trip (§4.2)", () => {
  it("reads only java entries and keeps comments and unknown keys on write", () => {
    const f = readLaunch(LAUNCH);
    expect(f.errors).toEqual([]);
    expect(javaConfigs(f).map((c) => c.name)).toEqual(["Run App"]);
    const next = upsertConfig(LAUNCH, {
      type: "java",
      name: "Run App",
      request: "launch",
      mainClass: "com.example.App",
      projectName: "app",
      vmArgs: "-Xmx2g",
      batlehub: { template: "application" },
    });
    expect(next).toContain("// Use IntelliSense");
    expect(next).toContain("// unknown to us");
    expect(next).toContain('"someFutureKey"');
    expect(next).toContain('"vmArgs": "-Xmx2g"');
    expect(javaConfigs(readLaunch(next))).toHaveLength(1);
    expect(readLaunch(next).configurations[0]).toMatchObject({ type: "node" });
  });
  it("appends to a missing file, removes by name, duplicates", () => {
    const fresh = upsertConfig(
      undefined,
      TEMPLATES[0]!.make({ mainClass: "a.b.Main", projectName: "p" }),
    );
    expect(javaConfigs(readLaunch(fresh))[0]).toMatchObject({
      name: "Run Main",
      mainClass: "a.b.Main",
      batlehub: { template: "application" },
    });
    const two = upsertConfig(
      fresh,
      TEMPLATES[1]!.make({ mainClass: "", projectName: "p" }),
    );
    expect(javaConfigs(readLaunch(two)).map((c) => c.request)).toEqual([
      "launch",
      "attach",
    ]);
    const one = removeConfig(two, "Run Main");
    expect(javaConfigs(readLaunch(one)).map((c) => c.name)).toEqual([
      "Attach p",
    ]);
    expect(
      duplicate({ type: "java", name: "X", request: "launch", mainClass: "m" }),
    ).toMatchObject({ name: "X (copy)", mainClass: "m" });
    expect(removeConfig(one, "nope")).toBe(one);
  });
});

describe("a satellite's template (contract 1.1)", () => {
  it("upserts a task by label and a non-Java launch by name, keeping comments", () => {
    const tasks = `{
  // ours
  "version": "2.0.0",
  "tasks": [{ "label": "quarkus: dev", "type": "batlehub-java", "keep": 1 }]
}`;
    const t1 = upsertTask(tasks, {
      label: "quarkus: dev",
      type: "batlehub-java",
      goal: "quarkus:dev",
    });
    expect(t1).toContain("// ours");
    expect(t1).toContain('"keep": 1');
    expect(t1).toContain('"goal": "quarkus:dev"');
    const t2 = upsertTask(undefined, { label: "x", type: "shell" });
    expect(JSON.parse(t2).tasks).toEqual([{ label: "x", type: "shell" }]);
    const l = upsertLaunch(undefined, {
      type: "node",
      name: "Server",
      request: "launch",
    } as never);
    expect(readLaunch(l).configurations).toEqual([
      { type: "node", name: "Server", request: "launch" },
    ]);
  });
});

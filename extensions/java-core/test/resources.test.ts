import { describe, expect, it } from "vitest";
import {
  budget,
  formatSize,
  parseSize,
  parseXmx,
  readCgroupLimit,
  resourceWarning,
} from "../src/detect/resources";

const files = (m: Record<string, string>) => (p: string) => m[p];

describe("cgroup limit", () => {
  it("reads v2, treats max as no limit, falls back to v1 and ignores its unlimited sentinel", () => {
    expect(
      readCgroupLimit(files({ "/sys/fs/cgroup/memory.max": "17179869184\n" })),
    ).toEqual({ limit: 17179869184, source: "cgroup2" });
    expect(
      readCgroupLimit(files({ "/sys/fs/cgroup/memory.max": "max\n" })),
    ).toEqual({});
    expect(
      readCgroupLimit(
        files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2147483648" }),
      ),
    ).toEqual({ limit: 2147483648, source: "cgroup1" });
    expect(
      readCgroupLimit(
        files({
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
        }),
      ),
    ).toEqual({});
    expect(readCgroupLimit(files({}))).toEqual({});
  });
});

describe("sizes", () => {
  it("parses the Kubernetes spellings and -Xmx", () => {
    expect(parseSize("2Gi")).toBe(2 * 2 ** 30);
    expect(parseSize("512Mi")).toBe(512 * 2 ** 20);
    expect(parseSize("2G")).toBe(2 * 2 ** 30);
    expect(parseSize("2048")).toBe(2048);
    expect(parseSize("lots")).toBeUndefined();
    expect(parseXmx("-XX:+UseParallelGC -Xmx2G -Xms100m")).toBe(2 * 2 ** 30);
    expect(parseXmx("-Xmx1g -Xmx3g")).toBe(3 * 2 ** 30);
    expect(parseXmx("")).toBe(2 * 2 ** 30);
    expect(formatSize(2 * 2 ** 30)).toBe("2 GiB");
    expect(formatSize(768 * 2 ** 20)).toBe("768 MiB");
  });
});

describe("the warning of §4.3", () => {
  const read = files({ "/sys/fs/cgroup/memory.max": String(1.5 * 2 ** 30) });
  it("warns below warnBelow and names what gets killed first", () => {
    const w = resourceWarning(
      budget({ read, jdtVmargs: "-Xmx2G", gradle: false, groovy: false }),
      "2Gi",
    );
    expect(w?.headline).toContain("1.5 GiB");
    expect(w?.headline).toContain("JDT.LS");
  });
  it("warns when the plan exceeds the limit even with the threshold disabled", () => {
    const snap = budget({
      read,
      jdtVmargs: "-Xmx1G",
      gradle: true,
      groovy: true,
    });
    expect(resourceWarning(snap, "")).toBeDefined();
    expect(snap.consumers.map((c) => c.name)).toContain("Gradle daemon");
  });
  it("is silent on a laptop and in a 16 GiB pod", () => {
    expect(
      resourceWarning(
        budget({
          read: files({}),
          jdtVmargs: "-Xmx2G",
          gradle: true,
          groovy: true,
        }),
        "2Gi",
      ),
    ).toBeUndefined();
    const big = files({ "/sys/fs/cgroup/memory.max": "17179869184" });
    expect(
      resourceWarning(
        budget({ read: big, jdtVmargs: "-Xmx2G", gradle: true, groovy: true }),
        "2Gi",
      ),
    ).toBeUndefined();
  });
});

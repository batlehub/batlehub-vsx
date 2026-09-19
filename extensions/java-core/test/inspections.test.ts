import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  group,
  pingDecision,
  type Row,
} from "../src/inspections/rules";

const row = (
  code: string,
  line = 0,
  severity: Row["severity"] = "warning",
): Row => ({
  ruleId: code.split("/")[1]!,
  area: code.split("/")[0]!,
  code,
  message: code,
  severity,
  range: { start: { line, character: 0 }, end: { line, character: 1 } },
});

describe("inspections client side (§4.2)", () => {
  it("applies severity overrides by code or rule id and drops 'off'", () => {
    const rows = [
      row("unused/privateField"),
      row("style/redundantThis", 1, "info"),
      row("collections/sizeIsZero", 2),
    ];
    const out = applyOverrides(rows, {
      "unused/privateField": "error",
      redundantThis: "off",
      sizeIsZero: "hint",
    });
    expect(out.map((r) => [r.code, r.severity])).toEqual([
      ["unused/privateField", "error"],
      ["collections/sizeIsZero", "hint"],
    ]);
  });
  it("groups rule → file → occurrence, most findings first", () => {
    const g = group({
      "file:///A.java": [row("a/x"), row("a/y", 1), row("a/y", 2)],
      "file:///B.java": [row("a/y", 3)],
    });
    expect(g.map((x) => [x.code, x.count])).toEqual([
      ["a/y", 3],
      ["a/x", 1],
    ]);
    expect(g[0]!.files.map((f) => [f.uri, f.rows.length])).toEqual([
      ["file:///A.java", 2],
      ["file:///B.java", 1],
    ]);
  });
  it("pings only in Standard mode and offers the restart once", () => {
    expect(pingDecision("Hybrid", undefined, false)).toBe("not-standard");
    expect(pingDecision("Standard", true, false)).toBe("loaded");
    expect(pingDecision("Standard", false, false)).toBe("restart-offered");
    expect(pingDecision("Standard", false, true)).toBe("skipped");
  });
});

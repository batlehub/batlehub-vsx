import { describe, expect, it } from "vitest";
import {
  hasLombok,
  lombokChoice,
  shortcutOptions,
} from "../src/generate/options";

describe("the builder and withers options (RFC 0015 §4.1)", () => {
  it("offers Lombok only where the project has it, and never introduces it (use case 3)", () => {
    expect(lombokChoice("offer", true)).toBe("ask");
    expect(lombokChoice("offer", false)).toBe("code");
    expect(lombokChoice("always", true)).toBe("annotation");
    expect(lombokChoice("always", false)).toBe("code");
    expect(lombokChoice("never", true)).toBe("code");
  });

  it("finds lombok by its jar name on the classpath", () => {
    expect(
      hasLombok(["/m2/org/projectlombok/lombok/1.18.36/lombok-1.18.36.jar"]),
    ).toBe(true);
    expect(
      hasLombok(["/m2/lombok-mapstruct-binding-0.2.0.jar", "/x/classes"]),
    ).toBe(false);
  });

  it("builds the delegate's JSON, every field when none is picked", () => {
    expect(
      shortcutOptions("builder", {
        methodPrefix: "with",
        placement: "file",
        lombok: false,
      }),
    ).toEqual({ methodPrefix: "with", lombok: false, placement: "file" });
    expect(
      shortcutOptions("withers", {
        fields: ["x"],
        methodPrefix: "",
        style: "mutate",
        lombok: false,
      }),
    ).toEqual({
      fields: ["x"],
      methodPrefix: "",
      lombok: false,
      style: "mutate",
    });
  });
});

// RFC 0019 §7, §10. The security property of this extension is one line of
// manifest per setting, so it is asserted rather than trusted to stay.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/calendar";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const nls = JSON.parse(readFileSync("package.nls.json", "utf8"));
const bundle = JSON.parse(readFileSync("l10n/bundle.l10n.json", "utf8"));
const properties: Record<string, Record<string, unknown>> = pkg.contributes.configuration
  .properties;

describe("every setting is application-scoped", () => {
  // Without this, a repository's .vscode/settings.json could pick the
  // workbench colours of anyone who opens it and — worse, because it is free
  // text — their window.title, which is the string a person reads to know
  // which project they are in.
  it.each(Object.keys(properties))("%s", (key) => {
    expect(properties[key]!.scope).toBe("application");
  });

  it("covers the four settings and no others", () => {
    expect(Object.keys(properties).sort()).toEqual([
      "batlehub.seasons._saved",
      "batlehub.seasons.enabled",
      "batlehub.seasons.events",
      "batlehub.seasons.title",
    ]);
  });
});

describe("localisation", () => {
  it("has every setting description as a %key% of package.nls.json", () => {
    for (const [key, property] of Object.entries(properties)) {
      const text = (property.markdownDescription ?? property.description) as string;
      expect(text, key).toMatch(/^%[\w.-]+%$/);
      expect(nls, key).toHaveProperty(text.slice(1, -1));
    }
  });

  it("has every command title as a %key% of package.nls.json", () => {
    for (const command of pkg.contributes.commands) {
      expect(command.title, command.command).toMatch(/^%[\w.-]+%$/);
      expect(nls, command.command).toHaveProperty(command.title.slice(1, -1));
    }
  });

  it("has a catalogue entry for each shipped season name", () => {
    for (const season of DEFAULTS) expect(bundle, season.key).toHaveProperty(season.name);
  });

  it("declares the l10n folder, or vscode.l10n.t has no catalogue to read", () => {
    expect(pkg.l10n).toBe("./l10n");
  });
});

describe("the manifest's own claims", () => {
  it("is correct in an untrusted workspace, because it reads no workspace input", () => {
    expect(pkg.capabilities.untrustedWorkspaces.supported).toBe(true);
    expect(pkg.capabilities.virtualWorkspaces).toBe(true);
  });

  it("accepts the shipped dates under its own events schema", () => {
    const pattern = new RegExp(
      (
        properties["batlehub.seasons.events"]!.items as {
          properties: Record<string, { pattern: string }>;
        }
      ).properties.from!.pattern,
    );
    for (const season of DEFAULTS) {
      expect(pattern.test(season.from), season.key).toBe(true);
      expect(pattern.test(season.to), season.key).toBe(true);
    }
  });
});

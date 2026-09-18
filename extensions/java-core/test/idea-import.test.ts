import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILE_PATH } from "../src/idea/codestyle";
import { splitKey } from "../src/manifest";
import { javaConfigs, readLaunch } from "../src/run/configs";
import {
  type FullPlan,
  planCodeStyle,
  planDiffs,
  summary,
} from "../src/idea/import";

const FIXTURE = path.resolve(
  __dirname,
  "../../../tests/heavy/fixtures/maven-multi/.idea/codeStyles",
);
const projectXml = readFileSync(path.join(FIXTURE, "Project.xml"), "utf8");
const configXml = readFileSync(
  path.join(FIXTURE, "codeStyleConfig.xml"),
  "utf8",
);
const ok = () =>
  planCodeStyle(projectXml, configXml) as Exclude<
    ReturnType<typeof planCodeStyle>,
    { error: string }
  >;

describe("RFC 0007 §4.3 — a kind that must not be imported is refused with the reason", () => {
  it("refuses a project style IDEA itself ignores", () => {
    const r = planCodeStyle(
      projectXml,
      '<state><option name="USE_PER_PROJECT_SETTINGS" value="false" /></state>',
    );
    expect(r).toMatchObject({
      error: expect.stringContaining("USE_PER_PROJECT_SETTINGS"),
    });
  });

  it("treats an absent codeStyleConfig.xml as IDEA does — the project style applies", () => {
    expect(planCodeStyle(projectXml, undefined)).not.toHaveProperty("error");
  });

  it("refuses an XML that does not parse rather than importing half a profile", () => {
    expect(planCodeStyle("<component/>", configXml)).toMatchObject({
      error: expect.stringContaining("code_scheme"),
    });
  });
});

describe("RFC 0007 §6.1 — the plan is a diff, and nothing is on disk before Write", () => {
  it("gives the profile, the settings and their current content", () => {
    const plan: FullPlan = { codestyle: ok(), errors: [] };
    const diffs = planDiffs(plan, {});
    expect(diffs.map((d) => d.target)).toEqual([
      PROFILE_PATH,
      ".vscode/settings.json",
    ]);
    const profile = diffs[0]!;
    expect(profile.before).toBe(""); // absent: an empty left-hand side
    expect(profile.after).toContain('kind="CodeFormatterProfile"');
    const settings = diffs[1]!;
    expect(JSON.parse(settings.after)).toMatchObject({
      "java.format.settings.url": PROFILE_PATH,
      "[java]": { "editor.tabSize": 2 },
    });
  });

  it("keeps the settings the workspace already has", () => {
    const before =
      '{\n  // a comment the user wrote\n  "editor.rulers": [100]\n}\n';
    const diffs = planDiffs(
      { codestyle: ok(), errors: [] },
      { ".vscode/settings.json": before },
    );
    const after = diffs.find((d) => d.target === ".vscode/settings.json")!;
    expect(after.before).toBe(before);
    expect(after.after).toContain("a comment the user wrote");
    expect(after.after).toContain('"editor.rulers"');
    expect(after.after).toContain('"java.format.settings.url"');
  });

  it("re-importing the same style produces a diff with no change in it", () => {
    const plan: FullPlan = { codestyle: ok(), errors: [] };
    const first = planDiffs(plan, {});
    const current = Object.fromEntries(first.map((d) => [d.target, d.after]));
    for (const d of planDiffs(plan, current)) expect(d.after).toBe(d.before);
  });

  it("adds a launch.json target only when there are configurations to write", () => {
    const runs = {
      configs: [],
      skipped: [{ name: "x", type: "JUnit", reason: "no class" }],
    };
    expect(planDiffs({ runs, errors: [] }, {})).toEqual([]);
    const one = planDiffs(
      {
        runs: {
          configs: [
            {
              type: "java",
              name: "Run Main",
              request: "launch",
              mainClass: "com.acme.app.Main",
            } as never,
          ],
          skipped: [],
        },
        errors: [],
      },
      {},
    );
    expect(one).toHaveLength(1);
    // launch.json is jsonc: the skeleton carries the editor's own comments.
    expect(javaConfigs(readLaunch(one[0]!.after))[0]).toMatchObject({
      name: "Run Main",
    });
  });
});

describe("RFC 0007 §4.2 — the summary says what was mapped and what was not", () => {
  it("counts per kind and lists every gap by its IDEA name", () => {
    const lines = summary({ codestyle: ok(), errors: [] });
    expect(lines[0]).toMatch(
      /^code style\s+29 of 30 options mapped, from scheme "Project"$/,
    );
    expect(lines).toContain(`  → ${PROFILE_PATH}`);
    expect(lines).toContain("  → java.format.settings.url");
    expect(lines.some((l) => l.startsWith("  - WRAP_LONG_LINES:"))).toBe(true);
  });

  it("names a kind that could not be read, and leaves the others alone", () => {
    const lines = summary({
      codestyle: ok(),
      errors: [{ scope: "runs", reason: "no .idea/runConfigurations" }],
    });
    expect(lines.at(-1)).toBe("! runs: no .idea/runConfigurations");
    expect(lines[0]).toContain("code style");
  });
});

describe("RFC 0007 §4.2 — the settings the import writes survive the manifest round trip", () => {
  it("splits every key it writes the way the remove command rejoins it", () => {
    const plan = ok();
    for (const key of Object.keys(plan.settings)) {
      const { section, leaf } = splitKey(key);
      // `[java]` is a language block: no section, and no leading dot in the
      // manifest key — `Remove BatleHub settings` looks the entry up by it.
      expect(section ? `${section}.${leaf}` : leaf).toBe(key);
      if (key.startsWith("[")) expect(section).toBeUndefined();
      else expect(section).toBeTruthy();
    }
  });
});

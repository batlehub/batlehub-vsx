import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  convertCodeStyle,
  importOrder,
  MAPPING,
  parseProjectXml,
  PROFILE_NAME,
  settings,
  toEclipseProfile,
  unmapped,
  usesPerProjectSettings,
} from "../src/idea/codestyle";

const FIXTURE = path.resolve(
  __dirname,
  "../../../tests/heavy/fixtures/maven-multi/.idea/codeStyles",
);
const projectXml = readFileSync(path.join(FIXTURE, "Project.xml"), "utf8");
const P = "org.eclipse.jdt.core.formatter.";

const style = (options: Record<string, string>) => ({
  name: "Project",
  options,
  layout: [],
});
/** One row of the table, applied on its own. */
const row = (idea: string, value: string, all: Record<string, string> = {}) =>
  MAPPING.find((r) => r.idea === idea)!.to(value, { [idea]: value, ...all });

describe("RFC 0007 §6.2 — Project.xml is read for Java only", () => {
  it("takes the Java block, the JavaCodeStyleSettings and the scheme level", () => {
    const s = parseProjectXml(projectXml);
    expect(s.name).toBe("Project");
    expect(s.options.INDENT_SIZE).toBe("2"); // inside <indentOptions>
    expect(s.options.RIGHT_MARGIN).toBe("120"); // scheme level and Java level
    expect(s.options.CLASS_COUNT_TO_USE_IMPORT_ON_DEMAND).toBe("99"); // JavaCodeStyleSettings
  });

  it("does not take another language's options as Java's", () => {
    const s = parseProjectXml(`
      <component name="ProjectCodeStyleConfiguration">
        <code_scheme name="Project" version="173">
          <codeStyleSettings language="kotlin">
            <indentOptions><option name="INDENT_SIZE" value="8" /></indentOptions>
          </codeStyleSettings>
          <codeStyleSettings language="JAVA">
            <indentOptions><option name="INDENT_SIZE" value="3" /></indentOptions>
          </codeStyleSettings>
        </code_scheme>
      </component>`);
    expect(s.options.INDENT_SIZE).toBe("3");
  });

  it("refuses a document that is not a scheme rather than importing half of one", () => {
    expect(() => parseProjectXml("<component/>")).toThrow(/code_scheme/);
  });

  it("reads codeStyleConfig.xml's USE_PER_PROJECT_SETTINGS (§4.3's hard error)", () => {
    expect(
      usesPerProjectSettings(
        readFileSync(path.join(FIXTURE, "codeStyleConfig.xml"), "utf8"),
      ),
    ).toBe(true);
    expect(
      usesPerProjectSettings(
        '<state><option name="USE_PER_PROJECT_SETTINGS" value="false" /></state>',
      ),
    ).toBe(false);
    expect(usesPerProjectSettings(undefined)).toBeUndefined();
  });
});

describe("RFC 0007 §4.2 — the mapping table, row by row", () => {
  it("indent: spaces take INDENT_SIZE, tabs take TAB_SIZE", () => {
    expect(row("INDENT_SIZE", "2", { USE_TAB_CHARACTER: "false" })).toEqual({
      [`${P}indentation.size`]: "2",
      [`${P}tabulation.size`]: "2",
    });
    expect(
      row("INDENT_SIZE", "2", { USE_TAB_CHARACTER: "true", TAB_SIZE: "8" }),
    ).toEqual({
      [`${P}indentation.size`]: "2",
      [`${P}tabulation.size`]: "8",
    });
    expect(row("USE_TAB_CHARACTER", "true")).toEqual({
      [`${P}tabulation.char`]: "tab",
    });
    expect(row("USE_TAB_CHARACTER", "false")).toEqual({
      [`${P}tabulation.char`]: "space",
    });
  });

  it("continuation indent is columns in IDEA and units in Eclipse", () => {
    expect(
      row("CONTINUATION_INDENT_SIZE", "8", { INDENT_SIZE: "4" }),
    ).toMatchObject({
      [`${P}continuation_indentation`]: "2",
    });
    expect(
      row("CONTINUATION_INDENT_SIZE", "4", { INDENT_SIZE: "2" }),
    ).toMatchObject({
      [`${P}continuation_indentation`]: "2",
    });
    // Never zero: an Eclipse continuation of 0 indents nothing at all.
    expect(
      row("CONTINUATION_INDENT_SIZE", "2", { INDENT_SIZE: "8" }),
    ).toMatchObject({
      [`${P}continuation_indentation`]: "1",
    });
  });

  it("brace styles map by IDEA's constant, and an unknown one is listed", () => {
    expect(row("BRACE_STYLE", "1")).toMatchObject({
      [`${P}brace_position_for_block`]: "end_of_line",
    });
    expect(row("CLASS_BRACE_STYLE", "2")).toMatchObject({
      [`${P}brace_position_for_type_declaration`]: "next_line",
    });
    expect(row("METHOD_BRACE_STYLE", "5")).toMatchObject({
      [`${P}brace_position_for_method_declaration`]: "next_line_on_wrap",
    });
    // NEXT_LINE_SHIFTED2: real in IDEA, absent from Eclipse.
    expect(row("BRACE_STYLE", "4")).toMatch(/no Eclipse equivalent/);
  });

  it("KEEP_LINE_BREAKS is the inverse of join_wrapped_lines", () => {
    expect(row("KEEP_LINE_BREAKS", "true")).toEqual({
      [`${P}join_wrapped_lines`]: "false",
    });
    expect(row("KEEP_LINE_BREAKS", "false")).toEqual({
      [`${P}join_wrapped_lines`]: "true",
    });
  });

  it("one IDEA space flag sets every Eclipse key on the same axis", () => {
    expect(row("SPACE_AROUND_ASSIGNMENT_OPERATORS", "true")).toEqual({
      [`${P}insert_space_before_assignment_operator`]: "insert",
      [`${P}insert_space_after_assignment_operator`]: "insert",
    });
    expect(row("SPACE_WITHIN_IF_PARENTHESES", "false")).toEqual({
      [`${P}insert_space_after_opening_paren_in_if`]: "do not insert",
      [`${P}insert_space_before_closing_paren_in_if`]: "do not insert",
    });
    const commas = row("SPACE_AFTER_COMMA", "true") as Record<string, string>;
    expect(Object.keys(commas).length).toBeGreaterThan(15);
    expect(
      commas[`${P}insert_space_after_comma_in_method_invocation_arguments`],
    ).toBe("insert");
  });

  it("a method's parenthesis rule covers the constructor's too", () => {
    expect(row("SPACE_BEFORE_METHOD_PARENTHESES", "false")).toEqual({
      [`${P}insert_space_before_opening_paren_in_method_declaration`]:
        "do not insert",
      [`${P}insert_space_before_opening_paren_in_constructor_declaration`]:
        "do not insert",
    });
  });

  it("every row of the table produces keys JDT actually has", () => {
    const defaults = new Set(Object.keys(convertCodeStyle(style({})).profile));
    const bogus: string[] = [];
    for (const r of MAPPING) {
      const out = r.to(
        r.idea.startsWith("SPACE_") ||
          r.idea.startsWith("KEEP_") ||
          r.idea.startsWith("ALIGN_") ||
          r.idea === "USE_TAB_CHARACTER"
          ? "true"
          : "2",
        { INDENT_SIZE: "4" },
      );
      if (typeof out === "string") continue;
      for (const k of Object.keys(out))
        if (!defaults.has(k)) bogus.push(`${r.idea} → ${k}`);
    }
    expect(bogus).toEqual([]);
  });
});

describe("RFC 0007 §4.2 — what is not mapped is listed, not approximated", () => {
  it("names the IDEA option and keeps the rest of the kind", () => {
    const c = convertCodeStyle(
      style({
        RIGHT_MARGIN: "120",
        WRAP_LONG_LINES: "true",
        SOME_FUTURE_OPTION: "3",
      }),
    );
    expect(c.mapped).toEqual(["RIGHT_MARGIN"]);
    expect(c.skipped.map((s) => s.option).sort()).toEqual([
      "SOME_FUTURE_OPTION",
      "WRAP_LONG_LINES",
    ]);
    expect(c.profile[`${P}lineSplit`]).toBe("120");
  });

  it("does not report an option that is mapped into a setting as a gap", () => {
    expect(
      unmapped({ CLASS_COUNT_TO_USE_IMPORT_ON_DEMAND: "99", TAB_SIZE: "4" }),
    ).toEqual([]);
  });
});

describe("RFC 0007 §6.2 — the profile is written complete", () => {
  it("carries JDT's defaults so a later redhat.java cannot move the format", () => {
    const c = convertCodeStyle(parseProjectXml(projectXml));
    // The mapped values are a few dozen; the file is JDT's whole option set.
    expect(Object.keys(c.profile).length).toBeGreaterThan(300);
    expect(c.profile[`${P}indentation.size`]).toBe("2");
    const xml = toEclipseProfile(c.profile, PROFILE_NAME);
    expect(xml).toContain(
      `<profile kind="CodeFormatterProfile" name="${PROFILE_NAME}"`,
    );
    expect(xml).toContain(`<setting id="${P}lineSplit" value="120"/>`);
    // Sorted, so a re-import produces a diff of what changed and nothing else.
    const ids = [...xml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids).toEqual([...ids].sort());
  });

  it("escapes what XML cannot carry raw", () => {
    expect(toEclipseProfile({ "a&b": '<"x">' }, 'P & "Q"')).toContain(
      '<setting id="a&amp;b" value="&lt;&quot;x&quot;&gt;"/>',
    );
  });
});

describe("RFC 0007 §4.2 — the import layout and the settings", () => {
  it("turns IDEA's layout table into java.completion.importOrder, # for static", () => {
    const s = parseProjectXml(projectXml);
    expect(importOrder(s.layout)).toEqual([
      "java",
      "javax",
      "org",
      "com",
      "",
      "#",
    ]);
  });

  it("writes only the keys redhat.java reads itself", () => {
    const s = parseProjectXml(projectXml);
    expect(settings(s, PROFILE_NAME)).toEqual({
      "java.format.settings.url": ".vscode/batlehub-java/formatter.xml",
      "java.format.settings.profile": PROFILE_NAME,
      "java.completion.importOrder": ["java", "javax", "org", "com", "", "#"],
      "java.sources.organizeImports.starThreshold": 99,
      "java.sources.organizeImports.staticStarThreshold": 5,
      "[java]": {
        "editor.tabSize": 2,
        "editor.insertSpaces": true,
        "editor.detectIndentation": false,
      },
    });
  });

  it("a tab-indented style reports the tab width, not the indent width", () => {
    const s = style({
      INDENT_SIZE: "2",
      TAB_SIZE: "8",
      USE_TAB_CHARACTER: "true",
    });
    expect(settings(s, PROFILE_NAME)["[java]"]).toEqual({
      "editor.tabSize": 8,
      "editor.insertSpaces": false,
      "editor.detectIndentation": false,
    });
  });
});

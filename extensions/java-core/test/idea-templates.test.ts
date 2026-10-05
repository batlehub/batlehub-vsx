import { mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type FullPlan,
  outsideWorkspace,
  planDiffs,
  planFileTemplates,
  planLiveTemplates,
  readIdeaConfigDir,
  summary,
} from "../src/idea/import";
import {
  fileHeader,
  fileTemplateSnippet,
  parseLiveTemplates,
  snippetsFile,
  toSnippet,
} from "../src/idea/templates";

const set = (...templates: string[]) =>
  `<templateSet group="user">\n${templates.join("\n")}\n</templateSet>`;

const one = (xml: string) => parseLiveTemplates(set(xml))[0]!;
const converted = (xml: string) => {
  const r = toSnippet(one(xml));
  if ("skipped" in r) throw new Error(`skipped: ${r.skipped.reason}`);
  return r;
};

const SOUT = `  <template name="sout" value="System.out.println($END$);" description="Prints a string to System.out" toReformat="true" toShortenFQNames="true">
    <context><option name="JAVA_STATEMENT" value="true" /></context>
  </template>`;

const FORI = `  <template name="fori" value="for (int $INDEX$ = 0; $INDEX$ &lt; $LIMIT$; $INDEX$++) {&#10;  $END$&#10;}" description="Iterate" toReformat="true">
    <variable name="INDEX" expression="suggestIndexName()" defaultValue="i" alwaysStopAt="true" />
    <variable name="LIMIT" expression="" defaultValue="" alwaysStopAt="true" />
    <context><option name="JAVA_STATEMENT" value="true" /></context>
  </template>`;

const ITER = `  <template name="iter" value="for ($ELEMENT_TYPE$ $VAR$ : $ITERABLE$) {&#10;  $END$&#10;}" description="Iterate over">
    <variable name="ITERABLE" expression="iterableVariable()" defaultValue="" alwaysStopAt="true" />
    <variable name="ELEMENT_TYPE" expression="iterableComponentType(ITERABLE)" defaultValue="&quot;java.lang.Object&quot;" alwaysStopAt="false" />
    <variable name="VAR" expression="suggestVariableName()" defaultValue="" alwaysStopAt="true" />
    <context><option name="JAVA_STATEMENT" value="true" /></context>
  </template>`;

describe("RFC 0007 §4.2 — live templates become snippets, or are listed", () => {
  it("reads name, value, description, context and variables", () => {
    const t = parseLiveTemplates(set(SOUT, FORI));
    expect(t.map((x) => x.name)).toEqual(["sout", "fori"]);
    expect(t[0]!.description).toBe("Prints a string to System.out");
    expect(t[0]!.contexts).toEqual(["JAVA_STATEMENT"]);
    expect(t[1]!.variables).toEqual([
      { name: "INDEX", expression: "suggestIndexName()", default: "i" },
      { name: "LIMIT", expression: "", default: "" },
    ]);
  });

  it("$END$ is the final tab stop", () => {
    expect(converted(SOUT).snippet.body).toEqual(["System.out.println($0);"]);
  });

  it("numbers tab stops in order of first appearance and repeats the stop", () => {
    const { snippet } = converted(FORI);
    expect(snippet.body).toEqual([
      "for (int ${1:i} = 0; ${1:i} < $2; ${1:i}++) {",
      "  $0",
      "}",
    ]);
  });

  it("lists an expression it cannot evaluate, and still ships the template", () => {
    const { snippet, notes } = converted(ITER);
    // `iterableComponentType` has a literal default, so it needs no note; the
    // two that are listed are listed in the order they appear in the text,
    // which is the order the tab stops are numbered in.
    expect(notes.map((n) => n.option)).toEqual([
      "iter → $VAR$",
      "iter → $ITERABLE$",
    ]);
    expect(notes[1]!.reason).toContain("iterableVariable()");
    expect(snippet.body[0]).toBe("for (${1:java.lang.Object} $2 : $3) {");
  });

  it("maps the expressions a snippet can answer", () => {
    const { snippet, notes } = converted(
      `<template name="cls" value="$C$ $D$">
         <variable name="C" expression="className()" defaultValue="" />
         <variable name="D" expression="date()" defaultValue="" />
         <context><option name="JAVA_CODE" value="true" /></context>
       </template>`,
    );
    expect(snippet.body).toEqual([
      "$TM_FILENAME_BASE $CURRENT_YEAR-$CURRENT_MONTH-$CURRENT_DATE",
    ]);
    expect(notes).toEqual([]);
  });

  it("$SELECTION$ is the surround-with variable", () => {
    expect(
      converted(
        `<template name="rt" value="try {&#10;  $SELECTION$&#10;}"><context><option name="JAVA_STATEMENT" value="true" /></context></template>`,
      ).snippet.body,
    ).toEqual(["try {", "  $TM_SELECTED_TEXT", "}"]);
  });

  it("escapes what the editor would read as syntax, and honours IDEA's $$", () => {
    // `$$` is IDEA's literal dollar; `}` and `\` are the editor's syntax.
    expect(
      converted(
        `<template name="lit" value="$$x = &quot;a}b\\c&quot;; $V$"><variable name="V" expression="" defaultValue="" /><context><option name="JAVA_CODE" value="true" /></context></template>`,
      ).snippet.body,
    ).toEqual(['\\$x = "a}b\\\\c"; $1']);
  });

  it("a placeholder that contains syntax is escaped, not executed", () => {
    expect(
      converted(
        `<template name="p" value="$V$"><variable name="V" expression="" defaultValue="a}b" /><context><option name="JAVA_CODE" value="true" /></context></template>`,
      ).snippet.body,
    ).toEqual(["${1:a\\}b}"]);
  });

  it("skips a template whose context is not Java, with the reason", () => {
    const r = toSnippet(
      one(
        `<template name="div" value="&lt;div&gt;$END$&lt;/div&gt;"><context><option name="HTML_TEXT" value="true" /></context></template>`,
      ),
    );
    expect(r).toMatchObject({
      skipped: { option: "div", reason: expect.stringContaining("HTML_TEXT") },
    });
  });

  it("keeps a template with no context at all — IDEA offers it everywhere", () => {
    expect(
      converted(`<template name="x" value="y$END$" />`).snippet.scope,
    ).toBe("java");
  });
});

describe("RFC 0007 §4.2 — the file header is JDT's template language", () => {
  it("maps IDEA's variables onto JDT's", () => {
    const { lines, notes } = fileHeader(
      "/*\n * Copyright ${YEAR} ACME. Written by ${USER}.\n */\n",
    );
    expect(lines).toEqual([
      "/*",
      " * Copyright ${year} ACME. Written by ${user}.",
      " */",
    ]);
    expect(notes).toEqual([]);
  });

  it("drops a variable JDT has no counterpart for, and says so", () => {
    const { lines, notes } = fileHeader("// ${PROJECT_NAME} ${YEAR}\n");
    // The space the dropped variable sat in stays: a header is the team's own
    // text, and tidying whitespace here would tidy an ASCII-art banner too.
    expect(lines).toEqual(["//  ${year}"]);
    expect(notes[0]).toMatchObject({
      option: "File Header.java → ${PROJECT_NAME}",
    });
  });
});

describe("RFC 0007 decision 15 — a file template is a snippet without the package line", () => {
  const CLASS = `#if (\${PACKAGE_NAME} && \${PACKAGE_NAME} != "")package \${PACKAGE_NAME};#end
#parse("File Header.java")
public class \${NAME} {
}
`;

  it("drops the package line and lists why", () => {
    const { snippet, notes } = fileTemplateSnippet(
      "Class",
      CLASS.replace('#parse("File Header.java")\n', ""),
    );
    expect(snippet.prefix).toBe("file:Class");
    expect(snippet.body).toEqual(["public class $TM_FILENAME_BASE {", "}"]);
    expect(notes.map((n) => n.option)).toEqual([
      "Class.java → ${PACKAGE_NAME}",
    ]);
    expect(notes[0]!.reason).toContain("cannot know the package");
  });

  it("lists any other Velocity directive rather than shipping it as text", () => {
    const { snippet, notes } = fileTemplateSnippet(
      "Class",
      `#set($x = 1)\npublic class \${NAME} {}\n`,
    );
    expect(snippet.body).toEqual(["public class $TM_FILENAME_BASE {}"]);
    expect(notes[0]!.reason).toContain("Velocity");
  });

  it("keeps an unknown variable as a named tab stop", () => {
    const { snippet, notes } = fileTemplateSnippet(
      "Class",
      "// ${PROJECT_NAME}\nclass ${NAME} {}\n",
    );
    expect(snippet.body).toEqual([
      "// ${1:PROJECT_NAME}",
      "class $TM_FILENAME_BASE {}",
    ]);
    expect(notes).toHaveLength(1);
  });
});

describe("the snippets file", () => {
  it("is sorted by prefix, so a re-import diffs line for line", () => {
    const parsed = JSON.parse(
      snippetsFile([converted(FORI).snippet, converted(SOUT).snippet]),
    );
    expect(Object.keys(parsed)).toEqual(["fori", "sout"]);
    expect(parsed.sout.scope).toBe("java");
  });
});

describe("RFC 0007 §6.1 — the plan, where the two kinds meet", () => {
  const CLASS_WITH_HEADER =
    '#if (${PACKAGE_NAME} && ${PACKAGE_NAME} != "")package ${PACKAGE_NAME};#end\n' +
    '#parse("File Header.java")\n' +
    "public class ${NAME} {\n}\n";

  it("expands the header include into the snippet — a snippet has no #parse", () => {
    const plan = planFileTemplates("// (c) ${YEAR} ACME", [
      { name: "Class", text: CLASS_WITH_HEADER },
    ]);
    expect(plan.snippets[0]!.body).toEqual([
      "// (c) $CURRENT_YEAR ACME",
      "public class $TM_FILENAME_BASE {",
      "}",
    ]);
    expect(plan.settings).toEqual({
      "java.templates.fileHeader": ["// (c) ${year} ACME"],
    });
  });

  it("puts both kinds in one snippets file and one settings diff", () => {
    const plan: FullPlan = {
      errors: [],
      livetemplates: planLiveTemplates([{ name: "user", xml: set(SOUT) }]),
      filetemplates: planFileTemplates("// h", [
        { name: "Class", text: "class ${NAME} {}" },
      ]),
    };
    const diffs = planDiffs(plan, {});
    expect(diffs.map((d) => d.target)).toEqual([
      ".vscode/intellij.code-snippets",
      ".vscode/settings.json",
    ]);
    expect(Object.keys(JSON.parse(diffs[0]!.after))).toEqual([
      "file:Class",
      "sout",
    ]);
    expect(JSON.parse(diffs[1]!.after)).toEqual({
      "java.templates.fileHeader": ["// h"],
    });
  });

  it("says in the report where the templates were read from", () => {
    const plan: FullPlan = {
      errors: [],
      livetemplates: planLiveTemplates(
        [{ name: "user", xml: set(SOUT) }],
        "IntelliJIdea2026.1",
      ),
    };
    expect(summary(plan)).toContain(
      "live templates       1 imported, from IntelliJIdea2026.1",
    );
  });
});

describe("RFC 0007 §4.3 — a configuration directory inside the workspace is refused", () => {
  it("refuses the workspace folder itself and anything under it", () => {
    expect(outsideWorkspace("/w/.idea/templates", ["/w"])).toBe(false);
    expect(outsideWorkspace("/w", ["/w"])).toBe(false);
    expect(outsideWorkspace("/home/u/.config/JetBrains/X", ["/w"])).toBe(true);
    // A sibling whose path merely starts with the folder's is not inside it.
    expect(outsideWorkspace("/workspace-copy", ["/work"])).toBe(true);
  });
});

describe("RFC 0007 §4.2 — where the IDEA configuration directory is", () => {
  const home = mkdtempSync(path.join(tmpdir(), "idea-cfg-"));
  const product = (root: string, name: string) => {
    const dir = path.join(root, "JetBrains", name);
    mkdirSync(path.join(dir, "templates"), { recursive: true });
    return dir;
  };

  it("takes the newest product directory that actually holds templates/", () => {
    const root = path.join(home, "a", ".config");
    const old = product(root, "IntelliJIdea2025.1");
    const recent = product(root, "IntelliJIdea2026.1");
    // A product with no templates/ is not a candidate however new it is.
    mkdirSync(path.join(root, "JetBrains", "DataGrip2026.2"), {
      recursive: true,
    });
    utimesSync(old, new Date(1), new Date(1));
    utimesSync(recent, new Date(2000), new Date(2000));
    expect(readIdeaConfigDir(path.join(home, "a"), "linux")).toBe(recent);
  });

  it("honours XDG_CONFIG_HOME, which is where IDEA itself looks on Linux", () => {
    const xdg = path.join(home, "b", "elsewhere");
    const dir = product(xdg, "IntelliJIdea2026.1");
    expect(
      readIdeaConfigDir(path.join(home, "b"), "linux", {
        XDG_CONFIG_HOME: xdg,
      }),
    ).toBe(dir);
  });

  it("is undefined when the machine has no IDEA at all — a Che pod", () => {
    expect(
      readIdeaConfigDir(path.join(home, "empty"), "linux"),
    ).toBeUndefined();
  });
});

describe("a snippet variable the editor does not have is a tab stop, not a guess", () => {
  it("does not invent $CURRENT_USER — the editor would write the word", () => {
    const { snippet, notes } = fileTemplateSnippet(
      "Class",
      "// ${YEAR} by ${USER}\nclass ${NAME} {}\n",
    );
    expect(snippet.body[0]).toBe("// $CURRENT_YEAR by ${1:USER}");
    expect(notes.map((n) => n.option)).toEqual(["Class.java → ${USER}"]);
  });
});

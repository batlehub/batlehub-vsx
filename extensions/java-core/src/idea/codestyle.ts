// IDEA's `.idea/codeStyles/Project.xml` → an Eclipse formatter profile plus
// the handful of settings `redhat.java` reads (RFC 0007 §6.2). Pure: it
// parses a string and returns strings, writes nothing, and never looks at
// `.idea/` itself — `import.ts` does the reading and the writing.
//
// Two rules the shape follows from:
//   - the profile is written *complete* — JDT's own defaults overlaid with
//     what was mapped — so a later redhat.java changing a default cannot
//     move a team's format behind their back (§4.2);
//   - an option that has no Eclipse counterpart is *listed*, never
//     approximated. `skipped` is part of the result, not a log line.
import DEFAULTS from "./eclipse-defaults.json";

const P = "org.eclipse.jdt.core.formatter.";

export interface Skipped {
  option: string;
  reason: string;
}

export interface CodeStyle {
  /** Every `<option name value>` that applies to Java, flattened. */
  options: Record<string, string>;
  /** `<package>`/`<emptyLine>` rows of IMPORT_LAYOUT_TABLE, in order. */
  layout: ImportRow[];
  /** `codeStyleConfig.xml`'s `USE_PER_PROJECT_SETTINGS`; undefined when absent. */
  perProject?: boolean;
  /** The scheme's name, for the profile's name and the report. */
  name: string;
}

export type ImportRow =
  { kind: "package"; name: string; static: boolean } | { kind: "emptyLine" };

const options = (xml: string): Record<string, string> =>
  Object.fromEntries(
    [...xml.matchAll(/<option\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>/g)].map(
      (m) => [m[1]!, m[2]!],
    ),
  );

/**
 * The Java options of a scheme. A `Project.xml` holds one block per language
 * and a few scheme-level options above them; reading the whole document would
 * take another language's `INDENT_SIZE` as Java's, so the blocks are taken
 * apart and merged most-specific last.
 */
export function parseProjectXml(xml: string): CodeStyle {
  const scheme = /<code_scheme\b[^>]*>[\s\S]*<\/code_scheme>/.exec(xml)?.[0];
  if (!scheme) throw new Error("no <code_scheme> element");
  const name =
    /<code_scheme\b[^>]*\bname="([^"]*)"/.exec(scheme)?.[1] ?? "Project";
  const java =
    /<codeStyleSettings\s+language="JAVA"[^>]*>[\s\S]*?<\/codeStyleSettings>/.exec(
      scheme,
    )?.[0] ?? "";
  const javaStyle =
    /<JavaCodeStyleSettings\b[^>]*>[\s\S]*?<\/JavaCodeStyleSettings>/.exec(
      scheme,
    )?.[0] ?? "";
  // What is left once every language block is removed: the scheme-level
  // options (RIGHT_MARGIN is commonly only here).
  const general = scheme
    .replace(/<codeStyleSettings\b[^>]*>[\s\S]*?<\/codeStyleSettings>/g, "")
    .replace(
      /<JavaCodeStyleSettings\b[^>]*>[\s\S]*?<\/JavaCodeStyleSettings>/g,
      "",
    );
  return {
    name,
    options: { ...options(general), ...options(javaStyle), ...options(java) },
    layout: importLayout(javaStyle),
    perProject: undefined,
  };
}

/** `codeStyleConfig.xml` — IDEA ignores the project style when this is false, and so must we (§4.3). */
export function usesPerProjectSettings(
  xml: string | undefined,
): boolean | undefined {
  if (xml === undefined) return undefined;
  const v = /<option\s+name="USE_PER_PROJECT_SETTINGS"\s+value="([^"]*)"/.exec(
    xml,
  )?.[1];
  return v === undefined ? undefined : v === "true";
}

function importLayout(xml: string): ImportRow[] {
  const table =
    /<option\s+name="IMPORT_LAYOUT_TABLE"\s*>([\s\S]*?)<\/option>/.exec(
      xml,
    )?.[1];
  if (!table) return [];
  return [...table.matchAll(/<(package|emptyLine)\b([^>]*)\/>/g)].map((m) =>
    m[1] === "emptyLine"
      ? { kind: "emptyLine" as const }
      : {
          kind: "package" as const,
          name: /\bname="([^"]*)"/.exec(m[2]!)?.[1] ?? "",
          static: /\bstatic="true"/.test(m[2]!),
        },
  );
}

// --- the table -------------------------------------------------------------
// One row per IDEA option (§4.2). `to` returns the Eclipse pairs it produces,
// or a reason string when this particular *value* has no counterpart — the
// difference between "we do not map this option" (absent from the table) and
// "we map the option but not this setting of it" matters to the report.
export interface Row {
  idea: string;
  /** For the report and the guide: the Eclipse keys (without the prefix) or setting this row feeds. */
  eclipse: string[];
  to(
    value: string,
    all: Record<string, string>,
  ): Record<string, string> | string;
}

const bool = (v: string) => v === "true";
const insert = (on: boolean) => (on ? "insert" : "do not insert");
/** Every Eclipse `insert_space_*` key of one axis, set from one IDEA flag. */
const spaces = (on: boolean, ...keys: string[]) =>
  Object.fromEntries(keys.map((k) => [P + k, insert(on)]));

// IDEA's brace constants (CommonCodeStyleSettings).
const BRACES: Record<string, string> = {
  "1": "end_of_line",
  "2": "next_line",
  "3": "next_line_shifted",
  "5": "next_line_on_wrap",
};

/** The `insert_space_{before,after}_comma_in_*` families, which IDEA holds as one flag each. */
const COMMA_CONTEXTS = [
  "allocation_expression",
  "annotation",
  "array_initializer",
  "constructor_declaration_parameters",
  "constructor_declaration_throws",
  "enum_constant_arguments",
  "enum_declarations",
  "explicitconstructorcall_arguments",
  "for_increments",
  "for_inits",
  "method_declaration_parameters",
  "method_declaration_throws",
  "method_invocation_arguments",
  "multiple_field_declarations",
  "multiple_local_declarations",
  "parameterized_type_reference",
  "superinterfaces",
  "type_arguments",
  "type_parameters",
];

const parens = (on: boolean, ctx: string) =>
  spaces(
    on,
    `insert_space_after_opening_paren_in_${ctx}`,
    `insert_space_before_closing_paren_in_${ctx}`,
  );

export const MAPPING: Row[] = [
  {
    idea: "INDENT_SIZE",
    eclipse: ["tabulation.size", "indentation.size"],
    to: (v, all) => ({
      [`${P}indentation.size`]: v,
      // With spaces, Eclipse indents by `tabulation.size`; only when the file
      // really uses tabs does TAB_SIZE become the one that matters.
      [`${P}tabulation.size`]: bool(all.USE_TAB_CHARACTER ?? "false")
        ? (all.TAB_SIZE ?? v)
        : v,
    }),
  },
  {
    idea: "USE_TAB_CHARACTER",
    eclipse: ["tabulation.char"],
    to: (v) => ({ [`${P}tabulation.char`]: bool(v) ? "tab" : "space" }),
  },
  {
    idea: "CONTINUATION_INDENT_SIZE",
    eclipse: ["continuation_indentation"],
    // Eclipse counts continuations in indentation *units*, IDEA in columns.
    to: (v, all) => {
      const unit = Number(all.INDENT_SIZE ?? "4");
      const n = Number(v);
      if (!unit || !Number.isFinite(n)) return "not a number";
      const units = Math.max(1, Math.round(n / unit));
      return {
        [`${P}continuation_indentation`]: String(units),
        [`${P}continuation_indentation_for_array_initializer`]: String(units),
      };
    },
  },
  {
    idea: "RIGHT_MARGIN",
    eclipse: ["lineSplit"],
    to: (v) => ({ [`${P}lineSplit`]: v }),
  },
  {
    idea: "BRACE_STYLE",
    eclipse: ["brace_position_for_block"],
    to: (v) =>
      BRACES[v]
        ? {
            [`${P}brace_position_for_block`]: BRACES[v]!,
            [`${P}brace_position_for_block_in_case`]: BRACES[v]!,
          }
        : `IDEA brace style ${v} has no Eclipse equivalent`,
  },
  {
    idea: "CLASS_BRACE_STYLE",
    eclipse: ["brace_position_for_type_declaration"],
    to: (v) =>
      BRACES[v]
        ? {
            [`${P}brace_position_for_type_declaration`]: BRACES[v]!,
            [`${P}brace_position_for_enum_declaration`]: BRACES[v]!,
            [`${P}brace_position_for_annotation_type_declaration`]: BRACES[v]!,
            [`${P}brace_position_for_record_declaration`]: BRACES[v]!,
          }
        : `IDEA brace style ${v} has no Eclipse equivalent`,
  },
  {
    idea: "METHOD_BRACE_STYLE",
    eclipse: ["brace_position_for_method_declaration"],
    to: (v) =>
      BRACES[v]
        ? {
            [`${P}brace_position_for_method_declaration`]: BRACES[v]!,
            [`${P}brace_position_for_constructor_declaration`]: BRACES[v]!,
            [`${P}brace_position_for_lambda_body`]: BRACES[v]!,
          }
        : `IDEA brace style ${v} has no Eclipse equivalent`,
  },
  {
    idea: "BLANK_LINES_BEFORE_PACKAGE",
    eclipse: ["blank_lines_before_package"],
    to: (v) => ({ [`${P}blank_lines_before_package`]: v }),
  },
  {
    idea: "BLANK_LINES_AFTER_PACKAGE",
    eclipse: ["blank_lines_after_package"],
    to: (v) => ({ [`${P}blank_lines_after_package`]: v }),
  },
  {
    idea: "BLANK_LINES_BEFORE_IMPORTS",
    eclipse: ["blank_lines_before_imports"],
    to: (v) => ({ [`${P}blank_lines_before_imports`]: v }),
  },
  {
    idea: "BLANK_LINES_AFTER_IMPORTS",
    eclipse: ["blank_lines_after_imports"],
    to: (v) => ({ [`${P}blank_lines_after_imports`]: v }),
  },
  {
    idea: "BLANK_LINES_AROUND_CLASS",
    eclipse: ["blank_lines_before_member_type"],
    to: (v) => ({ [`${P}blank_lines_before_member_type`]: v }),
  },
  {
    idea: "BLANK_LINES_AROUND_METHOD",
    eclipse: ["blank_lines_before_method"],
    to: (v) => ({ [`${P}blank_lines_before_method`]: v }),
  },
  {
    idea: "BLANK_LINES_AROUND_FIELD",
    eclipse: ["blank_lines_before_field"],
    to: (v) => ({ [`${P}blank_lines_before_field`]: v }),
  },
  {
    idea: "BLANK_LINES_AROUND_METHOD_IN_INTERFACE",
    eclipse: ["blank_lines_before_abstract_method"],
    to: (v) => ({ [`${P}blank_lines_before_abstract_method`]: v }),
  },
  {
    idea: "KEEP_LINE_BREAKS",
    eclipse: ["join_wrapped_lines"],
    // Inverse: keeping the author's breaks means not joining them.
    to: (v) => ({ [`${P}join_wrapped_lines`]: bool(v) ? "false" : "true" }),
  },
  {
    idea: "KEEP_BLANK_LINES_IN_CODE",
    eclipse: ["number_of_empty_lines_to_preserve"],
    to: (v) => ({ [`${P}number_of_empty_lines_to_preserve`]: v }),
  },
  // --- spaces before the parenthesis of a construct
  ...(
    [
      [
        "SPACE_BEFORE_METHOD_PARENTHESES",
        "method_declaration",
        ["constructor_declaration"],
      ],
      ["SPACE_BEFORE_METHOD_CALL_PARENTHESES", "method_invocation", []],
      ["SPACE_BEFORE_IF_PARENTHESES", "if", []],
      ["SPACE_BEFORE_FOR_PARENTHESES", "for", []],
      ["SPACE_BEFORE_WHILE_PARENTHESES", "while", []],
      ["SPACE_BEFORE_SWITCH_PARENTHESES", "switch", []],
      ["SPACE_BEFORE_TRY_PARENTHESES", "try", []],
      ["SPACE_BEFORE_CATCH_PARENTHESES", "catch", []],
      ["SPACE_BEFORE_SYNCHRONIZED_PARENTHESES", "synchronized", []],
    ] as [string, string, string[]][]
  ).map(([idea, ctx, also]) => ({
    idea,
    eclipse: [`insert_space_before_opening_paren_in_${ctx}`],
    to: (v: string) =>
      spaces(
        bool(v),
        ...[ctx, ...also].map(
          (c) => `insert_space_before_opening_paren_in_${c}`,
        ),
      ),
  })),
  // --- spaces inside the parentheses of a construct
  ...(
    [
      ["SPACE_WITHIN_METHOD_PARENTHESES", "method_declaration"],
      ["SPACE_WITHIN_METHOD_CALL_PARENTHESES", "method_invocation"],
      ["SPACE_WITHIN_IF_PARENTHESES", "if"],
      ["SPACE_WITHIN_FOR_PARENTHESES", "for"],
      ["SPACE_WITHIN_WHILE_PARENTHESES", "while"],
      ["SPACE_WITHIN_SWITCH_PARENTHESES", "switch"],
      ["SPACE_WITHIN_CATCH_PARENTHESES", "catch"],
    ] as [string, string][]
  ).map(([idea, ctx]) => ({
    idea,
    eclipse: [`insert_space_after_opening_paren_in_${ctx}`],
    to: (v: string) => parens(bool(v), ctx),
  })),
  // --- spaces around operators
  ...(
    [
      ["SPACE_AROUND_ASSIGNMENT_OPERATORS", "assignment_operator"],
      ["SPACE_AROUND_LOGICAL_OPERATORS", "logical_operator"],
      // Eclipse has no equality axis of its own: `==` is a relational
      // operator to JDT, and `+` on strings an additive one. Two IDEA options
      // therefore land on one Eclipse key; when a scheme sets them apart, the
      // collision is reported rather than resolved by whichever came last.
      ["SPACE_AROUND_EQUALITY_OPERATORS", "relational_operator"],
      ["SPACE_AROUND_RELATIONAL_OPERATORS", "relational_operator"],
      ["SPACE_AROUND_BITWISE_OPERATORS", "bitwise_operator"],
      ["SPACE_AROUND_ADDITIVE_OPERATORS", "additive_operator"],
      ["SPACE_AROUND_MULTIPLICATIVE_OPERATORS", "multiplicative_operator"],
      ["SPACE_AROUND_SHIFT_OPERATORS", "shift_operator"],
      ["SPACE_AROUND_STRING_CONCATENATION_OPERATORS", "additive_operator"],
    ] as [string, string][]
  ).map(([idea, op]) => ({
    idea,
    eclipse: [`insert_space_before_${op}`, `insert_space_after_${op}`],
    to: (v: string) =>
      spaces(bool(v), `insert_space_before_${op}`, `insert_space_after_${op}`),
  })),
  {
    idea: "SPACE_AFTER_COMMA",
    eclipse: ["insert_space_after_comma_in_*"],
    to: (v) =>
      spaces(
        bool(v),
        ...COMMA_CONTEXTS.map((c) => `insert_space_after_comma_in_${c}`),
      ),
  },
  {
    idea: "SPACE_BEFORE_COMMA",
    eclipse: ["insert_space_before_comma_in_*"],
    to: (v) =>
      spaces(
        bool(v),
        ...COMMA_CONTEXTS.map((c) => `insert_space_before_comma_in_${c}`),
      ),
  },
  {
    idea: "SPACE_BEFORE_SEMICOLON",
    eclipse: ["insert_space_before_semicolon"],
    to: (v) =>
      spaces(
        bool(v),
        "insert_space_before_semicolon",
        "insert_space_before_semicolon_in_try_resources",
      ),
  },
  {
    idea: "SPACE_AFTER_TYPE_CAST",
    eclipse: ["insert_space_after_closing_paren_in_cast"],
    to: (v) => spaces(bool(v), "insert_space_after_closing_paren_in_cast"),
  },
  {
    idea: "SPACE_BEFORE_CLASS_LBRACE",
    eclipse: ["insert_space_before_opening_brace_in_type_declaration"],
    to: (v) =>
      spaces(
        bool(v),
        "insert_space_before_opening_brace_in_type_declaration",
        "insert_space_before_opening_brace_in_enum_declaration",
        "insert_space_before_opening_brace_in_annotation_type_declaration",
      ),
  },
  {
    idea: "SPACE_BEFORE_METHOD_LBRACE",
    eclipse: ["insert_space_before_opening_brace_in_method_declaration"],
    to: (v) =>
      spaces(
        bool(v),
        "insert_space_before_opening_brace_in_method_declaration",
        "insert_space_before_opening_brace_in_constructor_declaration",
      ),
  },
  {
    idea: "SPACE_BEFORE_IF_LBRACE",
    eclipse: ["insert_space_before_opening_brace_in_block"],
    to: (v) => spaces(bool(v), "insert_space_before_opening_brace_in_block"),
  },
  {
    idea: "SPACE_BEFORE_QUEST",
    eclipse: ["insert_space_before_question_in_conditional"],
    to: (v) => spaces(bool(v), "insert_space_before_question_in_conditional"),
  },
  {
    idea: "SPACE_AFTER_QUEST",
    eclipse: ["insert_space_after_question_in_conditional"],
    to: (v) => spaces(bool(v), "insert_space_after_question_in_conditional"),
  },
  {
    idea: "SPACE_BEFORE_COLON",
    eclipse: ["insert_space_before_colon_in_conditional"],
    to: (v) =>
      spaces(
        bool(v),
        "insert_space_before_colon_in_conditional",
        "insert_space_before_colon_in_for",
      ),
  },
  {
    idea: "SPACE_AFTER_COLON",
    eclipse: ["insert_space_after_colon_in_conditional"],
    to: (v) =>
      spaces(
        bool(v),
        "insert_space_after_colon_in_conditional",
        "insert_space_after_colon_in_for",
      ),
  },
  // --- the wrapping axes Eclipse shares (§4.2: partial, the rest listed)
  {
    idea: "ALIGN_MULTILINE_PARAMETERS",
    eclipse: ["alignment_for_parameters_in_method_declaration"],
    // M_COMPACT_SPLIT (16) | M_INDENT_ON_COLUMN (2) when IDEA aligns.
    to: (v) => ({
      [`${P}alignment_for_parameters_in_method_declaration`]: bool(v)
        ? "18"
        : "16",
      [`${P}alignment_for_parameters_in_constructor_declaration`]: bool(v)
        ? "18"
        : "16",
    }),
  },
  {
    idea: "ALIGN_MULTILINE_PARAMETERS_IN_CALLS",
    eclipse: ["alignment_for_arguments_in_method_invocation"],
    to: (v) => ({
      [`${P}alignment_for_arguments_in_method_invocation`]: bool(v)
        ? "18"
        : "16",
    }),
  },
];

const BY_NAME = new Map(MAPPING.map((r) => [r.idea, r]));

/** The IDEA options this build knows nothing about, for the report's `-` lines. */
export function unmapped(options: Record<string, string>): Skipped[] {
  return Object.keys(options)
    .filter((k) => !BY_NAME.has(k) && !SETTING_ONLY.has(k) && !IGNORED.has(k))
    .sort()
    .map((option) => ({ option, reason: "no Eclipse formatter counterpart" }));
}

/** Options that are real, mapped, but land in a VS Code setting rather than the profile. */
const SETTING_ONLY = new Set([
  "CLASS_COUNT_TO_USE_IMPORT_ON_DEMAND",
  "NAMES_COUNT_TO_USE_IMPORT_ON_DEMAND",
  "TAB_SIZE",
]);

/** Bookkeeping IDEA writes into every scheme; not a style choice, so not a gap. */
const IGNORED = new Set(["USE_PER_PROJECT_SETTINGS", "version"]);

export interface Converted {
  /** The complete Eclipse option map: JDT's defaults overlaid with what mapped. */
  profile: Record<string, string>;
  mapped: string[];
  skipped: Skipped[];
  /** How many rows of the table the scheme actually exercised, for the summary line. */
  total: number;
}

export function convertCodeStyle(style: CodeStyle): Converted {
  const profile: Record<string, string> = {
    ...(DEFAULTS as Record<string, string>),
  };
  const mapped: string[] = [];
  const skipped: Skipped[] = [...unmapped(style.options)];
  /** Which IDEA option last wrote each Eclipse key, so a collision can name both. */
  const owner = new Map<string, { option: string; value: string }>();
  for (const [name, value] of Object.entries(style.options)) {
    const row = BY_NAME.get(name);
    if (!row) continue;
    const out = row.to(value, style.options);
    if (typeof out === "string") {
      skipped.push({ option: name, reason: out });
      continue;
    }
    for (const [key, v] of Object.entries(out)) {
      const had = owner.get(key);
      if (had && had.value !== v)
        skipped.push({
          option: name,
          reason: `${key.slice(P.length)} is also ${had.option}'s, which set it to "${had.value}" — Eclipse has one option where IDEA has two, so ${had.option} wins`,
        });
      else owner.set(key, { option: name, value: v });
    }
    Object.assign(profile, out);
    mapped.push(name);
  }
  return {
    profile,
    mapped: mapped.sort(),
    skipped,
    total: mapped.length + skipped.length,
  };
}

const xmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** The file `java.format.settings.url` points at. Complete, sorted, so a re-import diffs cleanly. */
export function toEclipseProfile(
  profile: Record<string, string>,
  name: string,
): string {
  const rows = Object.keys(profile)
    .sort()
    .map(
      (k) =>
        `      <setting id="${xmlEscape(k)}" value="${xmlEscape(profile[k]!)}"/>`,
    )
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<profiles version="23">',
    `  <profile kind="CodeFormatterProfile" name="${xmlEscape(name)}" version="23">`,
    rows,
    "  </profile>",
    "</profiles>",
    "",
  ].join("\n");
}

/** `java.completion.importOrder`: IDEA's layout table, `#` marking the static group. */
export function importOrder(layout: ImportRow[]): string[] {
  return layout
    .filter(
      (r): r is Extract<ImportRow, { kind: "package" }> => r.kind === "package",
    )
    .map((r) => (r.static ? `#${r.name}` : r.name));
}

export const PROFILE_PATH = ".vscode/batlehub-java/formatter.xml";

/** The settings the profile cannot carry, because `redhat.java` reads them itself. */
export function settings(
  style: CodeStyle,
  profileName: string,
): Record<string, unknown> {
  const o = style.options;
  const tabs = o.USE_TAB_CHARACTER === "true";
  const out: Record<string, unknown> = {
    "java.format.settings.url": PROFILE_PATH,
    "java.format.settings.profile": profileName,
  };
  const order = importOrder(style.layout);
  if (order.length) out["java.completion.importOrder"] = order;
  if (o.CLASS_COUNT_TO_USE_IMPORT_ON_DEMAND)
    out["java.sources.organizeImports.starThreshold"] = Number(
      o.CLASS_COUNT_TO_USE_IMPORT_ON_DEMAND,
    );
  if (o.NAMES_COUNT_TO_USE_IMPORT_ON_DEMAND)
    out["java.sources.organizeImports.staticStarThreshold"] = Number(
      o.NAMES_COUNT_TO_USE_IMPORT_ON_DEMAND,
    );
  if (o.INDENT_SIZE || o.TAB_SIZE)
    out["[java]"] = {
      "editor.tabSize": Number(
        tabs ? (o.TAB_SIZE ?? o.INDENT_SIZE) : (o.INDENT_SIZE ?? o.TAB_SIZE),
      ),
      "editor.insertSpaces": !tabs,
      // Without this the import silently does nothing about indentation:
      // `editor.detectIndentation` is on by default, so the editor guesses the
      // width from the file it is about to format and sends *that* in the
      // formatting request, which JDT.LS honours over the profile's
      // `tabulation.size`. A file already in the old style would keep it
      // forever. An imported team style is explicit by definition, so the
      // guessing has to be off for it to mean anything.
      "editor.detectIndentation": false,
    };
  return out;
}

export const PROFILE_NAME = "IntelliJ (imported)";

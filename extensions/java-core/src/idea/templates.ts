// IDEA's live templates and file templates → a workspace snippets file plus
// the two `java.templates.*` settings `redhat.java` reads (RFC 0007 §6.3).
// Pure, like `codestyle.ts`: it parses strings and returns strings, and
// `import.ts` does every read and every write.
//
// Two rules the shape follows from:
//   - a template whose variable has no snippet equivalent is *listed*, never
//     approximated into something that would expand to the wrong text. The
//     template still ships — with a placeholder where the expression was —
//     because a `sout` that needs one tab stop is still muscle memory, and a
//     `sout` that is missing is not (§4.2);
//   - the two targets are different languages. The header goes to JDT, whose
//     variables are `${year}`/`${user}`/`${type_name}`; everything else goes
//     to the editor's snippet grammar, whose are `$CURRENT_YEAR` and
//     `$TM_FILENAME_BASE`. One converter for each, and nothing shared but the
//     report.
import type { Skipped } from "./codestyle";

export interface LiveTemplate {
  name: string;
  value: string;
  description?: string;
  /** `<context>`'s true children: `JAVA_CODE`, `JAVA_STATEMENT`, … */
  contexts: string[];
  variables: { name: string; expression: string; default: string }[];
}

export interface Snippet {
  prefix: string;
  body: string[];
  description?: string;
  scope: string;
}

/** A converted template: what to write, and what could not be carried over. */
export interface Converted {
  snippet: Snippet;
  notes: Skipped[];
}

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    // Last, so an `&amp;lt;` stays the text `&lt;` instead of becoming `<`.
    .replace(/&amp;/g, "&");

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]!) : undefined;
};

/**
 * `templates/*.xml` — a `<templateSet>` of `<template>` elements. IDEA writes
 * the user's own templates here; the bundled ones (`sout` as it ships) are not
 * in the file at all, which is the point: what is here is what the developer
 * changed or added.
 */
export function parseLiveTemplates(xml: string): LiveTemplate[] {
  const out: LiveTemplate[] = [];
  for (const m of xml.matchAll(
    /<template\b([^>]*?)(\/>|>([\s\S]*?)<\/template>)/g,
  )) {
    const head = m[1]!;
    const inner = m[3] ?? "";
    const name = attr(head, "name");
    const value = attr(head, "value");
    if (!name || value === undefined) continue;
    const contexts = [
      ...inner.matchAll(/<option\s+name="([^"]+)"\s+value="true"\s*\/>/g),
    ].map((c) => c[1]!);
    const variables = [...inner.matchAll(/<variable\b([^>]*)\/>/g)].map(
      (v) => ({
        name: attr(v[1]!, "name") ?? "",
        expression: attr(v[1]!, "expression") ?? "",
        default: attr(v[1]!, "defaultValue") ?? "",
      }),
    );
    out.push({
      name,
      value,
      description: attr(head, "description"),
      contexts,
      variables,
    });
  }
  return out;
}

// The editor reads `$` and `\` as syntax wherever they appear, and `}` only
// inside a placeholder — a body full of `\}` would be correct and unreadable,
// and every Java snippet has braces in it.
const escapeSnippet = (s: string): string => s.replace(/([\\$])/g, "\\$1");
const escapePlaceholder = (s: string): string => s.replace(/([\\$}])/g, "\\$1");

/**
 * Snippet syntax held aside while the literal text around it is escaped.
 * The marker carries an index and nothing else — a marker that carried the
 * syntax itself would be escaped along with the text, which is the bug this
 * exists to make impossible. The delimiter is a private-use code point: no
 * template text has one, and unlike NUL it is not a control character a regex
 * has to apologise for.
 */
class Emitter {
  private readonly held: string[] = [];
  raw(syntax: string): string {
    this.held.push(syntax);
    return `\uE000${this.held.length - 1}\uE000`;
  }
  restore(text: string): string {
    return text.replace(
      /\uE000(\d+)\uE000/g,
      (_, i: string) => this.held[Number(i)]!,
    );
  }
}

/**
 * IDEA's `date()` in the one shape a snippet can answer. The time functions
 * have editor equivalents; anything that needs to look at the file's code —
 * `iterableVariable()`, `suggestVariableName()` — does not, and that is the
 * line this table draws.
 */
const EXPRESSIONS: Record<string, string> = {
  "className()": "$TM_FILENAME_BASE",
  "fileName()": "$TM_FILENAME",
  "fileNameWithoutExtension()": "$TM_FILENAME_BASE",
  "date()": "$CURRENT_YEAR-$CURRENT_MONTH-$CURRENT_DATE",
  "time()": "$CURRENT_HOUR:$CURRENT_MINUTE:$CURRENT_SECOND",
  "lineNumber()": "$TM_LINE_NUMBER",
};

const unquote = (s: string): string => /^"(.*)"$/.exec(s)?.[1] ?? s;

const JAVA_CONTEXT = /^JAVA(_|$)/;

/**
 * One live template → one snippet entry, or the reason it is not one.
 *
 * `$VAR$` becomes a numbered tab stop in order of first appearance, which is
 * the order IDEA moves through them in. A variable with a `defaultValue`
 * carries it as the placeholder text; one with an expression this cannot
 * evaluate carries its own name, so the developer sees what IDEA would have
 * filled in and types it — a wrong value would be silent, a named tab stop is
 * not.
 */
export function toSnippet(t: LiveTemplate): Converted | { skipped: Skipped } {
  if (t.contexts.length && !t.contexts.some((c) => JAVA_CONTEXT.test(c)))
    return {
      skipped: {
        option: t.name,
        reason: `context ${t.contexts.join(", ")} is not Java — the snippets file is scoped to java`,
      },
    };
  const notes: Skipped[] = [];
  const byName = new Map(t.variables.map((v) => [v.name, v]));
  const stops = new Map<string, number>();
  const emit = new Emitter();
  let next = 1;
  // `$$` is IDEA's escape for a literal `$`, so the pattern has to see it
  // before the variable form does; an odd `$` left over is literal too.
  const text = t.value.replace(
    /\$\$|\$([A-Za-z_][A-Za-z0-9_]*)\$/g,
    (whole: string, name: string | undefined) => {
      if (whole === "$$") return emit.raw("\\$");
      if (name === "END") return emit.raw("$0");
      if (name === "SELECTION") return emit.raw("$TM_SELECTED_TEXT");
      const v = byName.get(name!);
      const expr = v?.expression ?? "";
      const known = EXPRESSIONS[expr];
      if (known) return emit.raw(known);
      // Both columns hold a Velocity-ish expression, so a literal string is
      // quoted in either: `defaultValue="&quot;java.lang.Object&quot;"`.
      const literal = /^"(.*)"$/.exec(expr);
      const placeholder =
        unquote(v?.default ?? "") || (literal ? literal[1]! : "");
      if (expr && !literal && !v?.default)
        notes.push({
          option: `${t.name} → $${name}$`,
          reason: `${expr} has no snippet equivalent (placeholder kept)`,
        });
      let n = stops.get(name!);
      if (n === undefined) stops.set(name!, (n = next++));
      return emit.raw(
        placeholder ? `\${${n}:${escapePlaceholder(placeholder)}}` : `$${n}`,
      );
    },
  );
  // Escape the literal text first and put the snippet syntax back after, so an
  // escape can never land on the syntax this function just wrote.
  const body = emit.restore(escapeSnippet(text)).split("\n");
  return {
    snippet: {
      prefix: t.name,
      body,
      ...(t.description ? { description: t.description } : {}),
      scope: "java",
    },
    notes,
  };
}

/** JDT's own variables, which is what `java.templates.fileHeader` is written in. */
const HEADER_VARIABLES: Record<string, string> = {
  YEAR: "${year}",
  USER: "${user}",
  NAME: "${type_name}",
  DATE: "${date}",
  TIME: "${time}",
  PRODUCT_NAME: "Eclipse",
};

/**
 * `includes/File Header.java` → the lines of `java.templates.fileHeader`.
 * A variable with no JDT counterpart is dropped from the text and listed:
 * a header is written once into every new file, so a `${SOMETHING}` left
 * behind would be in the repository forever.
 */
export function fileHeader(text: string): {
  lines: string[];
  notes: Skipped[];
} {
  const notes: Skipped[] = [];
  const lines = stripVelocity(text, notes, "File Header.java")
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_: string, name: string) => {
      const jdt = HEADER_VARIABLES[name];
      if (jdt) return jdt;
      notes.push({
        option: `File Header.java → \${${name}}`,
        reason: "no JDT template variable for it (dropped from the header)",
      });
      return "";
    })
    .replace(/[ \t]+$/gm, "")
    .split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { lines, notes };
}

/**
 * Velocity is a language, and this is not an interpreter. The one directive
 * that carries meaning here is `#parse("File Header.java")`, which the caller
 * has already expanded; every other line that is a directive is dropped and
 * listed, so what ships is text the developer can read in the snippet.
 */
function stripVelocity(text: string, notes: Skipped[], where: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t.startsWith("#")) return true;
      // The package line, which decision 15 drops rather than guesses: a
      // snippet cannot know the package, and `${TM_DIRECTORY}` is a path.
      if (t.includes("${PACKAGE_NAME}")) {
        notes.push({
          option: `${where} → \${PACKAGE_NAME}`,
          reason:
            "a snippet cannot know the package (the line is dropped; the editor's own new-file command writes it)",
        });
        return false;
      }
      notes.push({
        option: `${where} → ${t.split(/\s/)[0]}`,
        reason: "Velocity directive, not evaluated (line dropped)",
      });
      return false;
    })
    .join("\n");
}

// The editor's own snippet variables, and only those. An unknown name is not
// an error there — it is inserted as its own literal text — so a `$CURRENT_USER`
// invented to look like the others would write the words "CURRENT_USER" into a
// licence header. `USER` has no equivalent and becomes a named tab stop.
const SNIPPET_VARIABLES: Record<string, string> = {
  YEAR: "$CURRENT_YEAR",
  NAME: "$TM_FILENAME_BASE",
  DATE: "$CURRENT_YEAR-$CURRENT_MONTH-$CURRENT_DATE",
  TIME: "$CURRENT_HOUR:$CURRENT_MINUTE:$CURRENT_SECOND",
};

/**
 * `Class.java`, `Interface.java`, … → a `file:<name>` snippet, with the header
 * include already expanded by the caller. Not a `New file from template`
 * command: that is its own RFC (decision 15).
 */
export function fileTemplateSnippet(name: string, text: string): Converted {
  const notes: Skipped[] = [];
  const emit = new Emitter();
  let next = 1;
  const stripped = stripVelocity(text, notes, `${name}.java`).replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_: string, v: string) => {
      const known = SNIPPET_VARIABLES[v];
      if (known) return emit.raw(known);
      notes.push({
        option: `${name}.java → \${${v}}`,
        reason: "no snippet equivalent (placeholder kept)",
      });
      return emit.raw(`\${${next++}:${v}}`);
    },
  );
  const body = emit
    .restore(escapeSnippet(stripped))
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .split("\n");
  return {
    snippet: {
      prefix: `file:${name}`,
      body,
      description: `IntelliJ file template ${name}.java`,
      scope: "java",
    },
    notes,
  };
}

export const SNIPPETS_PATH = ".vscode/intellij.code-snippets";

/** The snippets file, keyed by prefix so a re-import diffs line for line. */
export function snippetsFile(snippets: Snippet[]): string {
  const out: Record<string, Omit<Snippet, "prefix"> & { prefix: string }> = {};
  for (const s of [...snippets].sort((a, b) =>
    a.prefix.localeCompare(b.prefix),
  ))
    out[s.prefix] = s;
  return `${JSON.stringify(out, null, 2)}\n`;
}

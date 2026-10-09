# Spell checking

Spelling is [Code Spell Checker](https://open-vsx.org/extension/streetsidesoftware/code-spell-checker)
(cspell), which the BatleHub Java Pack installs with the rest. BatleHub Java
does not check spelling itself: it shows cspell's findings in Java and
Groovy files where its own inspections are, and gives the team's words one
committed home. Design: [RFC 0013](../../rfc/0013-spell-checking.md).

## In the Inspections view

cspell's findings in `.java` and `.groovy` files appear as one rule,
`spelling/unknownWord`, grouped by file like every other inspection:

```text
spelling/unknownWord   4 · via cspell 4.9.3
  Speller.java         3
```

There is no `Fix all` on it — accepting every correction at once is not a
fix. The rule's `Open cspell.json` action opens the team's dictionary. The
level of each finding is cspell's own (`Information` unless you changed
`cSpell.diagnosticLevel`).

Without cspell installed, the view shows one row,
`spelling/unknownWord — not available (install Code Spell Checker)`, which
opens its page; no notification. With cspell turned off for Java
(`cSpell.enabled: false`, or `java: false` in `cSpell.enabledFileTypes`), the
row says `disabled by you`, and BatleHub Java writes nothing over that.

## The team's dictionary

On a misspelt word, the lightbulb offers cspell's own fixes — the
correction (`Message (preferred)`), `Add … to workspace settings` /
`user settings` — and BatleHub Java's:

**`Add "<word>" to project dictionary (cspell.json)`** — the word into the
`words` of `cspell.json` at the workspace root (or `.cspell.json` /
`cSpell.json` if that is the one you have), comments and other keys kept.
When the workspace has none, it creates it:

```json
{
  "version": "0.2",
  "language": "en",
  "words": ["Mesage"],
  "ignorePaths": ["target/**", "build/**"]
}
```

That is the only time BatleHub Java writes `ignorePaths`, and the only file
it writes for spelling. Commit it: cspell's CLI in CI reads the same file.
A `cspell.json` that does not parse gets no fix; cspell shows its own
error on it.

## Good to know

- cspell skips files git ignores (`cSpell.useGitignore`, on by default):
  a project whose sources are ignored shows no spelling rows.
- Nothing is spell-checked before the workspace is trusted.
- Markdown, YAML and every other file type keep cspell's spell checking as
  cspell has it; BatleHub Java only *shows* Java and Groovy findings.

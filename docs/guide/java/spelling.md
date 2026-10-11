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

## Fixing a misspelt identifier

On a misspelt identifier, the lightbulb also offers **`Rename to
"<corrected>"`**. It takes cspell's correction for each misspelt part and
re-joins them in the identifier's own case: `recieveMesage` becomes
`receiveMessage`, `RECIEVE_MESAGE` becomes `RECEIVE_MESSAGE`. It then runs
the Java language server's rename, so every reference in the workspace
follows, and one `Undo` takes it all back. It is not offered when a part
has no correction, nor on a word in a comment, where cspell's own
correction fixes the text in place. For any other name, use F2.

## Turning it off for the team

The [inspection profile](inspections.md) can turn spelling off for Java,
with a reason like any other rule:

```json
"spelling/unknownWord": { "severity": "off", "why": "generated DTOs, see #77" }
```

BatleHub Java then sets `cSpell.enabledFileTypes` to `java: false, groovy:
false` in the workspace settings, its other keys kept, and records the
previous value so `Java: Remove BatleHub settings` puts it back. Markdown,
YAML and the rest keep their spell checking. The view's row reads `off —
profile: generated DTOs, see #77`. If you set `java` or `groovy` in
`cSpell.enabledFileTypes` yourself, that wins and nothing is written. Your
own `batlehub.java.inspections.severityOverrides` can set it `off` too, or
back on over the team's `off`.

Only `off` reaches cspell. `cSpell.diagnosticLevel` is one level for every
file type, so a Java `warning` would change the team's Markdown: any other
level is not applied, and the row reads `level is cspell's (info) — a
per-language level does not exist yet`.

## Good to know

- cspell skips files git ignores (`cSpell.useGitignore`, on by default):
  a project whose sources are ignored shows no spelling rows.
- Nothing is spell-checked before the workspace is trusted.
- Markdown, YAML and every other file type keep cspell's spell checking as
  cspell has it; BatleHub Java only *shows* Java and Groovy findings.

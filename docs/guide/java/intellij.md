# Coming from IntelliJ: the import

`Java: Import from IntelliJ` carries over what a team and a developer set up
in IntelliJ IDEA — run configurations, code style, templates, keymap,
inspection profile — into the files the editor and BatleHub Java read. It
shows a plan and a diff before anything is written, and never modifies
`.idea/`. Design: [RFC 0007](../../rfc/0007-intellij-import-full.md).

## Turning it on

The command is behind a flag while it is new:

```json
"batlehub.java.experimental": { "intellijImport": true }
```

Running the command with the flag off offers to turn it on. In an untrusted
workspace it stops before anything else, flag included, and points at
`Manage Workspace Trust`: it reads `.idea/`, which the repository controls.

## What it reads, and where it writes

The first question is which kinds to import; all are checked.

| Kind | Read from | Written to |
| --- | --- | --- |
| Run configurations | `.idea/runConfigurations/*.xml`, `workspace.xml`'s RunManager | `.vscode/launch.json` (Application, Remote, class-scoped JUnit) |
| Code style | `.idea/codeStyles/Project.xml` (if `codeStyleConfig.xml` uses it) | `.vscode/batlehub-java/formatter.xml`, an Eclipse formatter profile; `java.format.settings.url` / `.profile`, `java.completion.importOrder`, the star thresholds, `[java]` tab size |
| Live templates | your IntelliJ configuration directory, `templates/*.xml` | `.vscode/intellij.code-snippets` |
| File templates | `.idea/fileTemplates/` | the same snippets file (`file:Class` …); `java.templates.fileHeader` |
| Keymap | your IntelliJ configuration directory, the active `keymaps/<name>.xml` | your **user** keybindings |
| Inspections | `.idea/inspectionProfiles/`, the active profile | `.batlehub/java/inspections.json`, [the team's profile](./inspections.md) |

**Your IntelliJ configuration directory** is found where IDEA keeps it
(`$XDG_CONFIG_HOME/JetBrains/<product>` on Linux, `~/Library/Application
Support/JetBrains` on a Mac, `%APPDATA%\JetBrains` on Windows), the newest
product first. A Che workspace has none: the command asks you to point at a
copy — your laptop's, uploaded anywhere outside the workspace — or to skip
those two kinds. Live templates and the keymap change what *your* editor
does, so they are **never read from the repository**: a directory inside the
workspace is refused, and a committed `.idea/keymaps/` is ignored.

## The plan

Before anything is written, a modal lists each kind with its counts, what it
writes, and what it could not carry over:

```text
code style           29 of 30 options mapped, from scheme "Project"
  - WRAP_LONG_LINES: no Eclipse formatter counterpart
live templates       4 imported, from IntelliJIdea2026.1
  - iter → $ITERABLE$: iterableVariable() has no snippet equivalent (placeholder kept)
keymap               2 customisations of "Max"
  → keybindings.json (user), in this browser only (the web build keeps it in the browser)
  + alt+insert → batlehub.java.generateMenu
  + shift+f6 → editor.action.rename
  - CompareTwoFiles: no command
  ! alt+insert shadows batlehub.java-core's batlehub.java.generate.accessors
inspection profile   2 rules mapped from "Project Default", 1 disabled with an imported reason
  - 2 IDEA inspections have no bundle rule (listed in the log)
```

**Show diff** opens one diff per target, the proposed content on the right;
**Write** writes it. Nothing is on disk before Write.

## Per kind

- **Code style.** Formatting follows IDEA's output byte for byte on the
  options that map; the rest are listed by IDEA name and keep JDT's
  defaults. Indentation detection is turned off for Java, or the editor
  would guess the old width from each file.
- **Templates.** IDEA variables become snippet placeholders; an expression
  with no equivalent (`iterableVariable()`) keeps its placeholder and is
  listed. A file template's `#parse("File Header.java")` is expanded; its
  package line is dropped (a snippet cannot know the package).
- **Keymap.** Only your keymap's own changes are imported — the base is the
  IntelliJ keymap extension the Java pack recommends. Each action maps to a
  command doing the same thing (`Generate` → `Java: Generate…`,
  `RenameElement` → rename, `ReformatCode` → format document, …); an action
  with none is listed. A key you already bind yourself is left yours and
  listed; a key an extension binds by default is overridden, and the plan
  names it. Each entry is written under a
  `// batlehub: imported from IntelliJ keymap "<name>"` comment.
  **In Che and the web build your user keybindings live in the browser**, not
  on disk: the import goes through the editor's own keybindings document, so
  it works, but the bindings apply in that browser only — another browser or
  a private window does not have them.
- **Inspections.** IDEA levels become the profile's (`ERROR` → `error`,
  `WARNING` → `warning`, `WEAK WARNING` → `info`, `INFORMATION` → `hint`); a
  disabled inspection becomes `off`. Every entry gets a generated reason
  (`imported from IntelliJ profile "Project Default" (disabled there)`) and
  is marked imported: the Inspections view shows it as such until someone
  writes the team's own reason. The profile is committed — review the diff
  like any change to it.

## Undoing it

[`Java: Remove BatleHub settings`](./removal.md) takes back what the import
wrote, newest first. Your user keybindings are outside the workspace, so it
asks a second question before removing the imported ones — exactly the
entries under the import's comment; your own bindings stay. `.idea/` was
never changed, so there is nothing to restore there.

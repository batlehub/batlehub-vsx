# The team's project configuration

A team commits its Java build choices in one file; each developer's own
settings still win in their editor. Design:
[RFC 0006](../../rfc/0006-shared-project-config.md).

::: warning The editor and CI can differ, by design
Your `settings.json` overrides the file in **your** editor. CI and agents
read the file alone. The panel marks every key where you differ from the
team — **differs from project** — so a forgotten override shows up there,
not in a red pipeline.
:::

## The file

`.batlehub/java/project.json` at the root of the first workspace folder.
Every key is optional; the editor completes and validates it as you type.

```jsonc
{
  "$schema": "https://batlehub.dev/schema/java-project.schema.json",
  "version": 1,
  "jdk": { "requirement": "21" },              // over what pom.xml / build.gradle ask for
  "maven": {
    "configuration": "corp",                    // a name below, from your settings, or a detected ~/.m2/settings*.xml
    "configurations": [{ "name": "corp", "settingsFile": "~/.m2/settings-corp.xml" }],
    "activeProfiles": ["dev"]                   // -P on every goal, and the m2e preference
  },
  "registry": { "enabled": "ask" }              // ask | true | false
}
```

## Who wins

For each key, highest first: your `settings.json` (folder, workspace, user),
then `project.json`, then what detection finds, then the default. The
matching settings are `batlehub.java.maven.activeProfiles`,
`batlehub.java.maven.activeConfiguration`,
`batlehub.java.maven.configurations` and `batlehub.java.registry.enabled`.

- **Nothing applies before the workspace is trusted.** The panel still
  shows the file's values, marked `project.json (untrusted, not applied)`.
- **Once trusted, the team's profiles reach the language server's import
  without a command**: the m2e preference of every module is written (and
  recorded, so [`Remove BatleHub settings`](./removal) takes it back).
- A save of `project.json` applies at once, as the **Detect** button would.

## What you see

- **The Java panel**: each key's origin — `project.json`, `set by you`, or
  `set by you (settings.json) — differs from project: dev`; a banner on a
  tab whose keys have errors.
- **Problems**: a key of the wrong type is a row on the file and is
  treated as absent; the rest of the file applies. A file that does not
  parse is ignored whole, with one row.
- **`Java: Show effective configuration`** writes two JSON objects to the
  `BatleHub Java` channel: `effective` (your editor's values, an origin per
  key) and `project` (the file alone — what CI uses).

## Save to project

Each of the JDK, Build and Profiles tabs has **Save to project**: it writes
that tab's current values into `project.json`, creating it when needed,
comments and other keys kept. It is the only time the core writes the
team's file, and the write is recorded: `Remove BatleHub settings` takes
back the keys still as written and leaves any you edited since.

## A committed settings file

A `settingsFile` in a committed configuration chooses which `settings.xml`
— and so which credentials — Maven uses. The first time it differs from
yours, in a trusted workspace, the core asks once: **Use it** or **Keep
mine**. The answer is remembered for this workspace and that file; until
you answer *Use it*, the file's Maven configuration is not applied.

## `.batlehub/java/local/`

The core's own files (its manifest, the Maven overlay) live under
`.batlehub/java/local/`, which the one `.gitignore` line it owns hides. The
rest of `.batlehub/java/` is the team's: commit it. See
[Clean removal](./removal#batlehub-java-and-git).

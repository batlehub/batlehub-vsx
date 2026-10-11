# The team's inspection profile

BatleHub Java's inspections (the JDT bundle's rules, and SonarLint's when it is
installed) run at each rule's default level. A team changes those levels in
one committed file, with a reason for every rule it makes quieter. Design:
[RFC 0005](../../rfc/0005-shared-inspection-profiles.md).

## The file

`.batlehub/java/inspections.json` at the root of the first workspace folder:

```jsonc
{
  "$schema": "https://batlehub.dev/schema/java-inspections.schema.json",
  "version": 1,
  "rules": {
    "style/redundantThis": { "severity": "off", "why": "house style writes this.x in constructors" },
    "performance/stringConcatInLoop": { "severity": "error" }
  }
}
```

- Keys are `area/ruleId`, the code shown on every finding
  (`unused/privateField`). A SonarLint rule is `sonar/<its key>`
  (`sonar/java:S1135`).
- `severity` is `error`, `warning`, `info`, `hint` or `off`.
- **`why` is required for `off` and for any level below the rule's default.**
  Making a rule stricter needs no reason.
- The editor completes and validates the file as you type: rule ids come from
  the bundle.

## What you see

- **Problems**: findings at the profile's levels. A rule the profile made
  quieter that still shows carries the reason as related information.
- **Inspections view**: each rule says its level, where it comes from and
  why: `off — profile: house style …`. A rule set to `off` stays listed,
  with no findings under it.
- **The view's banner**: `inspections.json has N errors` when entries are
  refused, and `inspections.json: not yet checked against the bundle` until
  the language server has answered.
- **Problems on `inspections.json`**: an entry that is refused gets a row
  on its line, and is ignored; the rest of the file applies.
  - `"off" needs a "why"`, or `… is below the rule's default (warning) and needs a "why"`.
  - `unknown rule style/ifReturnBool — the loaded bundle has: style/ifReturnBoolean, …`,
    the closest id first.
  - A file that does not parse, or a `version` other than `1`, is ignored
    whole, with one row.
- **The `BatleHub Java: JDT` channel**: `profile: 11 rules known, 1 off, 0 unknown`.

Edits to the file apply on save, with no reload.

## Bridged rules: SonarLint and spelling

A bridged rule's level belongs to its analyser, so only `off` reaches it:

- **`sonar/<key>` at `off`**: SonarLint reads its rules from your *user*
  settings only, never from a workspace's, so a repository's profile cannot
  apply it by itself. The view reads `off — profile: <why> · not applied:
  SonarLint reads rules from user settings`, with an inline action, **Turn
  off in my user settings** (also `Java: Turn off in my user settings`). It
  adds `"<key>": { "level": "off" }` to `sonarlint.rules` in your user
  settings, keeping every key you already have there. A key you already set
  is yours and is not offered, and only a key shaped like a Sonar rule
  (`java:S1135`) is written. That change applies to every workspace you open.
  Any other level leaves the rule on, and the view says `on — the level is
  SonarLint's`.
- **`spelling/unknownWord` at `off`** turns cspell off for Java and Groovy,
  as described in [Spell checking](./spelling).

Every write is recorded and taken back by
[`Java: Remove BatleHub settings`](./removal). Spelling's write is also
undone as soon as the entry is no longer `off`. The SonarLint one, being
yours, stays until you remove it.

**SonarLint's JDK.** The SonarLint build Open VSX serves to a Linux pod
carries its own JRE, so nothing is written for it. A build without one (the
universal build) gets `sonarlint.ls.javaHome` set to the newest JDK 17+ the
core found, never over a value you set.
`batlehub.java.inspections.sonar.writeJavaHome: false` turns that off, and
`batlehub.java.inspections.sonar: "off"` takes back both writes.

## Your own overrides win in your editor

`batlehub.java.inspections.severityOverrides` in your settings is applied
over the profile, keyed `area/ruleId` or the bare `ruleId`. The view marks
each rule where you disagree with the team:
`warning (you) — differs from project: off`, and the banner counts them
(`1 rule differs from project`). The profile file is not touched.

## Saving your overrides as the team's profile

**`Java: Save as project profile`** (the view's `…` menu) writes your
overrides into `inspections.json`, creating it when there is none, comments
and other entries kept. Every entry that needs a reason gets an empty
`why`: the file shows a row until someone argues it, so it is never valid by
accident. The write is recorded, and
[`Java: Remove BatleHub settings`](./removal) takes back the entries still
as written.

# Clean removal

Every write the Java family makes outside its own `batlehub.java.*` settings
is appended to `.batlehub/java/local/written.json` in the first workspace folder:
the path or key, and **the value before the write**. `Java: Remove BatleHub
settings` lists what it will do, asks, and replays the manifest backwards —
restoring, not deleting:

- workspace `java.configuration.runtimes`, `java.jdt.ls.java.home` and
  `java.configuration.maven.userSettings` go back to what they were, or are
  unset if the core created them;
- the Maven overlay under `.batlehub/java/local/` and the `.gitignore` line
  the core added are removed;
- the `<!-- batlehub -->` block in `~/.m2/settings.xml` and
  `~/.gradle/init.d/batlehub.gradle` are removed, and each file's
  **permission bits go back to what they were**: the core sets `0600` on a
  file it puts a token in, and that mode is recorded like any other write;
- the settings written into the stock Java extensions (coexistence) are
  restored.

`launch.json` entries are yours and are asked about separately; installed
JDKs are never removed — they belong to the manager or to you. Without the
manifest the command would delete runtimes you added by hand, which is why
it never runs without one.

After the restore the core stops writing foreign keys — restoring
`java.configuration.runtimes` triggers a detection that would write it
right back — until you run `Java: Detect environment` again (or reload).

The manifest goes last, then `local/`, `.batlehub/java/` and `.batlehub/`
— each only when empty. The team's committed files beside it
(`project.json`, `inspections.json`) are not the family's to delete, except
profile entries the core itself wrote (see [the inspection profile](./inspections)).

## `.batlehub/java/` and git

`.batlehub/java/` is shared: the team's files at its root are meant to be
committed, and the core's own files live under `local/`, which the one
`.gitignore` line the core owns hides:

```text
/.batlehub/java/local/  # batlehub-java: the Maven overlay carries credentials
```

A workspace from before this layout (the manifest at `.batlehub/java/written.json`,
or the line `/.batlehub/java/` that hid the whole directory) is migrated on
activation: the manifest and the overlay move into `local/` and the line is
narrowed. If something else sits in `.batlehub/java/` that the old line hid,
nothing moves until you answer — `Move to local/ and continue`, `Leave them
and continue` or `Not now`; in an untrusted workspace the old layout stays.

Then uninstall the extensions as usual.

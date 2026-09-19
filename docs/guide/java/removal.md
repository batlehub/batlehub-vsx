# Clean removal

Every write the Java family makes outside its own `batlehub.java.*` settings
is appended to `.batlehub/java/written.json` in the first workspace folder:
the path or key, and **the value before the write**. `Java: Remove BatleHub
settings` lists what it will do, asks, and replays the manifest backwards —
restoring, not deleting:

- workspace `java.configuration.runtimes`, `java.jdt.ls.java.home` and
  `java.configuration.maven.userSettings` go back to what they were, or are
  unset if the core created them;
- the Maven overlay under `.batlehub/java/` and the `.gitignore` line the
  core added are removed;
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

Then uninstall the extensions as usual.

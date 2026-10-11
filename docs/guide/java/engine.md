# The command line: `batlehub-cli java`

The same inspections, fixes, generators and renames as the editor, with no
editor: a CI gate, a pre-commit hook, an agent in a terminal. It starts its
own Java language server for the run (a fresh workspace each time, never the
editor's) and stops it at the end. Design:
[RFC 0002](../../rfc/0002-headless-engine-mcp.md).

## Install

`batlehub-cli` carries the engine; nothing else is installed. It needs:

- `node` 22 or newer on `PATH` — `mise use node@24`;
- a JDK 21 or newer that discovery finds (mise, sdkman, `JAVA_HOME`), or
  `BATLEHUB_JAVA_HOME`;
- network to Open VSX once: the first run downloads the pinned Java language
  server (~55 MB) into `~/.cache/batlehub/jdtls/`. `BATLEHUB_JDTLS_HOME`
  points at an unpacked one instead.

The engine itself is written under `~/.cache/batlehub/java-engine/` on first
use. `BATLEHUB_JAVA_ENGINE=<path>/batlehub-java.mjs` runs another build — in
this repository, `task engine:bundle` makes one in `engine/dist/`, and
`node engine/cli.ts` runs the sources.

## The verbs

```sh
batlehub-cli java status                                  # JDK, server, bundle, cap — starts nothing
batlehub-cli java inspect . --fail-on warning             # one finding per line; exit 1 at or above
batlehub-cli java inspect src --format sarif > java.sarif # for a forge's code-scanning tab
batlehub-cli java fix core --rule collections/sizeIsZero  # a dry run: the unified diff
batlehub-cli java fix core --write                        # applied, "1 file, 2 edits"
batlehub-cli java generate getters src/main/java/com/acme/Person.java:5 --write
batlehub-cli java generate builder Person.java:5 --options '{"fields":["name","age"]}'
batlehub-cli java generate surroundWith Greeter.java:16 --end-line 18 --options '{"construct":"tryCatch"}'
batlehub-cli java rename com.acme.core.Greeter#all everyone --write
batlehub-cli java config --print                          # the committed project.json, resolved
batlehub-cli java mcp                                     # the tools above over stdio, for agents
```

Every verb that edits is a **dry run** until `--write`: the diff goes to
stdout (`> change.patch` is a patch `git apply` takes), the count to stderr.
`--write` refuses the whole edit when a file changed since the server read
it, or a symlink leads out of the workspace (exit 3). `generate` refuses a
builder with `placement: "file"`: the command line never creates a file.
`batlehub-cli java --help` lists every flag.

| Exit | Meaning |
| --- | --- |
| 0 | done |
| 1 | findings at or above `--fail-on`, or `generate` / `rename` made nothing (the reason on stderr) |
| 2 | no usable JDK, server, profile or memory |
| 3 | a `--write` refused |
| 4 | the server did not finish importing in `--timeout` (300 s) |

## What it reads

**Only the committed files under `.batlehub/java/`**, at the repository's
root even when you name a module (`inspect core`): never a
`.vscode/settings.json`, which is personal in an editor and written by
whoever authored the repository in CI.

- **[The inspection profile](./inspections.md)** sets each rule's level: a
  rule the team turned `off` is neither reported nor fixed by a bulk `fix`, a
  rule raised to `error` trips `--fail-on error`. Its warnings (an unknown
  rule, an `off` with no `why`) go to stderr as `file:line:`; a file that is
  not a profile at all is exit 2, so a broken gate fails rather than passing
  at the defaults. `--profile <file>` uses another file;
  `--print-profile` prints every rule at its effective level, with where the
  level comes from:

  ```text
  collections/sizeIsZero error (profile; default info)
  style/redundantThis info
  unused/privateField off (profile; default warning) — read by reflection
  ```

- **[The project configuration](./project-config.md)**: `config --print`
  prints the same `project` object as the editor's `Java: Show effective
  configuration`, byte for byte — `project.json` over what the build file
  declares, with no settings layer. It starts no server.

## In CI

```yaml
- uses: actions/setup-java@v4
  with: { distribution: temurin, java-version: "21" }
- uses: actions/setup-node@v5
  with: { node-version: 24 }
- run: batlehub-cli java inspect . --fail-on error --format sarif > java.sarif
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with: { sarif_file: java.sarif }
```

The server's cap is 1 GiB (`--heap`). A runner with a container limit
smaller than that is refused before anything starts.

## Beside an open editor

The command line and the editor run on the same repository without
touching each other's server, and count each other's memory. Each writes its
declared cap to a small ledger under `~/.cache/batlehub/java/ledger/`
(`0600`, one file per repository): the editor's resource sum (`Java: Show the
container's resources`, the JDK tab) lists `batlehub java (pid …)` while the
command line runs, and the command line refuses to start when its cap and the
editor's planned memory do not fit the container's limit together — naming
both, and pointing at [the editor's own tools](./agents.md), which start
nothing. A `--write` reaches the editor through its file watcher, like any
change on disk.

## For an agent with no editor

```json
{
  "mcpServers": {
    "batlehub-java": { "command": "batlehub-cli", "args": ["java", "mcp"] }
  }
}
```

The five tools of [the live editor](./agents.md), over stdio, with `dryRun`
defaulting to `true`; one server for the session, stopped when the agent
disconnects. An agent beside an open editor should use the editor's instead:
it sees unsaved buffers and starts no second Java server.

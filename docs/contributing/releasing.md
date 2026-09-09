# Releasing

Each extension releases on its own. A tag is the release, and the tag says
which extension it is for: `Release`
(`.github/workflows/release.yaml`) runs on any `<name>-v*` tag, builds that
extension's VSIX from the tagged tree, attaches it to a GitHub release, and
publishes it where the tokens for a registry exist.

A change to one extension therefore never republishes the other. The version
numbers are independent and are expected to drift apart.

## Cutting one

```sh
cog bump --auto --package batlehub-vsx     # or --patch / --minor / --major
git push
git push origin "$(git describe --tags --abbrev=0)"
```

`cog bump` runs that package's pre-bump hook in `cog.toml`, which writes the
new number into its `package.json`; it then updates the extension's
`CHANGELOG.md`, commits both and tags `<name>-vX.Y.Z`. The workflow refuses a
tag whose number does not match that `package.json`, so a tag placed on the
wrong commit fails before anything is published.

Dropping `--package` bumps every extension a commit touched, in one commit,
and adds a repo-wide `vX.Y.Z` tag on top of the package tags. That global tag
releases nothing: the workflow's filter needs the literal `-v`, and a tag
naming no extension has nothing to build. Push the package tags to release,
and the global one only if you want it in the history.

The tag is pushed on its own line because cog's tag is lightweight:
`git push --follow-tags` carries annotated tags only and would leave this one
behind, with the bump commit pushed, no workflow run and no error to show for
it. After a bump of several packages there is more than one tag to push, and
`git push origin --tags` is the blunt way to send them all.

## What the workflow does

1. Reads the extension name and the version out of the tag, checks that
   `extensions/<name>/` exists and that its `package.json` carries the tagged
   number.
2. Installs from the lockfile, then type-checks, lints, runs the unit tests and
   `pnpm audit --audit-level high` **across the whole repository**, not only the
   extension being released — the same gates as CI, re-run on the tagged tree
   rather than trusted from the branch. A tag is a bad moment to learn that the
   other extension is broken.
3. Packages `extensions/<name>/<name>.vsix`, copies it to
   `<name>-<version>.vsix` and writes a `.sha256` beside it.
4. Creates the GitHub release with generated notes and both files attached, or
   uploads over the assets of an existing one — a run retried after a failed
   publish picks up where it stopped instead of dying on the release it made
   the first time.
5. Publishes to Open VSX (`ovsx`) and to the VS Code Marketplace (`vsce`). Both
   are pinned devDependencies of every extension, run through `pnpm exec`, so no
   code is fetched from a registry while a publish token is in scope.

## The two publish secrets

| Secret | Registry | Absent means |
| --- | --- | --- |
| `OVSX_PAT` | Open VSX (`open-vsx.org`) | the Open VSX step is skipped |
| `VSCE_PAT` | VS Code Marketplace | the Marketplace step is skipped |

Neither is required: with both unset the tag still produces a GitHub release
carrying the VSIX, which is what [Install](/guide/install) points a user at. A
fork never publishes, because it holds neither secret.

Each token is set on its own publish step rather than on the job, so the steps
that run third-party code — `pnpm install` and the build — never see either.
The job-level `HAS_OVSX` and `HAS_VSCE` booleans exist because a step's `if:`
cannot read that step's own `env:`.

Running the workflow by hand (`workflow_dispatch`) is a dry run: it asks which
extension to build, builds it, uploads the VSIX as a workflow artifact, and
skips the release and both publishes. All three are gated on the event being a
tag push, not on the ref, so picking a tag in the "Run workflow" ref picker
still publishes nothing.

## Adding a third extension

Give it a block in `cog.toml` under `[monorepo.packages]`, pointing at its
directory and setting the same pre-bump hook. Nothing else in the pipeline
names an extension: the build, lint, test and package tasks reach it through a
glob over `extensions/`, and the release workflow reads its name off the tag.

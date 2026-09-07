# Releasing

A tag is the release. `Release` (`.github/workflows/release.yaml`) runs on any
`v*` tag, builds the VSIX from the tagged tree, attaches it to a GitHub
release, and publishes it where the tokens for a registry exist.

## Cutting one

```sh
cog bump --auto     # or --patch / --minor / --major
git push
git push origin "$(git describe --tags --abbrev=0)"
```

`cog bump` runs the pre-bump hook in `cog.toml`, which writes the new number
into the extension's `package.json`; it then updates `CHANGELOG.md`, commits
both and tags `vX.Y.Z`. The workflow refuses a tag whose number does not match
that `package.json`, so a tag placed on the wrong commit fails before anything
is published.

The tag is pushed on its own line because cog's tag is lightweight:
`git push --follow-tags` carries annotated tags only and would leave this one
behind, with the bump commit pushed, no workflow run and no error to show for
it.

## What the workflow does

1. Installs from the lockfile, then type-checks, lints, runs the unit tests and
   `pnpm audit --audit-level high` — the same gates as CI, re-run on the tagged
   tree rather than trusted from the branch.
2. Packages `extensions/batlehub-vsx/batlehub-vsx.vsix`, copies it to
   `batlehub-vsx-<version>.vsix` and writes a `.sha256` beside it.
3. Creates the GitHub release with generated notes and both files attached, or
   uploads over the assets of an existing one — a run retried after a failed
   publish picks up where it stopped instead of dying on the release it made
   the first time.
4. Publishes to Open VSX (`ovsx`) and to the VS Code Marketplace (`vsce`). Both
   are pinned devDependencies run through `pnpm exec`, so no code is fetched
   from a registry while a publish token is in scope.

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

Running the workflow by hand (`workflow_dispatch`) is a dry run: it builds and
uploads the VSIX as a workflow artifact, and skips the release and both
publishes. All three are gated on the event being a tag push, not on the ref,
so picking a tag in the "Run workflow" ref picker still publishes nothing.

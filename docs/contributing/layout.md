# Layout and tasks

```
extensions/batlehub-vsx/   the extension: src/, test/, media/, esbuild.mjs
  src/contract.ts          the contract file (RFC 0011 §4.1) — read, resolve, write
  src/credentials.ts       the chain (§4.2), pure
  src/cli.ts               step 3: batlehub-cli auth token
  src/auth-provider.ts     steps 4–5: the AuthenticationProvider
  src/broker.ts            broker mode: file upkeep, status bar, re-query
  src/mode.ts              mode detection
  src/api.ts               the registry client: header scoping, one 401 retry
  src/vsix.ts              zip reader, manifest, Ed25519 signature check
  src/marketplace/         tree, installer, ledger, details
docs/                      this site (VitePress)
tests/heavy/               the real-editor suite
dev/hub/                   the dev BatleHub's config (task hub:up)
.tasks/                    ext, docs, heavy, hub, browser task files
```

A second extension is a second directory under `extensions/`; the pnpm
workspace and every `ext:*` task pick it up by existing.

## Tasks

```sh
task init            # tools, hooks, dependencies
task ext:build       # bundle
task ext:test        # vitest
task ext:lint        # tsc, oxlint, prettier
task ext:package     # the .vsix
task docs:dev        # this site on 5173
task hub:install     # a BatleHub release's server + CLI
task hub:up          # the dev BatleHub on 8080, Postgres sidecar
task hub:seed        # publish the fixture into it
task browser:start   # unpark the sidecar's Chrome
task heavy:view      # the real-editor suite
task check           # what CI runs
```

Commits follow Conventional Commits, checked by cocogitto's hook; the
pre-commit hook runs `task recu` and `task lint`.

## Dependencies

pnpm, one lockfile at the root. Install-time scripts are denied by default;
the two that run (`esbuild`, `@vscode/vsce-sign`) are named in
`pnpm-workspace.yaml` with why. The extension bundles everything but `vscode`
into `dist/extension.js` and ships no runtime dependency.

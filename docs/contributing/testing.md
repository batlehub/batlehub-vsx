# Testing

Two layers, and a rule carried over from the server's repository: **an item
is done when a real client has been through it**, not when its unit tests
pass.

## Unit tests

`task ext:test` — vitest, under `extensions/batlehub-vsx/test/`. The modules
that hold the rules import nothing from `vscode`, so they are tested as plain
Node: the contract file against the schema's shapes (permissions, atomic
writes, preserved unknown fields, every token source), the credential chain's
order and write-backs, the registry client against a local HTTP server
(header scoping, the redirect that drops the Bearer, the single 401 retry),
the zip reader and the Ed25519 verification with a generated key pair, the
CLI step, mode detection, the paste parser. What does touch `vscode` gets the
stub in `test/vscode-mock.ts`.

## The heavy suite

`task heavy:view` — `tests/heavy/view.sh`, in the workspace `devfile.yaml`
describes: VS Code's web build (`server-linux-x64-web`, the same server a
che-code workspace runs) on a loopback port, the extension installed into it
from the `.vsix` this repository packages, a BatleHub started for the run on
port 8124 against the Postgres sidecar, and the workbench driven in the
browser sidecar's Chrome over CDP by `tests/heavy/view.mjs`. What the views
show is read off the DOM.

It needs:

- `DATABASE_URL` — the sidecar, `postgresql://batlehub:changeme@127.0.0.1:5432/batlehub`;
- a BatleHub — `BATLEHUB_SRC` pointing at a checkout (the suite builds server
  and CLI with cargo; a checkout named `batlehub` or `proxy-cache` beside this
  one is found alone), or `BATLEHUB_BIN` and `BATLEHUB_CLI` from `task hub:install`;
- Chrome unparked: `task browser:start`;
- network once, for the VS Code download and the fixture, cached under
  `~/.cache/batlehub-heavy` and shared with the server repository's suites.

Two editors, in order:

**Marketplace.** A stock `product.json`, `BATLEHUB_TOKEN` in the editor's
environment. The BatleHub view lists the two entries published for the run
(the fixture and the extension itself); the fixture's inline Install ends in
the editor's own install, the row turns to *installed*, the editor's
Extensions view lists it under `@installed`, the status bar names the
credential, and the log says the registry's Ed25519 signature verified
before the install.

**Broker.** `product.json` pointed at `batlehub-cli proxy serve`,
`VSX_REGISTRY_AUTH_SUPPORT=1`, no credential anywhere. The Account view and
the status bar say sign in; the Extensions view lists the proxy's sign-in
entry alone. The suite then gives the CLI a credential and runs **Refresh
the credential now** from the palette: the extension writes the contract
file (`0600`, `refresh` owned by the CLI), re-queries the gallery, and the
same view lists the real extension.

Screenshots and every log land under `tests/heavy/work/<run>/`, `last`
pointing at the newest. `HEAVY_ONLY=marketplace|broker` runs one half.

Ports: 8124 (server), 8132 (editor); the server repository's suites use
8081–8123 and 8127–8131, and the two must not run at once — every server's
worker leases from the one `scan_jobs` table.

## A defect this suite found

The broker half exists to catch one class of failure, and it has already
caught one. The credential contract file is **keyed by origin**: RFC 0011
§4.1 says so, the JSON Schema beside the CLI says so, and the che-code patch
reads it that way (`new URL(url).origin`). This extension writes it that way.

The CLI's local gallery proxy did not read it that way. Its
`contract::normalize_origin` only stripped a trailing slash, so a proxy
started with `--registry https://hub.example.dev/proxy/vsx` looked its entry
up under that whole string rather than under the origin. Two consumers of one
file, two different keys: the proxy never found what the extension wrote and
kept serving the sign-in entry to an editor that was, in fact, signed in.
The BatleHub repository's own suites missed it because they write the file
with `auth write-token-file --server "$REGISTRY_BASE"`, which happens to
produce the key its proxy computed, so the two wrong halves agreed.

Fixed in the CLI on 2026-09-06, with the origin parsed and three unit tests
in `cli/src/contract/tests.rs`. The broker half's `PROXY-OK` step is what
would find it again: it queries the gallery through the proxy and requires
the registry's extension in the answer.

# BatleHub

Sign in to a [BatleHub](https://github.com/batleforc/batlehub) extension
registry from the editor, keep its credential fresh, and — on a build whose
gallery URL cannot be repointed — browse and install its extensions from a
BatleHub view.

## Setup

```jsonc
"batlehub.registry": "https://hub.example.dev/proxy/vsx"
```

Then **BatleHub: Sign in**, or let the extension find a credential on its own:
the contract file `batlehub-cli auth write-token-file` writes, `BATLEHUB_TOKEN`
in the environment, or the BatleHub CLI on your PATH.

## Two modes

| The editor | What the extension does |
| --- | --- |
| Its gallery already reaches BatleHub (a patched build, or `batlehub-cli proxy serve`) | **Broker**: keeps `$BATLEHUB_HOME/state/vsx-token.json` fresh, shows the credential in the status bar, refreshes the Extensions view after a sign-in |
| Stock VS Code | **Marketplace**: a BatleHub view lists the registry's extensions and installs them — dependencies and packs resolved, the registry's Ed25519 signature verified, a denied or quarantined version refused |

The status bar item says which, and **BatleHub: Show credential status** says why.

## Settings

`batlehub.registry`, `batlehub.mode` (`auto`, `broker`, `marketplace`),
`batlehub.cliPath`, `batlehub.contractFile`, `batlehub.verifySignatures`,
`batlehub.pageSize`.

Full documentation: https://github.com/batleforc/batlehub-vsx

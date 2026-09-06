# Settings and commands

## Settings

All are `machine` scope: a remote or web editor reads them from its machine
settings, so a workspace image can ship them.

| Setting | Default | Meaning |
| --- | --- | --- |
| `batlehub.registry` | — | The VS Code registry on your BatleHub, e.g. `https://hub.example.dev/proxy/vsx`. Its origin keys the contract file |
| `batlehub.mode` | `auto` | `auto` follows RFC 0011 §4.2; `broker` and `marketplace` force one |
| `batlehub.cliPath` | `batlehub-cli` | The CLI the third step of the credential chain runs |
| `batlehub.contractFile` | `$BATLEHUB_HOME/state/vsx-token.json` | The credential contract file |
| `batlehub.verifySignatures` | `true` | Verify the registry's signature before a marketplace install |
| `batlehub.pageSize` | `50` | Entries per marketplace search |

## Commands

| Command | Does |
| --- | --- |
| BatleHub: Sign in | The interactive steps of the credential chain, then the re-query |
| BatleHub: Sign out | Drops the session and the file entry |
| BatleHub: Show credential status | One screen: registry, mode, file entry, expiry — no secret |
| BatleHub: Refresh the credential now | One broker pass, then the re-query |
| BatleHub: Show log | The output channel; credentials are redacted before they reach it |
| BatleHub: Search extensions | Marketplace: a query |
| BatleHub: Refresh / Check for updates | Marketplace: ask the registry again / diff the ledger |
| BatleHub: Install extension by id… | Marketplace: `publisher.name[@version]` |
| BatleHub: Open settings | The settings above |

## Environment

| Variable | Read by |
| --- | --- |
| `BATLEHUB_TOKEN` | Step 2 of the chain |
| `BATLEHUB_HOME` | The default contract path |
| `VSX_REGISTRY_AUTH_SUPPORT=1` | Mode detection: broker |

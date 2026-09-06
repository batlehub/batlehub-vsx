# Broker mode

RFC 0011 §12 phase 7. The editor's own gallery reaches BatleHub — a patched
build reads the contract file itself, the local proxy reads it for a stock
build — and what neither can do is *obtain* a credential, refresh it before
it expires, or tell you where you stand. That is this mode.

## What it does

- **Keeps the contract file fresh.** Every minute, and whenever the file
  changes, the extension resolves the credential chain without asking you.
  An entry it owns (an OIDC sign-in made here) is refreshed through the
  server's refresh endpoint two minutes before it expires; an entry the CLI
  owns is left to the CLI, and asked for again through `auth token` when it
  has expired. The file is written atomically, `0600`, other registries'
  entries and unknown fields preserved.
- **Shows the state.** The status bar item reads `BatleHub: oidc · 4m`,
  `BatleHub: sign in`, or `BatleHub: expired`; clicking it opens the status
  screen, which never shows a secret.
- **Re-queries after a sign-in.** The bootstrap entry the proxy shows an
  unauthenticated editor is a page; it cannot make the view ask again. The
  extension can: after **Sign in** (or **Refresh the credential now**) it
  runs the Extensions view's refresh, and the same view, no reload, lists the
  registry's extensions.

## The contract file

`$BATLEHUB_HOME/state/vsx-token.json`, `BATLEHUB_HOME` defaulting to
`~/.batlehub`; `batlehub.contractFile` overrides it. The extension writes what
the schema allows and nothing more:

```json
{
  "version": 1,
  "registries": {
    "https://hub.example.dev": {
      "token": "<access token>",
      "kind": "oidc",
      "expires_at": "2026-09-06T12:30:00.000Z",
      "refresh": { "source": "cli", "owner": "batlehub-vsx" }
    }
  }
}
```

`refresh.owner` names who rewrites the entry — the CLI for a credential the
CLI produced, this extension for one it produced. A consumer with another
name waits and re-reads; two refreshers racing on a rotating refresh token is
what the IDP reads as a replay.

## The Account view

The BatleHub activity bar item holds an **Account** view in this mode: a
sign-in button while there is no credential, nothing to do once there is.

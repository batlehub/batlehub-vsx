---
layout: home
hero:
  name: batlehub-vsx
  text: BatleHub in the editor
  tagline: One extension, two jobs — keep the editor's gallery credential fresh, or be the gallery where the editor's own cannot be repointed.
  actions:
    - theme: brand
      text: Install
      link: /guide/install
    - theme: alt
      text: How it works
      link: /guide/broker
features:
  - title: Broker mode
    details: On a build whose gallery already reaches BatleHub — a patched editor, or the local gallery proxy — the extension keeps the credential contract file fresh, shows the state in the status bar, and makes the Extensions view ask again after you sign in.
  - title: Marketplace mode
    details: On a stock VS Code, whose gallery URL cannot be repointed, a BatleHub view lists what the registry shows you and installs it through the editor's own install command, dependencies and packs included.
  - title: Signed, judged
    details: A package the registry signed is verified against the registry's key before it is installed (RFC 0020); a version the supply-chain scan denied or quarantined is not installed at all (RFC 0018).
---

This repository holds every BatleHub VS Code extension. Today that is one,
`batlehub.batlehub-vsx`, the extension [RFC 0011](https://batleforc.git.batleforc.fr/batlehub/rfc/0011-openvsx-login)
moved out of the server's repository (its §6.5 and §12 phases 7 and 8).
The credential contract file it reads and writes is that RFC's §4.1, with the
normative schema shipped beside the BatleHub CLI.

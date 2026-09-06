# batlehub-vsx

The BatleHub VS Code extensions. Today: one, `batlehub.batlehub-vsx` — the
extension [RFC 0011](https://batleforc.git.batleforc.fr/batlehub/rfc/0011-openvsx-login)
moved out of the [BatleHub](https://github.com/batleforc/batlehub) repository
(its §6.5, §12 phases 7 and 8).

- **Broker mode** — on an editor whose gallery already reaches BatleHub (a
  patched build, or the local gallery proxy): keep the credential contract
  file fresh, show the state in the status bar, re-query the gallery after a
  sign-in.
- **Marketplace mode** — on a stock VS Code, whose gallery URL cannot be
  repointed: a BatleHub view that lists what the registry shows you and
  installs it through the editor's own command, dependencies and packs
  resolved, the registry's signature verified (RFC 0020), the supply-chain
  verdict honoured (RFC 0018).

Documentation: `docs/` (VitePress, `task docs:dev`).

```sh
task init          # tools, hooks, dependencies
task ext:test      # unit tests
task ext:package   # extensions/batlehub-vsx/batlehub-vsx.vsix
task heavy:view    # the proof in a real VS Code, in this workspace's devfile
```

Bootstrapped from the [weebo-base](https://github.com/batleforc/weebo-base) template.

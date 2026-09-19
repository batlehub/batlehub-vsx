# batlehub-vsx

The BatleHub VS Code extensions. Each carries its own version and releases on
its own tag; see `docs/contributing/releasing.md`.

## `batlehub.batlehub-vsx`

The extension [RFC 0011](https://batleforc.git.batleforc.fr/batlehub/rfc/0011-openvsx-login)
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

## `batlehub.java-core`, `batlehub.java-groovy`, `batlehub.java-pack`

Java for VS Code the BatleHub way ([RFC 0001](docs/rfc/0001-java-env.md)):
one core over `redhat.java` that detects and installs JDKs through the
manager you have, warns about the container's memory, adds the Java panel,
an IDEA-style menu, run configurations in a form, the Maven and Gradle
integration, an inspections bundle inside the language server, and the
optional BatleHub registry link; a Groovy satellite over the core's
contract; a pack that installs the lot. Guide: `docs/guide/java/`.
Implementation log and findings: `todo.md`.

## `batlehub.che-remote-ssh`

Connects the editor over SSH to an [Eclipse Che](https://eclipse.dev/che/)
workspace running on plain Kubernetes, with a kubeconfig it owns and never
shares with `~/.kube/config`. See `extensions/che-remote-ssh/README.md`.

Documentation: `docs/` (VitePress, `task docs:dev`).

```sh
task init          # tools, hooks, dependencies
task ext:test      # unit tests
task ext:package   # a VSIX per extension, extensions/<name>/<name>.vsix
task heavy:view    # the proof in a real VS Code, in this workspace's devfile
```

Bootstrapped from the [weebo-base](https://github.com/batleforc/weebo-base) template.

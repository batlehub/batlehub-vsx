# Install

The extension is a `.vsix`: `batlehub-vsx.vsix` on a
[release](https://github.com/batleforc/batlehub-vsx/releases), or the output
of `task ext:package` in a checkout. Any of the usual routes installs it:

```sh
code --install-extension batlehub-vsx.vsix
# a web build
bin/code-server --install-extension batlehub-vsx.vsix
```

A BatleHub registry that hosts the extension lists it too; installing it from
there is the same as installing anything else from that registry.

## Point it at your registry

One setting matters: the VS Code registry on your BatleHub instance.

```jsonc
// settings.json
"batlehub.registry": "https://hub.example.dev/proxy/vsx"
```

Its origin, `https://hub.example.dev`, is the key the credential contract file
is looked up under — the same key `batlehub-cli auth write-token-file` writes.

## Which mode you get

The extension decides at activation, and the status bar says which:

| The editor | Mode | Why |
| --- | --- | --- |
| A patched build (`vsxRegistryAuthSupport` in its `product.json`, or `VSX_REGISTRY_AUTH_SUPPORT=1`) | [broker](./broker) | The editor's own gallery sends the credential the extension keeps fresh |
| A gallery served by `batlehub-cli proxy serve`, or pointed at the registry itself | [broker](./broker) | Same: the gallery already reaches BatleHub, the proxy reads the file |
| Stock VS Code, whose gallery URL cannot be repointed | [marketplace](./marketplace) | The extension is the gallery |

`batlehub.mode` forces either.

## Sign in

Every way of obtaining a credential is tried in order, the first hit wins:

1. the contract file, if it holds a still-valid entry for the registry's origin;
2. `BATLEHUB_TOKEN` in the editor's environment (CI, injected secrets);
3. the BatleHub CLI, if `batlehub.cliPath` resolves: `batlehub-cli auth token --output json`;
4. **Sign in** — the server-brokered OIDC login, in the browser, the landing URL pasted back;
5. a personal access token typed in, when the server has no OIDC provider.

Steps 4 and 5 run only when you ask: the **BatleHub: Sign in** command, the
button in the BatleHub view, or the Accounts menu. What they yield is written
to the contract file for every consumer that only reads it; the refresh token
of an OIDC login stays in the editor's secret storage, never in the file.

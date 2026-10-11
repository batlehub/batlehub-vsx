# Eclipse Che

Extensions for an editor running in an [Eclipse Che](https://eclipse.dev/che/)
workspace, where the usual desktop plumbing — a clipboard, OS notifications,
an SSH client next to the cluster — is missing.

| Extension                                 | What it does                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`batlehub.che-clipboard`](./clipboard)   | `pbcopy`, `pbpaste` and `xclip` in the integrated terminal, backed by the editor's clipboard |
| [`batlehub.che-notify`](./notify)         | lines appended to `~/.ide-notify` become editor notifications, optionally OS ones            |
| [`batlehub.che-remote-ssh`](./remote-ssh) | connect a desktop editor over SSH to a Che workspace on plain Kubernetes                     |

## The Che pack

`batlehub.che-pack` installs the in-workspace essentials in one go:
`che-clipboard`, `che-notify` and [the BatleHub theme](../theme).

`che-remote-ssh` is not in it: it runs in the editor on your machine, not in
the workspace, so it is installed where that editor is.

Recommend it in the project, so every workspace started from it offers it:

```jsonc
// .vscode/extensions.json
{ "recommendations": ["batlehub.che-pack"] }
```

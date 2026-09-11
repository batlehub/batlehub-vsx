# Che Clipboard

`pbcopy`, `pbpaste` and `xclip` in the integrated terminal, backed by the
editor's clipboard.

A terminal in an [Eclipse Che](https://eclipse.dev/che/) pod, or any remote
container, has no clipboard: no X server, no Wayland, no `pbcopy`. Anything
that shells out to one of those to copy for you fails silently or not at all.
Claude Code is the case this was written for: on Linux it probes `xclip`, then
`xsel`, whenever `DISPLAY` is set, which a Che workspace does set, finds
neither, and gives up on the native clipboard.

The editor in the browser has a clipboard, and an extension reaches it through
`vscode.env.clipboard`. So this extension listens on a unix socket from the
extension host and puts three shell scripts on the PATH of every integrated
terminal, through the editor's environment variable collection:

| shim | does |
|---|---|
| `pbcopy` | stdin → clipboard |
| `pbpaste` | clipboard → stdout |
| `xclip` | the subset Claude Code uses: `-selection clipboard` write, `-selection primary` write (ignored, the clipboard was just written with the same text), `-t text/plain -o` read, `-t TARGETS -o` (answers text only), `-t image/… -o` (exits 1, only text is held) |

Each shim runs a tiny node client with the extension host's own node, so
nothing has to be installed in the container. The shims live in
`$TMPDIR/che-clipboard-<uid>/`, mode 0700, next to the socket.

## What to expect in a browser

The write goes through `navigator.clipboard.writeText`, which the browser
allows only while the editor tab is focused. Running a command in the terminal
is enough. `pbpaste` goes through `readText`, which Chromium gates behind a
permission prompt the first time, and which Firefox may refuse to a web page
altogether; a failure comes back on stderr with a non-zero exit code.

Terminals opened before the extension activated do not have the PATH entry
yet; the editor marks them with a relaunch hint.

## Not covered

`wl-copy`/`wl-paste` and `xsel`: Claude Code only reaches for them when
`WAYLAND_DISPLAY` is set, or when `xclip` is missing, neither of which is the
case once this extension is installed. Images: the editor's clipboard API is
text only.

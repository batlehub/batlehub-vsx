# Che Notify

`Che Notify` turns lines appended to `~/.ide-notify` into native editor notifications, and optionally into browser/OS notifications. It is for processes inside an Eclipse Che workspace that have no other way to reach you: scripts, long builds, platform automation, and AI coding agents (Claude Code, Codex) waiting for an answer.

```sh
ide-notify info "Build completed"
ide-notify error "Deploy failed"
echo 'warn|A workspace will stop soon' >> ~/.ide-notify
```

Run **Che Notify: Send a test notification** to check the whole path.

## The `ide-notify` command

The extension installs `ide-notify` in `~/.local/bin` when it starts (disable with `cheNotify.installCli`). It appends one line to the notification file (`$IDE_NOTIFY_FILE`, default `~/.ide-notify`).

| Call                            | Result                                     |
| ------------------------------- | ------------------------------------------ |
| `ide-notify <text>`             | an `info` notification                     |
| `ide-notify warn\|error <text>` | that severity                              |
| `<cmd> \| ide-notify`           | standard input becomes the message         |
| `ide-notify '<json>'` or stdin  | an AI agent payload, formatted (see below) |

## AI agents

Run **Che Notify: Send AI agent notifications to the editor**. It adds, without touching anything else:

- **Claude Code**: `Notification` and `Stop` hooks in `~/.claude/settings.json`, so you hear when Claude asks for a permission (shown as a warning) or finishes its turn.
- **Codex**: `notify = ["~/.local/bin/ide-notify"]` in `~/.codex/config.toml` (`$CODEX_HOME` is honoured). An existing `notify` is left alone.

Or by hand:

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    "Notification": [{ "hooks": [{ "type": "command", "command": "~/.local/bin/ide-notify" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "~/.local/bin/ide-notify" }] }],
  },
}
```

```toml
# ~/.codex/config.toml (top level, before any [table])
notify = ["/home/user/.local/bin/ide-notify"]
```

Any other agent works if it can run a command: pass it JSON with `message` (and optionally `level`, `source`), or plain text. `IDE_NOTIFY_SOURCE` overrides the name shown in front of the message.

## Browser / OS notifications

Editor notifications only show while you look at the editor tab. To get them from your operating system, the **Browser notifications** view (panel, _Che Notify_) has to be open once and its **Allow browser notifications** button clicked: browsers only grant the permission after a click.

So the extension shows that view once, on its first start: click **Allow**, accept the browser prompt, and a test OS notification confirms it. Once granted, the view is only resolved then hidden at each start, so OS notifications keep working without it in the way. If the browser blocked it, allow notifications for the Che site in the browser's site settings (padlock in the address bar) and run **Che Notify: Open the browser notification bridge**, which opens the view at any time.

## File format

One notification per line, appended:

- plain text, or `info|text`, `warn|text`, `error|text`;
- JSON: `{"level":"warn","message":"…","actions":[…]}`, where each action has a `label` and one of:

| `type`    | Fields             | Effect                                   |
| --------- | ------------------ | ---------------------------------------- |
| `url`     | `url`              | opens the URL                            |
| `file`    | `path`, `line`?    | opens the file in the editor             |
| `command` | `command`, `args`? | runs an editor command                   |
| `shell`   | `command`          | runs it in a new terminal, after a click |
| `copy`    | `text`             | copies to the clipboard                  |

```sh
echo '{"level":"error","message":"Tests failed","actions":[{"label":"Open report","type":"file","path":"/projects/app/report.txt"}]}' >> ~/.ide-notify
```

## External relays

Set `cheNotify.forwarders` to fan every accepted notification out to other services. Each relay receives `{ version, emittedAt, notification }`.

```json
{
  "cheNotify.forwarders": [
    {
      "type": "webhook",
      "url": "https://hooks.example.test/che",
      "headers": { "Authorization": "Bearer <secret>" },
      "levels": ["warn", "error"]
    },
    {
      "type": "command",
      "command": "/usr/local/bin/notify-team",
      "args": ["--source", "che"],
      "levels": ["error"]
    }
  ]
}
```

A webhook gets a JSON `POST`. A command receives the same JSON document on standard input; it is started directly with the listed arguments, never through a shell, so notification text cannot be executed as code.

## Settings

| Setting                        | Default         | Meaning                                                     |
| ------------------------------ | --------------- | ----------------------------------------------------------- |
| `cheNotify.file`               | `~/.ide-notify` | file to watch                                               |
| `cheNotify.pollInterval`       | `1000`          | polling interval, ms                                        |
| `cheNotify.installCli`         | `true`          | install `ide-notify` in `~/.local/bin`                      |
| `cheNotify.osBridge.autoOpen`  | `false`         | open the bridge at start every time, not only the first one |
| `cheNotify.osBridge.autoClose` | `false`         | hide the panel again after that automatic opening           |
| `cheNotify.forwarders`         | `[]`            | external relays, see above                                  |

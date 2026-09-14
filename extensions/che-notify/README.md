# Che Notify

`Che Notify` turns lines appended to `~/.ide-notify` into native editor notifications. It is intended for processes inside an Eclipse Che workspace: scripts, CI helpers, platform automation, Claude Code or Codex hooks.

```sh
ide-notify info "Build completed"
echo 'warn|A workspace will stop soon' >> ~/.ide-notify
echo '{"hook_event_name":"Notification","message":"Claude needs input"}' | ide-notify
```

The bundled `ide-notify` command is installed in `~/.local/bin` at activation (disable with `cheNotify.installCli`). Lines may be plain text, `info|message`, `warn|message`, `error|message`, or JSON with `level`, `message` and supported actions (`url`, `file`, `command`, `shell`, `copy`).

Run **Che Notify: Send a test notification** to verify the complete path. **Che Notify: Open the browser notification bridge** optionally forwards notifications to the browser/OS once permission is granted.
## External relays

Set `cheNotify.forwarders` to fan every accepted notification out to other services. Each relay receives `{ version, emittedAt, notification }`.

```json
{
  "cheNotify.forwarders": [
    { "type": "webhook", "url": "https://hooks.example.test/che", "headers": { "Authorization": "Bearer <secret>" }, "levels": ["warn", "error"] },
    { "type": "command", "command": "/usr/local/bin/notify-team", "args": ["--source", "che"], "levels": ["error"] }
  ]
}
```

A webhook gets a JSON `POST`. A command receives the same JSON document on standard input; it is started directly with the listed arguments, never through a shell, so notification text cannot be executed as code.

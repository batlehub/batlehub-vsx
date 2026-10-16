import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { withClaudeHooks, withCodexNotify } from "../src/agents";

const cli = "/home/u/.local/bin/ide-notify";

describe("agent setup", () => {
  it("adds Claude Code hooks once and keeps the rest", () => {
    const first = withClaudeHooks(
      '{"model":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"say"}]}]}}',
      cli,
    );
    const parsed = JSON.parse(first.text);
    expect(first.changed).toBe(true);
    expect(parsed.model).toBe("x");
    expect(parsed.hooks.Stop).toHaveLength(2);
    expect(parsed.hooks.Notification[0].hooks[0].command).toBe(cli);
    expect(withClaudeHooks(first.text, cli).changed).toBe(false);
    expect(() => withClaudeHooks("[]", cli)).toThrow();
  });

  it("sets Codex notify at top level, never over the user's own", () => {
    const out = withCodexNotify('model = "o"\n[profiles.a]\nnotify = ["x"]\n', cli);
    expect(out.text.startsWith(`notify = ["${cli}"]\n`)).toBe(true);
    expect(withCodexNotify('notify = ["mine"]\n', cli).changed).toBe(false);
  });
});

describe("ide-notify cli", () => {
  const run = (args: string[], input?: string) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ide-notify-")), "n");
    execFileSync("node", [path.join(__dirname, "../bin/ide-notify"), ...args], {
      env: { ...process.env, IDE_NOTIFY_FILE: file, IDE_NOTIFY_SOURCE: "" },
      input: input ?? "",
    });
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  };

  it("formats agent payloads from argv and stdin", () => {
    expect(run(["warn", "disk", "full"])).toBe("warn|disk full\n");
    expect(
      run([], '{"hook_event_name":"Notification","message":"Claude needs your permission"}\n'),
    ).toBe("warn|Claude Code: Claude needs your permission\n");
    expect(run([], '{"hook_event_name":"Stop"}')).toBe(
      "info|Claude Code [Stop]: finished, waiting for you\n",
    );
    expect(run(['{"type":"agent-turn-complete","last-assistant-message":"Done"}'])).toBe(
      "info|Codex [agent-turn-complete]: Done\n",
    );
    expect(run([], "  \n")).toBe("");
  });
});

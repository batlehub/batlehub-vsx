import { describe, expect, it, vi } from "vitest";
import { forward, parseForwarders } from "../src/forward";

describe("outgoing forwarders", () => {
  it("accepts only safe webhook and command configuration", () => {
    expect(
      parseForwarders([
        {
          type: "webhook",
          url: "https://hooks.example.test/notify",
          headers: { Authorization: "Bearer x" },
        },
        { type: "command", command: "/usr/local/bin/notify", args: ["--json"] },
        { type: "webhook", url: "file:///tmp/no" },
        { type: "command", command: "", args: [] },
      ]),
    ).toEqual([
      {
        type: "webhook",
        url: "https://hooks.example.test/notify",
        headers: { Authorization: "Bearer x" },
      },
      { type: "command", command: "/usr/local/bin/notify", args: ["--json"] },
    ]);
  });

  it("posts the complete notification as JSON", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await forward(
      { level: "warn", message: "maintenance", actions: [] },
      [{ type: "webhook", url: "https://hooks.example.test/notify" }],
      fetch,
    );
    expect(fetch).toHaveBeenCalledOnce();
    const options = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(options).toBeDefined();
    expect(JSON.parse(options.body as string)).toMatchObject({
      notification: { level: "warn", message: "maintenance" },
    });
  });

  it("forwards only the configured severities", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const forwarders = [
      {
        type: "webhook" as const,
        url: "https://hooks.example.test/errors",
        levels: ["error" as const],
      },
    ];
    await forward({ level: "warn", message: "ignored", actions: [] }, forwarders, fetch);
    expect(fetch).not.toHaveBeenCalled();
    await forward({ level: "error", message: "sent", actions: [] }, forwarders, fetch);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

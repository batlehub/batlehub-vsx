import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { freePort, isListening, waitForPort } from "../src/ports";

describe("freePort", () => {
  it("gives a port nothing is on, from the kernel", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(1023);
    expect(await isListening(port, 200)).toBe(false);
  });
});

describe("isListening", () => {
  it("sees a loopback listener and no longer sees it once closed", async () => {
    const port = await freePort();
    const server = createServer();
    await new Promise<void>((r) => server.listen({ port, host: "127.0.0.1" }, r));
    expect(await isListening(port, 500)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await isListening(port, 200)).toBe(false);
  });
});

describe("waitForPort", () => {
  it("returns as soon as the forward accepts", async () => {
    let attempts = 0;
    const ok = await waitForPort(2222, {
      sleep: () => Promise.resolve(),
      probe: () => Promise.resolve(++attempts >= 3),
    });
    expect(ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it("gives up at the deadline rather than wait forever", async () => {
    let clock = 0;
    const ok = await waitForPort(2222, {
      timeoutMs: 300,
      intervalMs: 100,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      probe: () => Promise.resolve(false),
    });
    expect(ok).toBe(false);
  });
});

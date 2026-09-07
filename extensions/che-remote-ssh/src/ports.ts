// Local ports, on loopback only.
//
// A forward is a hole into the workspace, so it is opened on 127.0.0.1 and
// the port is chosen by the kernel rather than guessed: asking for port 0
// and reading back what was bound cannot collide with a port something else
// took while we were deciding.
import { createServer, Socket } from "node:net";

/** A free loopback port, from the kernel. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close(() => reject(new Error("the kernel gave no port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** Does something accept a connection on this loopback port right now? */
export function isListening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  probe?: (port: number) => Promise<boolean>;
}

/**
 * Wait until the forward is actually accepting connections. kubectl returns
 * before its listener is up, so handing the port to SSH straight away is a
 * race that shows as a connection refused the user cannot explain.
 */
export async function waitForPort(port: number, opts: WaitOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 100;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const probe = opts.probe ?? ((p: number) => isListening(p));
  const deadline = now() + timeoutMs;
  for (;;) {
    if (await probe(port)) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

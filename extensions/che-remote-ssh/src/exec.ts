// Running a binary and collecting what it said. Separate from the callers so
// every one of them can be handed a fake in a test, and so no command is
// ever built as a string a shell could reinterpret.
import { execFile } from "node:child_process";

export interface RunResult {
  /** -2 when the binary is not on PATH, which is a state and not an error. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  (file: string, args: string[], timeoutMs?: number): Promise<RunResult>;
}

export const NOT_FOUND = -2;

export const defaultRunner: Runner = (file, args, timeoutMs = 30_000) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1 << 22, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err
          ? ((err as NodeJS.ErrnoException & { code?: number | string }).code as number | string)
          : 0;
        resolve({
          code: typeof code === "number" ? code : code === "ENOENT" ? NOT_FOUND : 1,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });

export class CommandError extends Error {
  constructor(
    readonly bin: string,
    readonly result: RunResult,
  ) {
    super(
      result.code === NOT_FOUND
        ? `${bin} was not found on PATH`
        : `${bin} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

/** Run, or throw with what the binary printed. */
export async function must(
  run: Runner,
  bin: string,
  args: string[],
  timeoutMs?: number,
): Promise<string> {
  const result = await run(bin, args, timeoutMs);
  if (result.code !== 0) throw new CommandError(bin, result);
  return result.stdout;
}

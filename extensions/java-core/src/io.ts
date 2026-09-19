// The real `Io` the rule modules are injected with: Node's filesystem, a
// child process spawned with an argument array (never a shell, §7), the
// environment. Everything the trust rule has to switch off goes through
// `exec`, so an untrusted workspace gets an `Io` whose `exec` runs nothing.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type { Io } from "./jdk/discover";

export function realIo(opts: {
  trusted: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Io {
  const env = opts.env ?? process.env;
  return {
    readFile: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
    readDir: (p) => {
      try {
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    },
    isDir: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    exec: (cmd, args) =>
      new Promise((resolve) => {
        if (!opts.trusted) return resolve(undefined);
        execFile(
          cmd,
          args,
          { cwd: opts.cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
          (err, stdout) => resolve(err ? undefined : String(stdout)),
        );
      }),
    env,
    home: os.homedir(),
    platform: process.platform,
  };
}

/**
 * The probe `Io` of RFC 0001 §7.1: what lives outside the workspace in a known
 * place — the JDKs a manager installed, `~/.m2`, `~/.gradle` — is a fact, not
 * an input, so it is read before trust. It runs from the home directory and
 * takes no argument from the workspace, which is also what keeps a repository's
 * own `mise.toml` out of the answer. Everything the *workspace* controls (a
 * wrapper, a build file, a `PATH` `mvn`) stays behind `realIo({ trusted })`.
 */
export function homeIo(): Io {
  return realIo({ trusted: true, cwd: os.homedir() });
}

/** Like `exec` but the failure is an error with stderr, for commands whose output the user reads. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeout ?? 300_000,
      },
      (err, stdout, stderr) => {
        const code: unknown = err ? (err as { code?: unknown }).code : 0;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code: typeof code === "number" ? code : err ? 1 : 0,
        });
      },
    );
  });
}

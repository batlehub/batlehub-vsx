// JDK install is delegated, always (RFC 0001 §4.2, decision 10): `mise use
// java@<ver>` or `sdk install java <id>`; with no manager the answer is a
// link to the guide. Pure over `Io`.
import type { Io } from "./discover";

export type InstallVia = "auto" | "mise" | "sdkman" | "none";
export type Manager = "mise" | "sdkman";

export async function availableManagers(io: Io): Promise<Manager[]> {
  const out: Manager[] = [];
  if ((await io.exec("mise", ["--version"])) !== undefined) out.push("mise");
  const base = io.env.SDKMAN_DIR || `${io.home}/.sdkman`;
  if (
    io.isDir(`${base}/bin`) ||
    (await io.exec("sdk", ["version"])) !== undefined
  )
    out.push("sdkman");
  return out;
}

export async function chooseManager(
  io: Io,
  via: InstallVia,
): Promise<Manager | undefined> {
  if (via === "none") return undefined;
  const have = await availableManagers(io);
  if (via === "auto") return have[0];
  return have.includes(via) ? via : undefined;
}

/** `mise ls-remote java` is 6 000 lines; keep the LTS Temurin majors and the newest of each. */
export function parseMiseRemote(
  stdout: string,
  vendor = "temurin",
): { id: string; major: number }[] {
  const newest = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const m = new RegExp(`^${vendor}-(\\d+)(?:\\.[\\d.+]+)?(?:\\.LTS)?$`).exec(
      line.trim(),
    );
    if (!m) continue;
    newest.set(Number(m[1]), line.trim());
  }
  return [...newest.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([major, id]) => ({ id, major }));
}

/** `sdk list java` prints a table: `| Temurin | >>> | 21.0.5 | tem | installed | 21.0.5-tem`. */
export function parseSdkList(stdout: string): { id: string; major: number }[] {
  const out: { id: string; major: number }[] = [];
  for (const line of stdout.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    const id = cells.at(-1);
    if (!id || !/^\d+[\w.+-]*-\w+$/.test(id)) continue;
    const major = Number(/^(\d+)/.exec(id)![1]);
    if (!out.some((o) => o.major === major)) out.push({ id, major });
  }
  return out;
}

export async function offers(
  io: Io,
  m: Manager,
): Promise<{ id: string; major: number }[]> {
  if (m === "mise")
    return parseMiseRemote(
      (await io.exec("mise", ["ls-remote", "java"])) ?? "",
    );
  return parseSdkList((await io.exec("sdk", ["list", "java"])) ?? "");
}

/** The argument array the terminal runs — shown to the user before it runs. */
export function installCommand(
  m: Manager,
  id: string,
  global = true,
): string[] {
  if (m === "mise")
    return ["mise", "use", ...(global ? ["-g"] : []), `java@${id}`];
  return ["sdk", "install", "java", id];
}

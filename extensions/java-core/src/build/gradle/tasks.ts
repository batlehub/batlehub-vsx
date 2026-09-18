// What Gradle prints, parsed (RFC 0001 §12 phase 7): `gradle tasks --all`
// into BuildTasks, `gradle dependencies` into the DependencyNode tree. Pure.
import type { DependencyNode } from "../types";

/** Gradle colours its output even with --console=plain on some versions; the escape is built, not written, for the linter's sake. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** `gradle tasks --all`: "Build tasks" groups, `name - description` lines, `Other tasks` too. */
export function parseTasks(
  stdout: string,
): { name: string; group: string; description?: string }[] {
  const out: { name: string; group: string; description?: string }[] = [];
  let group = "other";
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(ANSI, "").trimEnd();
    const h = /^([A-Z][\w ]+) tasks$/.exec(line);
    if (h) {
      group = h[1]!.toLowerCase();
      continue;
    }
    const t = /^([\w:-]+)(?: - (.*))?$/.exec(line);
    if (
      !t ||
      /^-+$/.test(line) ||
      line.startsWith("Rules") ||
      line.startsWith("Pattern")
    )
      continue;
    if (!out.some((o) => o.name === t[1]))
      out.push({ name: t[1]!, group, description: t[2] });
  }
  return out;
}

/**
 * `gradle :app:dependencies --configuration runtimeClasspath`: the tree under
 * the configuration header, `+--- g:a:1.0`, `|    \--- g:a:1.0 -> 2.0 (*)`.
 * `-> 2.0` is Gradle's conflict resolution: the node lost to 2.0.
 */
export function parseDependencies(
  stdout: string,
  configuration = "runtimeClasspath",
): DependencyNode | undefined {
  const lines = stdout.replace(ANSI, "").split(/\r?\n/);
  const start = lines.findIndex(
    (l) => l.startsWith(`${configuration} -`) || l === configuration,
  );
  if (start < 0) return undefined;
  const root: DependencyNode = {
    id: configuration,
    groupId: "",
    artifactId: configuration,
    version: "",
    children: [],
  };
  const stack: { depth: number; node: DependencyNode }[] = [
    { depth: -1, node: root },
  ];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break;
    const m =
      /^([|\s+\\-]*)(?:project (:[\w:-]+)|([\w.-]+):([\w.-]+)(?::([\w.-]+))?)(?:\s+->\s+([\w.-]+))?(?:\s+\((\*|c|n)\))?\s*$/.exec(
        line,
      );
    if (!m) continue;
    const [, prefix, project, g, a, version, resolved, mark] = m;
    const groupId = project ? "" : g;
    const artifactId = project ?? a;
    const depth = Math.floor((prefix ?? "").length / 5);
    const node: DependencyNode = {
      id: `${groupId}:${artifactId}:${resolved ?? version ?? ""}`,
      groupId: groupId!,
      artifactId: artifactId!,
      version: resolved ?? version ?? "",
      children: [],
    };
    if (resolved && version && resolved !== version) {
      node.omitted = "conflict";
      node.conflict = resolved;
      node.version = version;
    } else if (mark === "*") node.omitted = "duplicate";
    while (stack.length > 1 && stack[stack.length - 1]!.depth >= depth)
      stack.pop();
    stack[stack.length - 1]!.node.children.push(node);
    stack.push({ depth, node });
  }
  return root;
}

/** The `init.gradle` the registry link writes (§4.2): every repository → the BatleHub mirror, the token as a header. */
export function initScript(url: string, token: string | null): string {
  const auth = token
    ? `
            credentials(HttpHeaderCredentials) {
                name = "Authorization"
                value = "Bearer ${token.replace(/["\\]/g, "")}"
            }
            authentication { header(HttpHeaderAuthentication) }`
    : "";
  return `// Written by BatleHub Java (RFC 0001 §4.2, registry link). Removed by "Java: Remove BatleHub settings".
allprojects {
    repositories {
        all { ArtifactRepository repo ->
            if (repo instanceof MavenArtifactRepository && repo.url.toString() != "${url}") {
                remove repo
            }
        }
        maven {
            name = "batlehub"
            url = "${url}"${auth}
        }
    }
}
settingsEvaluated { settings ->
    settings.pluginManagement.repositories {
        maven {
            name = "batlehub"
            url = "${url}"${auth}
        }
    }
}
`;
}

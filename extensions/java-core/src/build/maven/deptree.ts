// `mvn dependency:tree` text output → the DependencyNode tree of §5.2, with
// what Maven says about conflicts ("omitted for conflict with 2.0") kept on
// the node. Pure parser; the fixture is a real `-DoutputType=text` file.
import type { DependencyNode } from "../types";

const LINE =
  /^(?:\[INFO\]\s+)?([|\s+\\-]*)([\w.-]+(?::[\w.-]+){3,5})(?:\s+\((.*)\))?\s*$/;

/** `com.acme:app:jar:1.0` root, then `+- g:a:jar:1.0:compile`, `|  \- …`, `(version - omitted for conflict with X)`. */
export function parseTree(text: string): DependencyNode | undefined {
  let root: DependencyNode | undefined;
  const stack: { depth: number; node: DependencyNode }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const [, prefix, coord, note] = m;
    // g:a:type:version · g:a:type:version:scope · g:a:type:classifier:version:scope
    const parts = coord!.split(":");
    const [groupId, artifactId] = parts;
    const version = parts.length === 6 ? parts[4]! : parts[3]!;
    const scope = parts.length >= 5 ? parts[parts.length - 1] : undefined;
    const node: DependencyNode = {
      id: `${groupId}:${artifactId}:${version}`,
      groupId: groupId!,
      artifactId: artifactId!,
      version,
      scope: prefix ? scope : undefined,
      children: [],
    };
    if (note) {
      const conflict = /omitted for conflict with ([\w.-]+)/.exec(note);
      if (conflict) {
        node.omitted = "conflict";
        node.conflict = conflict[1];
      } else if (/omitted for duplicate/.test(note)) node.omitted = "duplicate";
    }
    const depth = prefix
      ? Math.round(prefix.replace(/[+\\-]/g, "").length / 3) + 1
      : 0;
    if (depth === 0) {
      root = node;
      stack.length = 0;
      stack.push({ depth: 0, node });
      continue;
    }
    while (stack.length && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const parent = stack[stack.length - 1]?.node ?? root;
    parent?.children.push(node);
    stack.push({ depth, node });
  }
  return root;
}

/** Every node, depth-first, for the explorer's flat lookups and the verdict fetch. */
export function flatten(n: DependencyNode): DependencyNode[] {
  return [n, ...n.children.flatMap(flatten)];
}

/** The winners and losers of a version conflict: `{ "g:a": { won: "2.0", lost: ["1.0"] } }`. */
export function conflicts(
  root: DependencyNode,
): Record<string, { won: string; lost: string[] }> {
  const out: Record<string, { won: string; lost: string[] }> = {};
  for (const n of flatten(root)) {
    if (n.omitted !== "conflict" || !n.conflict) continue;
    const k = `${n.groupId}:${n.artifactId}`;
    out[k] ??= { won: n.conflict, lost: [] };
    if (!out[k]!.lost.includes(n.version)) out[k]!.lost.push(n.version);
  }
  return out;
}

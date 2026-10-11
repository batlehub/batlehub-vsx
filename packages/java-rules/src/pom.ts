// What the core reads out of a POM without Maven: the Java requirement, the
// modules, the profiles, the coordinates. Pure string scanning over the
// elements that matter — a POM is XML but the handful of elements read here
// are flat, and a real parser is an XML dependency for four tags.

const tag = (xml: string, name: string): string | undefined =>
  new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(xml)?.[1]?.trim();

/** Everything inside the *top-level* `<name>` element (the first not nested inside `<parent>`/`<dependencies>`…). */
function section(xml: string, name: string): string | undefined {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    return m[1];
  }
  return undefined;
}

/** Strip comments so a commented-out `<module>` is not a module. */
const clean = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, "");

export interface PomInfo {
  groupId?: string;
  artifactId?: string;
  version?: string;
  packaging: string;
  modules: string[];
  profiles: string[];
  properties: Record<string, string>;
  /** `<parent><relativePath>` or the default `../pom.xml`. */
  parentRelativePath?: string;
  hasParent: boolean;
}

export function parsePom(text: string): PomInfo {
  const xml = clean(text);
  const parent = section(xml, "parent");
  // The project's own coordinates: what is left once every nested section
  // that also carries a groupId (parent, dependencies, plugins, profiles…) is gone.
  const own = xml.replace(
    /<(parent|dependencies|dependencyManagement|build|profiles|properties|reporting|distributionManagement|scm|licenses|developers)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g,
    "",
  );
  const props = section(xml, "properties") ?? "";
  const properties: Record<string, string> = {};
  for (const m of props.matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g))
    properties[m[1]!] = m[2]!.trim();
  const modules = [
    ...(section(xml, "modules") ?? "").matchAll(/<module>([^<]+)<\/module>/g),
  ].map((m) => m[1]!.trim());
  const profiles = [
    ...(section(xml, "profiles") ?? "").matchAll(
      /<profile>[\s\S]*?<id>([^<]+)<\/id>/g,
    ),
  ].map((m) => m[1]!.trim());
  return {
    groupId:
      tag(own, "groupId") ?? (parent ? tag(parent, "groupId") : undefined),
    artifactId: tag(own, "artifactId"),
    version:
      tag(own, "version") ?? (parent ? tag(parent, "version") : undefined),
    packaging: tag(own, "packaging") ?? "jar",
    modules,
    profiles,
    properties,
    hasParent: !!parent,
    parentRelativePath: parent
      ? (tag(parent, "relativePath") ?? "../pom.xml")
      : undefined,
  };
}

/**
 * The Java the build asks for: `maven.compiler.release`, then `.target` /
 * `.source`, then the compiler plugin's `<release>`; `${...}` resolved
 * against properties. `1.8` → 8.
 */
export function requiredJavaOf(
  text: string,
  inherited: Record<string, string> = {},
): { min: number; origin: string } | undefined {
  const xml = clean(text);
  const props = { ...inherited, ...parsePom(xml).properties };
  const resolve = (v: string | undefined) => {
    if (!v) return undefined;
    const m = /^\$\{([\w.-]+)\}$/.exec(v.trim());
    return m ? props[m[1]!] : v.trim();
  };
  const major = (v: string | undefined) => {
    const r = resolve(v);
    if (!r) return undefined;
    const n = /^(?:1\.)?(\d+)/.exec(r);
    return n ? Number(n[1]) : undefined;
  };
  const candidates: [string | undefined, string][] = [
    [props["maven.compiler.release"], "maven.compiler.release"],
    [props["maven.compiler.target"], "maven.compiler.target"],
    [props["maven.compiler.source"], "maven.compiler.source"],
  ];
  const plugin =
    /<artifactId>maven-compiler-plugin<\/artifactId>[\s\S]*?<configuration>([\s\S]*?)<\/configuration>/.exec(
      xml,
    )?.[1];
  if (plugin) {
    candidates.push([
      tag(plugin, "release"),
      "maven-compiler-plugin <release>",
    ]);
    candidates.push([tag(plugin, "target"), "maven-compiler-plugin <target>"]);
  }
  for (const [v, origin] of candidates) {
    const n = major(v);
    if (n) return { min: n, origin };
  }
  return undefined;
}

/** `~/.m2/toolchains.xml`: the JDK versions it declares. */
export function toolchainVersions(text: string): number[] {
  return [
    ...clean(text).matchAll(
      /<toolchain>[\s\S]*?<type>jdk<\/type>[\s\S]*?<version>([^<]+)<\/version>/g,
    ),
  ]
    .map((m) => Number(/^(?:1\.)?(\d+)/.exec(m[1]!.trim())?.[1]))
    .filter(Boolean);
}

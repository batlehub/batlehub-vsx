// The registry link's footprint in `~/.m2/settings.xml` (RFC 0001 §4.2
// "Registry link", §7): a `<!-- batlehub -->` fenced block the core owns —
// one `<mirror>` and one `<server>` — set, re-set and unset leaving the
// rest of the file byte-identical. Pure string edits: Maven's settings is a
// file people hand-edit, and a parser that reprints it would reformat it.

export const MARKER = "batlehub";
const OPEN = (what: string) => `<!-- ${MARKER}:${what} -->`;
const CLOSE = (what: string) => `<!-- /${MARKER}:${what} -->`;

const SKELETON = `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.2.0 https://maven.apache.org/xsd/settings-1.2.0.xsd">
</settings>
`;

export interface Link {
  /** The registry's Maven endpoint, e.g. `https://hub.example.dev/proxy/maven`. */
  url: string;
  /** Written into `<server>`; null writes no `<server>` at all. */
  token: string | null;
  /** Which repositories the mirror stands in for; Maven's `*` is every one, `central` only Central. */
  mirrorOf?: string;
}

function block(what: "mirror" | "server", link: Link): string {
  if (what === "mirror") {
    return [
      OPEN("mirror"),
      `    <mirror>`,
      `      <id>${MARKER}</id>`,
      `      <name>BatleHub</name>`,
      `      <url>${escape(link.url)}</url>`,
      `      <mirrorOf>${escape(link.mirrorOf ?? "*")}</mirrorOf>`,
      `    </mirror>`,
      CLOSE("mirror"),
    ].join("\n    ");
  }
  return [
    OPEN("server"),
    `    <server>`,
    `      <id>${MARKER}</id>`,
    `      <username>token</username>`,
    `      <password>${escape(link.token ?? "")}</password>`,
    `    </server>`,
    CLOSE("server"),
  ].join("\n    ");
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Remove one fenced block and the line break that carried it. */
function strip(xml: string, what: "mirror" | "server"): string {
  const re = new RegExp(
    `\\n?[ \\t]*${OPEN(what).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${CLOSE(what).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  return xml.replace(re, "");
}

/** Insert `body` as the last child of `<section>`, creating the section before `</settings>` when absent. */
function insert(
  xml: string,
  section: "mirrors" | "servers",
  body: string,
): string {
  const close = `</${section}>`;
  const i = xml.lastIndexOf(close);
  if (i >= 0) return `${xml.slice(0, i)}${body}\n  ${xml.slice(i)}`;
  const end = xml.lastIndexOf("</settings>");
  if (end < 0) throw new Error("settings.xml has no </settings>");
  return `${xml.slice(0, end)}  <${section}>\n    ${body}\n  </${section}>\n${xml.slice(end)}`;
}

/** Set the blocks (replacing any earlier ones); an empty or absent file gets the skeleton. */
export function setLink(xml: string | undefined, link: Link): string {
  let out = unsetLink(xml?.trim() ? xml : SKELETON);
  out = insert(out, "mirrors", block("mirror", link));
  if (link.token !== null) out = insert(out, "servers", block("server", link));
  return out;
}

/** Remove the blocks; a section the core created and that is now empty goes too. */
export function unsetLink(xml: string | undefined): string {
  if (!xml) return "";
  let out = strip(strip(xml, "mirror"), "server");
  for (const section of ["mirrors", "servers"])
    out = out.replace(
      new RegExp(`\\n?[ \\t]*<${section}>\\s*</${section}>`),
      "",
    );
  return out;
}

export const hasLink = (xml: string): boolean => xml.includes(OPEN("mirror"));

/** Which profiles a settings file declares and activates, for the Profiles tab. */
export function settingsProfiles(xml: string): {
  declared: string[];
  active: string[];
} {
  const clean = xml.replace(/<!--[\s\S]*?-->/g, "");
  const declared = [
    ...(/<profiles>([\s\S]*?)<\/profiles>/.exec(clean)?.[1] ?? "").matchAll(
      /<profile>[\s\S]*?<id>([^<]+)<\/id>/g,
    ),
  ].map((m) => m[1]!.trim());
  const active = [
    ...(
      /<activeProfiles>([\s\S]*?)<\/activeProfiles>/.exec(clean)?.[1] ?? ""
    ).matchAll(/<activeProfile>([^<]+)<\/activeProfile>/g),
  ].map((m) => m[1]!.trim());
  return { declared, active };
}

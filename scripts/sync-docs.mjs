#!/usr/bin/env node
// The guide pages that are an extension's README: the README is the source,
// the page is written from it with a line naming the extension. Run by
// `task recu`, so the pre-commit hook keeps both in step; edit the README,
// never the page.
import { readFileSync, writeFileSync } from "node:fs";

const PAGES = {
  "che-clipboard": ["docs/guide/che/clipboard.md", "in the [Che pack](./)."],
  "che-notify": ["docs/guide/che/notify.md", "in the [Che pack](./)."],
  "che-remote-ssh": [
    "docs/guide/che/remote-ssh.md",
    "installed in the editor on your machine, not in the [Che pack](./).",
  ],
};

for (const [ext, [page, intro]] of Object.entries(PAGES)) {
  const [title, ...body] = readFileSync(
    `extensions/${ext}/README.md`,
    "utf8",
  ).split("\n");
  const out = [
    title,
    "",
    `<!-- Generated from extensions/${ext}/README.md by scripts/sync-docs.mjs: edit the README. -->`,
    "",
    `\`batlehub.${ext}\` — ${intro}`,
    ...body,
  ].join("\n");
  writeFileSync(page, out);
}

# BatleHub Theme (`batlehub-theme`)

BatleHub's colour theme in the editor: **BatleHub Dark**, **BatleHub Light**
and **BatleHub High Contrast**, from BatleHub's own design system
(`batlehub/batlehub`, `DESIGN.md`, §Colors). RFC 0014.

Pick one with `Preferences: Color Theme`. Nothing installs or recommends it:
a colour theme is a personal choice, and the Java pack leaves the setting
alone.

## What the colours mean

One hue, one meaning — the same four voices in the chrome and in Java:

| Voice                   | Where it lands                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| **Signal Crimson**      | links, the one primary action, the selected edge — and **never** an error                           |
| a derived **error** red | "this is broken": squiggles, the Problems list, `invalid` scopes                                    |
| **Aged Copper**         | pending or held: modified files, warnings, and in Java strings, numbers and annotations             |
| **Signal Amber**        | the focus ring, and nowhere else                                                                    |
| **ink** / **dim ink**   | types and declarations in ink; everything ordinary, including keywords, in dim ink; comments italic |

Crimson is the action colour and stays off every error key: the same hue on
the `Run` button and under a syntax error would say "do this" and "this is
broken" at once. Errors take the editor's conventional red, moved in
lightness until it holds its contrast on the BatleHub ground and rotated
toward orange far enough that the eye reads two colours.

## The files are generated

`themes/*.json` is the output of `scripts/derive.mjs` and is never edited by
hand.

```
themes/tokens.json          the DESIGN.md token block, copied with the commit it came from
themes/base-defaults.json   the editor's own colour defaults for the pinned VS Code
scripts/derive.mjs          the rule table; pnpm run derive rewrites the three themes
test/contrast.test.ts       every ratio, every rule, and the committed files against derive()
```

A palette change is a `tokens.json` bump, `pnpm run derive`, three reviewed
diffs and a green `pnpm test`. The nightly compares the recorded `DESIGN.md`
commit with upstream and opens one drift issue; it never bumps by itself.

`base-defaults.json` is extracted once per VS Code pin —
`node scripts/base-defaults.mjs --vscode <server-web dir>` — and regenerated
in the PR that moves `VSCODE_VERSION` in `tests/heavy/view.sh`.

## What the test holds

- Every ratio `DESIGN.md` states for a pair that lands in the editor: ink
  ≥ 16:1, dim ink ≥ 5.28:1, crimson ≥ 5.6:1, amber ≥ 13:1 (dark) / 4.4:1
  (light), the strong rule ≥ 3.4:1, counter-ink on crimson ≥ 5.6:1, and
  ≥ 7:1 for every text pair in high contrast.
- **Every colour the theme inherits.** The editor supplies close to a
  thousand of them and each was chosen for another ground; the moment the
  theme changes the ground it owns the pair. Each is measured against every
  BatleHub ground, and one that falls short is promoted into the theme by
  DESIGN.md's Re-Derived Lightness Rule — the hue survives, the lightness is
  re-derived. That is where most of the entries in `colors` come from, and a
  colour VS Code adds tomorrow is swept the day it appears.
- The named rules: One Synthetic (crimson on its own keys, in no syntax
  voice, on no error key), Counter-Ink, Undependable Fill, In-Gamut.

There is no runtime code: `contributes.themes` and three JSON files.

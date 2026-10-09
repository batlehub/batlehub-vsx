# BatleHub Seasons

`batlehub.batlehub-seasons` — the editor notices what day it is. It is **not**
in the Java pack, nothing in BatleHub Java needs it, and the design is
[RFC 0019](/rfc/0019-batlehub-seasons).

While a window is open on one of its days, the title bar, activity bar and
status bar take the season's colours, and the window title gains a glyph — so
the pumpkin shows in the browser tab of a che-code workspace, and in the title
bar too if you have the command centre off (with it on, the title bar renders
the command centre instead of the window title). A status bar item on the
right names the season; clicking it turns seasons off.

Editing `batlehub.seasons.*` takes effect straight away. The *date* is read
once when the window starts, so a window that begins at midnight shows up the
next time you reload — which for a Che workspace is usually the next morning
anyway.

## The six it ships with

| Window               | Days          | Glyph |
| -------------------- | ------------- | ----- |
| Halloween            | 10-24 → 11-01 | 🎃    |
| Christmas            | 12-15 → 12-26 | 🎄    |
| New Year             | 12-28 → 01-02 | 🎆    |
| April Fools          | 04-01         | 🃏    |
| Fête de la Musique   | 06-21         | 🎶    |
| Fête Nationale       | 07-14         | 🇫🇷    |

Both bounds are inclusive, and the dates are fixed: nothing here moves with
the year, so there is no Easter and no "third Thursday of November". If you
want one, write the next few years out as separate entries — five literal
dates are easier to check than a formula.

## Your own days

```jsonc
"batlehub.seasons.events": [
  {
    "name": "Release week",   // what the status bar shows
    "from": "03-10",          // MM-DD, inclusive
    "to": "03-14",            // MM-DD, inclusive
    "glyph": "🚢",            // one or two characters
    "background": "#1b3a8f",  // chrome background
    "foreground": "#f4f7ff"   // chrome foreground
  }
]
```

Your entries are checked **before** the shipped ones, so an entry here shadows
a default it overlaps — a birthday on the 25th of December wins over
Christmas. Among your own, the first one in the array wins.

`to` earlier than `from` is a window that crosses the year, which is how New
Year works: `12-28 → 01-02`.

Set background and foreground as a pair. The extension replaces both on every
widget it touches, which is why one pair works under any theme — and why a
light foreground on a light background is legible nowhere. The six shipped
pairs all clear 4.5:1; yours are yours.

A malformed entry is skipped, not fatal: the others still apply, and the
`BatleHub Seasons` output channel says which one was dropped and why.

## Settings

| Setting                       | Default | Does                                           |
| ----------------------------- | ------- | ---------------------------------------------- |
| `batlehub.seasons.enabled`    | `true`  | the master switch                              |
| `batlehub.seasons.title`      | `true`  | also prefix `window.title` with the glyph      |
| `batlehub.seasons.events`     | `[]`    | your own windows; empty means the six defaults |
| `batlehub.seasons._saved`     | `null`  | written by the extension — see below           |

All four are **user settings only**. A repository cannot set them: an
`events` array a project could define would let it pick your workbench
colours and your window title, and the window title is the string you read to
know which project you are in.

To turn the seasons off entirely, use `enabled`. An empty `events` array is
not an off switch — it means "the six defaults", the same as leaving it out.

## Commands

| Command                                   | Does                                           |
| ----------------------------------------- | ---------------------------------------------- |
| `Seasons: Remove BatleHub seasons settings` | lists what it will put back, asks, then does it |
| `Seasons: Disable until next year`        | what the status bar item clicks: `enabled` off, everything restored |

## What it writes, and how it comes back

Eight colour keys of `workbench.colorCustomizations` —

```
titleBar.activeBackground      titleBar.activeForeground
titleBar.inactiveBackground    titleBar.inactiveForeground
activityBar.background         activityBar.foreground
statusBar.background           statusBar.foreground
```

— and `window.title`. Both at **global scope**, in your user `settings.json`,
never at workspace scope: in a Che workspace `.vscode/settings.json` is
usually tracked by git, and an orange title bar is not a commit you want.

The colour keys are *merged*, so a colour you set yourself in
`colorCustomizations` is untouched unless it is one of the eight — and if it
is, its old value is saved and written back. `window.title` is one string, so
there the glyph does replace your value; the previous one is saved verbatim
and restored verbatim, and `batlehub.seasons.title: false` opts out.

Before either write, the values that were there go into
`batlehub.seasons._saved`, which distinguishes "this key was absent" from
"this key had a value" — so restoring deletes the first and writes the second
back. That record is replayed **every time a window starts**, not only when a
season ends: a window killed on the 31st of October and reopened in March
finds its own leftovers and removes them before doing anything else.

If `_saved` is ever unreadable, the extension does nothing at all and says so
rather than guessing — guessing is how your own `window.title` would get
destroyed.

## It never touches the editor surface

No `editor.background`, no `editor.foreground`, no syntax colours. The eight
keys above are fixed in the code, not configurable. The
[BatleHub theme](/guide/theme) promises contrast ratios on the surface you
read code on, and a seasonal tint there would quietly turn those ratios into
whatever the season felt like.

## One sharp edge

**Uninstalling while a season is active leaves the colours behind.** The
extension is gone, so it cannot run its own undo. Disable or remove first
(either command above), or delete these two keys from your user
`settings.json` by hand:

```jsonc
"workbench.colorCustomizations": { /* the eight titleBar/activityBar/statusBar keys */ },
"window.title": "…",
"batlehub.seasons._saved": { /* delete this too */ }
```

`_saved` is a setting rather than hidden extension storage partly for this
reason: recovering from it needs no extension at all, just the file in front
of you.

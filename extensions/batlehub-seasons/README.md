# BatleHub Seasons

The editor notices what day it is.

On Halloween, Christmas, New Year, April Fools, the Fête de la Musique and the
Fête Nationale, the title bar, activity bar and status bar take the season's
colours and the window title gains a glyph — so the pumpkin shows in the
browser tab of a che-code workspace, and in the title bar too when the command
centre is off. A status bar item names the
season and turns it off.

Add your own in `settings.json`:

```jsonc
"batlehub.seasons.events": [
  { "name": "Release week", "from": "03-10", "to": "03-14", "glyph": "🚢",
    "background": "#1b3a8f", "foreground": "#f4f7ff" }
]
```

Your entries are checked before the shipped ones, so an entry here shadows a
default it overlaps. `from` and `to` are `MM-DD` and inclusive; `to` earlier
than `from` crosses the year.

**Everything it writes, it saves first.** The eight colour keys and
`window.title` go into `batlehub.seasons._saved` with the values that preceded
them, and that record is replayed at every start — so a window closed on the
31st of October and reopened in March finds its own leftovers and removes them.
`Seasons: Remove BatleHub seasons settings` does it on demand.

The design is [RFC 0019](../../docs/rfc/0019-batlehub-seasons.md). It writes at
global scope on purpose, and never touches the surface you read code on.

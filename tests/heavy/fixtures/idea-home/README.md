# `idea-home` — the IDEA configuration directory the suite reads

RFC 0007 use case 2 reads *user-level* live templates, and §4.2 says they come
from outside the workspace: this directory is copied to
`$HEAVY_WORK/config-java` and handed to the editor as `XDG_CONFIG_HOME`, which
is where IDEA itself looks on Linux. It is not part of the fixture workspace,
and the import must refuse a directory that is.

`templates/user.xml` holds five templates on purpose: `sout` (`$END$` only),
`psvm` (a declaration context), `fori` (a repeated `$INDEX$` with a default),
`iter` (`iterableVariable()`, which has no snippet equivalent and must be
*listed* while the template still ships), and `div` (an HTML context, which
must be skipped). Four snippets out, one skipped, one note.

RFC 0007 use case 4 reads the user's keymap from the same place:
`keymaps/Max.xml` is the developer's diff from `$default` — `Generate` on
Alt+Insert, `RenameElement` on Shift+F6, and `CompareTwoFiles`, which has no
command and must be listed — and `options/keymap.xml` marks it active, as IDEA
does. The workspace fixture commits `.idea/keymaps/Evil.xml`: the import must
never read it, keymaps being user-level.

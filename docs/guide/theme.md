# The BatleHub theme

`batlehub.batlehub-theme` — three colour themes, from BatleHub's own design
system. It is **not** in the Java pack and the pack does not recommend it: a
colour theme is a personal choice, and nothing in BatleHub Java needs it.

Install it from the gallery, then `Preferences: Color Theme`:

| Theme                      | For                                         |
| -------------------------- | ------------------------------------------- |
| **BatleHub Dark**          | the warm near-black ground of BatleHub's UI |
| **BatleHub Light**         | the same hues on paper                      |
| **BatleHub High Contrast** | the same again at AAA, with strong borders  |

## One hue, one meaning

| Colour         | Says                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| Signal Crimson | links, the one primary action, the selected edge                            |
| a derived red  | this is broken — squiggles, the Problems list, `invalid` scopes             |
| Aged Copper    | pending or held — modified files, warnings; in Java strings and annotations |
| Signal Amber   | the focus ring, and nothing else                                            |
| ink / dim ink  | types and declarations in ink, everything ordinary in dim ink               |

Crimson never means "broken". The same hue on the `Run` button and under a
syntax error would say "do this" and "this is broken" at once, so errors take
the editor's conventional red — moved in lightness until it holds its contrast
on the BatleHub ground, and rotated toward orange far enough that the eye
reads two colours rather than one.

Keywords are dim ink, not a colour of their own: the design system's dim ink
"carries everything ordinary", and crimson has four jobs, none of them "the
most common token on screen".

## It writes nothing

There is no code in the extension — `contributes.themes` and three JSON files.
It writes no setting, reads no file and reaches no network. Your theme choice
lives in `workbench.colorTheme`, which is yours;
`Java: Remove BatleHub settings` has nothing to undo.

To go back, pick another theme. To remove it, uninstall the extension.

## If a colour looks wrong

The three files are generated from one token block and every ratio is held by
a test, so a colour that looks wrong is a bug worth reporting rather than a
setting to override. `extensions/batlehub-theme/README.md` has the derivation
and how to re-run it.

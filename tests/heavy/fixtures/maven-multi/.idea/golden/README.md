`Greeter.formatted.java` is `core/src/main/java/com/acme/core/Greeter.java` as
**IntelliJ IDEA 2026.1.3 formats it** with the `codeStyles/Project.xml` beside
it — produced once, by IDEA's own headless formatter
(`idea/bin/format.sh -s <the scheme> Greeter.java`), and committed.

It is the acceptance case of [RFC 0007](../../../../../docs/rfc/0007-intellij-import-full.md)
use case 1: after `Java: Import from IntelliJ` → *Code style*, `Format
Document` on `Greeter.java` must produce this file byte for byte. That is the
only thing that says the mapping table is right — a converter can satisfy
every unit test and still not agree with the editor it is imitating.

`Greeter.fixed.java` is the same file after `Java: Fix all inspections in
file` — what the bundle's `Engine.applyFixAll` produces, held by
`InspectionsTest.fixAllOnTheHeavyFixtureIsItsGolden` and compared to the
editor's buffer by `INSPECTIONS-OK`. The headless answer was always right; it
is the LSP edits the editor applies that once dropped every copied receiver.

Both live here, and not beside `Greeter.java`, because `javac` refuses a public
class whose file is not `<class>.java`: in a source root it would break the
fixture's own Maven build.

# Generate: builders, with methods, and the rest

The editor's context menu has a **Generate** submenu (`Java: Generate…`).
Every entry asks its options through the quick input, pre-selected from your
settings, and writes **one unsaved edit**: one `Ctrl+Z` takes it all back.
Design: [RFC 0015](../../rfc/0015-generate-shortcuts.md); the list of what is
built comes from Team A's diary.

| You want | Entry | Who answers |
| --- | --- | --- |
| Getters and setters, with prefixes and fluent setters | Getters and setters… | BatleHub's bundle |
| A builder | **Builder…** | BatleHub's bundle |
| `with…` methods | **With methods…** | BatleHub's bundle |
| Constructors | Constructors… | Red Hat's prompt |
| `toString()` | toString()… | Red Hat's prompt (`java.codeGeneration.toString.*`) |
| `equals()` / `hashCode()` | hashCode() and equals()… | Red Hat's prompt (`java.codeGeneration.hashCodeEquals.*`) |
| Delegate methods | Delegate methods… | Red Hat's prompt |
| Wrap statements in `try`, `if`, `for`… | **Surround with…** | BatleHub's bundle |

## Builder…

Put the cursor in a class, then **Generate ▸ Builder…**:

1. **Fields** — every instance field is picked; untick the ones the builder
   should not set. A `final` field without an initializer is included (the
   builder is how it gets set); a `final` field that already has one is not.
2. **Method names** — `withName(…)`, `setName(…)` or `name(…)`.
3. **Placement** — an **inner class** (`Customer.builder().withName("x").build()`;
   it can call the type's private constructor) or **its own file**
   (`CustomerBuilder.java` beside the type; the constructor becomes
   package-private). A file that already exists is never overwritten.

```java
public static Builder builder() { return new Builder(); }
private Customer(Builder b) { this.name = b.name; this.id = b.id; … }
public static final class Builder {
    private String name;
    …
    public Builder withName(String name) { this.name = name; return this; }
    public Customer build() { return new Customer(this); }
}
```

**Run it again after adding a field**: only that field's builder field,
method and constructor assignment are added. Nothing you wrote or edited is
rewritten.

## With methods…

- **Return a copy** — `withX(x)` returns a new instance. On a record it uses
  the canonical constructor (the only form a record allows). On a class it
  needs a constructor taking every field; when there is none, the command says
  so and offers **Generate a constructor** (Red Hat's prompt) first.
- **Set and return this** — assigns and returns `this`; `final` fields are
  skipped, and a record is refused (it has no assignable field).

## Surround with…

Select statements (or just put the cursor in one), then **Java: Surround
with…** (also in the Generate submenu) and pick a construct: `try / catch`,
`try / finally`, `try-with-resources`, `if`, `if / else`, `while`, `for`,
`synchronized`, or a `Runnable` lambda.

- **The selection is widened to whole statements** of one block: start
  mid-way through a statement, end before a semicolon — the statements you
  touched are what moves. Their comments and formatting move with them; only
  the indentation changes.
- **A local used after the selection is hoisted**: `int b = a + 1;` inside a
  `try` becomes `int b;` above it and `b = a + 1;` inside, so the code after
  still compiles. Declared with `var`, it cannot be hoisted without its type:
  the command says so and changes nothing.
- **`try / catch` names what is thrown**: the checked exceptions of the
  statements (`catch (IOException | InterruptedException e)`, imported when
  needed) once the project is resolved; `Exception` before, and a line in the
  `BatleHub Java: JDT` channel says which answer it gave. Set
  `batlehub.java.generate.surroundWith.catchType` to `Exception` to always
  catch `Exception`.
- **`try-with-resources`** takes the first selected statement as the resource
  — it must declare an `AutoCloseable` with an initializer.
- Conditions are left for you: `if (/* condition */ true)`,
  `for (int i = 0; i < /* n */ 0; i++)`.

No default key binding: the IntelliJ keymap (`Ctrl+Alt+T`) is the keymap
extension's to give; bind `batlehub.java.surroundWith` yourself otherwise.

## Lombok

Where `lombok` is on the module's classpath, **Builder…** and **With
methods…** first offer `@Builder (Lombok)` / `@With (Lombok)` — the
annotation and its import, nothing else — or generated code. Lombok is never
added to a project that does not already use it. If the class already has a
hand-written `Builder`, the annotation is refused (it would clash).

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `batlehub.java.generate.builder.methodPrefix` | `with` | `with`, `set`, or empty (bare names); used by both generators |
| `batlehub.java.generate.builder.placement` | `inner` | `inner` or `file` |
| `batlehub.java.generate.builder.lombok` | `offer` | `offer`, `always` (take the annotation without asking), `never` |
| `batlehub.java.generate.withers.style` | `copy` | `copy` or `mutate` |
| `batlehub.java.generate.surroundWith.catchType` | `precise` | `precise` or `Exception` |

The entries need the language server in **Standard** mode, like every
BatleHub generator.

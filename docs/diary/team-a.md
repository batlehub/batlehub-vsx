# Team A — Spring Boot, Quarkus

First to switch. Two lists only this team can give are owed here before the
RFCs that depend on them are written further:

- **the ten shortcuts they use most** (builders, `with` methods, surround-with,
  live templates…) — the first section of [RFC 0015](/rfc/0015-generate-shortcuts);
- **the inspections they rely on** — the first section of
  [RFC 0016](/rfc/0016-inspections-growth).

And one measurement: the peak memory of the editor, JDT.LS, one framework
server and a running build on **their largest real project**, against the
8 GiB request a Java workspace is scheduled with (RFC 0001 §11 decision 1).

## Entries

### 2026-10-10 — the generators they use (RFC 0015 §2.1)

Relayed by the maintainer. The team uses **every generator** in this list:
builder, `with…` methods, `equals`/`hashCode`, `toString()`, constructors,
delegate methods (and getters/setters, already built). **Lombok is used in
some projects, not all.** The options they expect are the ones named: the
builder's placement (inner class or its own file), the naming of the
`with…` methods (`with`, `set`, bare), and how `final` fields are treated.

**Surround-with** (`Ctrl+Alt+T`: wrap a selection in `try`/`catch`, `if`,
`for`…) is used too — confirmed by the maintainer the same day.

Still owed from this team: the inspections they rely on (RFC 0016), and the
peak-memory measurement on their largest project.

# Team diaries

The goal of the Java extensions is that a developer leaving IntelliJ stops
missing it (RFC 0001 §7.1). Whether that is true is not decided in an RFC: it
is written down here, by the teams making the switch, one dated entry at a time.

An entry says **what was tried, what was missing, and which row of
[Appendix A](/rfc/0001-java-env#appendix-a-—-gap-inventory-what-vs-code-lacks-to-be-a-better-java-tool)
it maps to**. The diary is what pulls a trigger:

- a gap with no row in Appendix A gets one added;
- **three dated entries** against the same gap un-park the RFC that closes it
  (or open one);
- a false positive recorded against an inspection keeps that rule at
  `information` severity ([RFC 0016](/rfc/0016-inspections-growth)).

| Team | Stack | Diary |
| --- | --- | --- |
| A | Spring Boot, Quarkus, generate shortcuts, cspell | [team-a](/diary/team-a) |
| B | Kotlin, Scala | [team-b](/diary/team-b) |

## The entry

```md
### YYYY-MM-DD — <who, or a role>

- **Tried:** <what they were doing, in IntelliJ's words if that is how they think of it>
- **Missing / wrong:** <what happened instead>
- **Row:** A.n — <the row>, or "no row" (then add one)
- **Memory:** <peak RSS from Report a problem, when the entry is about the pod>
```

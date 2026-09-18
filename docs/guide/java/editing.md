# Completion, and the chain

The Java pack does not replace `redhat.java`'s completion — it turns on a
part of it that ships switched off.

## Chained-call completion

IntelliJ proposes `getConfig().getServer().getPort()` as one item when an
`int` is expected, by walking from what is in scope to the type the cursor
needs. JDT.LS has had the same thing since 1.61 — a port of JDT UI's Code
Recommenders chain finder — behind `java.completion.chain.enabled`, which
is `false` by default and sits among thirty other `java.completion.*` keys.
Almost nobody finds it.

**BatleHub Java turns it on for you**, and says so once:

> Chain completion turned on (`java.completion.chain.enabled`) — press the
> completion shortcut where a value is expected. **Undo** · **Keep it**

Then, with the cursor after `String s = `:

```java
Greeter g = new Greeter();
String s = ⎸          // Ctrl+Space  →  g.all()
```

The chain is one item; accepting it inserts the whole expression. No import
is ever added — every step of a chain starts from something already in
scope.

::: tip It is on the shortcut, not on typing
The server's computer runs on **explicit invocation only** — `Ctrl+Space`
(`Cmd+I` on macOS) — because walking the type graph is expensive. Typing
`g.al` and waiting will not produce a chain; press the shortcut.
:::

## What the write is, exactly

It is a *default-on* write, and it obeys every clause of that rule:

| Clause | What it means here |
| --- | --- |
| Workspace scope | `.vscode/settings.json` of the first folder, never your user settings |
| Through the manifest | `.batlehub/java/written.json` records that the key was **absent** before |
| Announced once, with its undo | the panel line above, until you press `Undo` or `Keep it` |
| Never over a value you set | if `java.completion.chain.enabled` is already set anywhere — to `true` as much as to `false` — nothing is written, nothing is recorded and no line appears |

That last row is the important one: a value BatleHub Java did not write is
not BatleHub Java's to manage, so [`Java: Remove BatleHub
settings`](/guide/java/removal) can never delete a value you chose.

## Turning it off

Three ways, and they are not the same:

- **`Undo`** in the panel line — restores the key to unset and drops that
  one entry from the manifest, leaving every other write alone. The key is
  then not written again in this workspace.
- **Setting it yourself** to `false` — your value stands, at any scope.
- **[`Java: Remove BatleHub settings`](/guide/java/removal)** — replays the
  whole manifest, this key with it.

## What it costs

The heavy suite measures it on every run and prints both numbers: the
median of ten completion round trips with chains on, and the same with them
off. The gate is 800 ms; the delta is what the feature actually costs on
the `maven-multi` fixture, and it is in the run's `PERF-GATE` line rather
than in anyone's opinion.

If completion feels slow on a large project, `java.completion.chain.enabled`
is the first key to try switching off — and please open an issue with the
two numbers from `BatleHub Java: Show log` (`completion round trip N ms`),
because that is the measurement that decides whether the pack grows its own
chain provider with a budget.

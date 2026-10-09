# Completion, and the chain

The Java pack does not replace `redhat.java`'s completion — it adds one
kind of item to it: the chain.

## Chained-call completion

IntelliJ proposes `config.getServer().getPort()` as one item when an `int`
is expected, by walking from what is in scope to the type the cursor needs.
BatleHub Java does the same, **while you type**:

```java
Config config = new Config();
int port = g⎸         // →  config.getServer().getPort()
String host = ⎸       // →  config.getServer().getHost()
```

The chain is one item; accepting it inserts the whole expression. No import
is ever added — every step of a chain starts from something already in
scope. Only members without parameters make a chain; `getById(id)` ends
none.

Chains sort **after** every ordinary proposal that matches what you typed
equally well — a local of the right type is always above a chain — and
among themselves by where they start (a local, then a field of this class,
then the rest), then by length.

## Three modes

`batlehub.java.completion.chain` picks the one source of chains:

| Mode | What answers | When |
| --- | --- | --- |
| `auto` (default) | BatleHub's JDT bundle, over the server's own chain finder | every completion, typing or `Ctrl+Space`; `int`, `String` and project types |
| `shortcut` | `redhat.java`'s own chain computer (`java.completion.chain.enabled`) | `Ctrl+Space` (`Cmd+I` on macOS) only; project reference types only |
| `off` | nothing | — |

`auto` exists because the server's computer refuses the cases IntelliJ
users reach for most: it proposes nothing for an `int` or a `String`, and
it sorts every chain last. The bundle calls the same finder without that
refusal, and with a time budget:

- **`batlehub.java.completion.chainBudgetMs`** (`150`) — one search never
  takes longer; past it you get the chains found so far, and the last item
  says `chains truncated at 150 ms`. `0` hands the budget to the server's
  3 s.
- **`batlehub.java.completion.chainMaxDepth`** (`3`) — every segment
  counts: `config.getServer().getPort()` is 3.

`auto` needs the JDT bundle loaded (the server in Standard mode). Without
it, it proposes no chains, and the `BatleHub Java: JDT` channel says so
once.

## What `shortcut` writes, exactly

In `shortcut` mode the core turns the server's key on for you, and says so
once:

> Chain completion turned on (`java.completion.chain.enabled`) — press the
> completion shortcut where a value is expected. **Undo** · **Keep it**

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

Switching to `auto` or `off` takes that write back (the key returns to
unset, the server's default `false`), so the two sources never both answer.
If **you** set `java.completion.chain.enabled` to `true`, your value
stands: the server's computer answers on the shortcut and `auto` stands
down rather than doubling every chain.

## Turning it off

- **`batlehub.java.completion.chain: "off"`** — no chains from either
  source.
- In `shortcut` mode, **`Undo`** in the panel line — restores the key to
  unset and drops that one entry from the manifest. The key is then not
  written again in this workspace.
- **[`Java: Remove BatleHub settings`](/guide/java/removal)** — replays the
  whole manifest, this key with it.

## What it costs

The heavy suite measures both modes on every run. `shortcut`: the median of
ten completion round trips with chains on and off, gated at 800 ms.
`auto`: the median of ten provider round trips while typing, cold cache,
gated at 150 ms. Both are in the run's `PERF-GATE` line.

If completion feels slow on a large project, lower `chainMaxDepth` or
`chainBudgetMs` first; `BatleHub Java: Show the JDT log` at `debug` prints
every chain round trip (`chain delegate N ms`), and that is the number to
put in an issue.

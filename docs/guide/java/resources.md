# The container's resources

A Che workspace is a memory budget, not a laptop. JDT.LS, a Gradle daemon, a
Groovy server and Maven in one container whose `memoryLimit` nobody set is an
`OOMKilled` pod, and it reads as "VS Code cannot do Java".

At activation the core reads the cgroup limit — `/sys/fs/cgroup/memory.max`,
or cgroup v1's `memory/memory.limit_in_bytes`; absent on a laptop — and adds
up what this workspace is about to run:

| Consumer | Counted as |
| --- | --- |
| The editor's server, the shell, the JVM's off-heap | 768 MiB |
| JDT.LS | the `-Xmx` of `java.jdt.ls.vmargs` (default 2 GiB) |
| A Gradle daemon | 512 MiB, when the workspace has a Gradle build |
| The Groovy language server | 512 MiB, when `java-groovy` is installed |

Below `batlehub.java.resources.warnBelow` (default `2Gi`), or whenever the
sum exceeds the limit, the status bar turns `⚠` once per session and the
JDK tab names what gets killed first (the biggest consumer). `Java: Show the
container's resources` prints the table to the log. Empty `warnBelow`
disables the threshold; the over-limit warning stays.

## What to put in the devfile

The extension never edits the devfile; you do, then restart the workspace.
For a Java workspace with Maven or Gradle and the Groovy satellite:

```yaml
components:
  - name: tools
    container:
      memoryRequest: 2Gi
      memoryLimit: 4Gi   # 6Gi with Gradle and Groovy both active
      env:
        - name: JAVA_TOOL_OPTIONS
          value: "-XX:MaxRAMPercentage=50"
```

and, in the workspace settings, an `-Xmx` that fits under it:

```jsonc
"java.jdt.ls.vmargs": "-XX:+UseParallelGC -XX:GCTimeRatio=4 -XX:AdaptiveSizePolicyWeight=90 -Dsun.zip.disableMemoryMapping=true -Xmx1500m -Xms100m -Xlog:disable"
```

| Limit | Fits |
| --- | --- |
| 2 GiB | JDT.LS at `-Xmx1G`, Maven; no Gradle daemon, no Groovy server |
| 4 GiB | JDT.LS at the default `-Xmx2G`, one of Gradle or Groovy |
| 6 GiB | everything |

Measured in this repository's own workspace (16 GiB limit) the warning is
silent; the numbers above are the floors, not measurements of your project.

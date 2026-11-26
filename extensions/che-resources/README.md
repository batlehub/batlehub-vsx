# Che Resources

A warning before the workspace runs out of room.

An [Eclipse Che](https://eclipse.dev/che/) workspace runs inside a pod's
limits. `node_modules`, `target` or a build cache fill the projects' volume
without a sound, a build eats the memory limit, a test suite forks until
`pids.max` — and the first sign is `ENOSPC`, an OOM kill or
`fork: Resource temporarily unavailable`. This extension reads those
resources every minute and, when one goes over its threshold:

- shows a warning notification, once per crossing — it warns again only after
  the resource has come back under its threshold and crossed it anew;
- keeps a status bar item with every resource over its threshold, for as long
  as it stays there.

## What is read

| Resource | Used | Against | Default threshold |
|---|---|---|---|
| `disk` | space of each disk holding a git project | its size, minus what is reserved for root | `95` (5 % free) |
| `inodes` | inodes of the same disks | their inode count | `95` |
| `memory` | the working set: `memory.current` minus the page cache that can be dropped (`inactive_file`) — what the OOM killer counts | `memory.max`, or the host's memory without a limit | `90` |
| `cpu` | CPU time, averaged over one check interval | the quota of `cpu.max`, or every CPU without one | `0` (off) |
| `pids` | `pids.current` | `pids.max`; nothing is read without a limit | `90` |

Memory, CPU and processes are read from the container's cgroup (v2, under
`/sys/fs/cgroup`), so they are the pod's limits, not the node's; outside a
container, memory and CPU fall back to the host's.

The disks are those of the workspace's git projects: every workspace folder
that is a git repository, or holds some one level down, plus the folders one
level under `$PROJECTS_ROOT` (`/projects` in Che). Projects on the same
filesystem count as one disk.

CPU is off by default: a build is meant to use the CPU, and a warning at each
one is noise. Turn it on when a runaway process is what you are watching for.

## Settings

Each threshold is a percentage of the limit; `0` turns that warning off.

| Setting | Default |
|---|---|
| `cheResources.disk.threshold` | `95` |
| `cheResources.inodes.threshold` | `95` |
| `cheResources.memory.threshold` | `90` |
| `cheResources.cpu.threshold` | `0` |
| `cheResources.pids.threshold` | `90` |
| `cheResources.intervalSeconds` | `60` — how often everything is read; the CPU is averaged over it |

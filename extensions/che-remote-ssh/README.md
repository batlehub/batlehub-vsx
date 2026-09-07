# Che Remote SSH

Connect this editor over SSH to an [Eclipse Che](https://eclipse.dev/che/)
workspace running on plain Kubernetes.

Red Hat's `devspaces-remote-ssh` does this for OpenShift Dev Spaces only. It
resolves the cluster by expecting `/oauth/start` to redirect to a host named
`oauth-openshift.apps.<domain>`, then derives `https://api.<domain>:6443` from
it; a Che behind any other identity provider fails that step with *"The API
URL does not appear to be valid"*. Past it, the extension logs in with
`oc login --web` and lists workspaces through OpenShift's Project API, neither
of which exists on a vanilla cluster.

This extension reads the same redirect, but for what it actually carries: the
OIDC client id the apiserver is configured to trust, and the provider that
issued it. Everything after that is standard Kubernetes.

## Its own kubeconfig, or yours

By default `~/.kube/config` is never read and never written. The credential
goes into a file under this extension's storage, and every `kubectl` runs with
`--kubeconfig` naming it. Uninstalling takes the credential with it.

You can also point it at a kubeconfig of your own. "Use an existing
kubeconfig" asks for the file, lists the contexts in it by asking kubectl,
and writes the choice to `cheRemoteSsh.kubeconfig` and `cheRemoteSsh.context`
so it stays visible and editable afterwards. That file is then used exactly as it is and never
written to, whatever credential it holds: client certificates, a service
account token, an exec plugin. No sign-in happens at all in that mode, and
signing out leaves the file alone. It is opt-in by path, so your default
kubeconfig is never picked up on its own.

That file holds a short-lived `id_token` and nothing else. The OIDC client
secret and the refresh token stay in the editor's `SecretStorage`. Delegating
to `kubectl oidc-login` would have meant putting the client secret in the exec
plugin's arguments, in clear, in the kubeconfig.

Sign-in uses the device authorization grant (RFC 8628), so no redirect URI has
to be declared in the provider for this extension to work.

## What it discovers

From the Che URL alone:

| | how |
|---|---|
| OIDC client id | the `client_id` in the `/oauth/start` redirect |
| identity provider | the discovery document whose `authorization_endpoint` is the one Che redirected to |
| API server | probed at port 6443 on the Che host, confirmed by the Kubernetes `Status` object an anonymous request is answered with |

The client secret is the one thing it has to ask for. None of this runs when
you supply your own kubeconfig.

Which workspaces to offer is found by whichever route the credential allows.
`cheRemoteSsh.namespace` is read directly when set. Otherwise the OIDC path
asks Che which namespaces are yours, because listing them cluster-wide is
refused to an ordinary user and Che already knows; the supplied-kubeconfig
path lists the cluster at once, which that kind of credential usually may do.

## The SSH configuration

`ssh_config` keeps the **first** value obtained for each keyword, not the
last. A `Host *` block at the top of `~/.ssh/config` therefore wins over
everything below it, and a file that opens with

```
Host *
    PubkeyAuthentication no
```

disables key authentication for every host in it, however the entry below is
written. Appending a generated host entry to the end of that file, which is
what the upstream extension does, produces a host that looks correct and
cannot authenticate.

So the generated entries live in a file of this extension's own, its `Include`
is inserted **above** the first `Host` or `Match` line rather than appended,
and each entry states `PubkeyAuthentication yes` instead of relying on the
default.

## The forward

`kubectl port-forward` is owned rather than left running. A forward is
restarted when it dies while a window still wants it, given up on after a few
failures instead of looping, and stopped when the extension unloads. A forward
that binds and dies at once does not refill its restart budget: only one that
stayed up long enough to have worked does.

Connecting also waits until the forward actually accepts a connection. kubectl
returns before its listener is up, and handing the port to SSH straight away is
a race that surfaces as a connection refused with no visible cause.

## The dashboard link

Che offers a link of the form

```
vscode://redhat.devspaces-remote-ssh?namespace=…&podName=…&userName=…&dwName=…&key=…&url=…
```

That extension id is Red Hat's and cannot be claimed, so the editor will
never route it here. Pasting it does. "Connect from a dashboard link" reads
it, "Show what a dashboard link says" only decodes it and shows what it
contains, with the private key reduced to the `SHA256:…` fingerprint
`ssh-keygen -l` would print. The key itself is never displayed.

The link is worth taking because it already carries the pod, the account and
the key. Connecting from it therefore makes none of the three cluster calls
the sidebar route makes: no listing, no `exec`, no reading of the
DevWorkspace. Only the tunnel still needs the API. Every field is validated
before use, since they end up in a command line and in an `ssh_config`.

## Several instances

`cheRemoteSsh.instances` maps a host to the settings for that Che, so the lab
cluster can be reached by certificate while a shared one uses OIDC:

```jsonc
"cheRemoteSsh.instances": {
  "cde.example.dev": { "kubeconfig": "~/.kube/lab.yaml", "context": "lab" },
  "che.corp.example": { "apiServer": "https://api.corp.example:6443" }
}
```

A link names its instance, so pasting one selects the right credential on its
own. An entry only overrides what it sets; anything it leaves out falls back
to the top-level settings, and an unlisted host gets them entirely.

"Use an existing kubeconfig" writes into this table once you say which Che
the file is for, so you never have to edit it by hand. The sidebar shows one
Che at a time, named in the view's title, and "Work against another Che"
switches it. The choice is remembered across restarts.

## When a tunnel closes

A forward is not a capability boundary: whoever can use the generated host
alias already holds the kubeconfig, and `kubectl exec` into the same pod is
strictly more than an SSH shell. Restricting the workspace's sshd would not
help either, since Remote SSH needs exactly the command execution such a
restriction would remove. What matters is therefore not who could use the
tunnel, but how long it stays open.

The editor tells the window that opened a tunnel nothing when the window
using it closes, and they are separate processes. So the connected window
takes a lease: a file it refreshes while it lives and removes when it
unloads. The opener stops any forward no live lease refers to, and forgets
that workspace's key at the same time. A lease also goes stale on age, so a
window that crashes still releases its tunnel.

After a first connection, a notice says so, once: the window you connected
from can be closed without dropping the session. Dismissing it with "Got it"
silences it for good on that machine.

The tunnel outlives the window that opened it. `kubectl port-forward` is
spawned detached and written down in a registry file, so closing the window
you connected from does not drop the session you started from it, and
reconnecting later reuses the tunnel instead of opening a second one onto the
same pod. Any window reclaims what nothing uses, whether or not the window
that opened it still exists, and a recorded pid is checked to still be that
forward before it is ever signalled.

One limit is worth knowing. A remote window opens empty, and the stable API
tells it only that it is `ssh-remote`, never which host. It learns its own
authority from the first remote folder opened in it, and takes no lease
before that. The grace period is ten minutes for that reason, and the
"Close every tunnel" command is there for closing one sooner.

## Where the rules live

`discovery.ts`, `oidc.ts`, `kubeconfig.ts`, `kubectl.ts`, `sshconfig.ts`,
`sshfiles.ts`, `ports.ts`, `portforward.ts`, `lease.ts`, `devspaces-link.ts`,
`sshkey.ts`, `instances.ts` and `exec.ts` import nothing from
`vscode` and are covered by 156 tests (`task ext:test`). `extension.ts`,
`session.ts`, `connect.ts`, `view.ts` and `log.ts` are the editor layer.

## Status

The whole path is wired, by either route: sign in and list the workspaces Che
says are yours, or paste a dashboard link that names one. From there, resolve
the running pod, find a container of it that carries the workspace key, read
the key and the user out of it, hold a forward open, write the SSH entry and
open the remote window.

The container is found by trying, not by reading the DevWorkspace. A
workspace assembled from a `parent` devfile and editor `contributions` has an
empty `spec.template.components`, so the DevWorkspace says nothing about what
runs; the pod does. `/sshd` is a volume shared across the pod, so the first
container that answers serves as well as any other, and the gateway sidecar
is tried last.

The cluster-facing half has been run for real, against a Che on plain
Kubernetes: pod resolution, container selection, key and user reading, the
port-forward, and an SSH login to the workspace as the account the key names.
A detached forward was also verified to survive the process that started it,
with a live SSH session running through the orphaned tunnel.

What has not yet run is the editor half, Remote SSH included.

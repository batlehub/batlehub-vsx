#!/usr/bin/env bash
# Layer 5 of RFC 0001 §10 (phase 8): the contract between java-core and its
# satellite. Two checks:
#   (a) java-groovy type-checks against the *current* core's api.d.ts — the
#       contract test that exists from day one;
#   (b) when tagged releases exist, the last tagged VSIX of each side is
#       installed beside the other's PR build into a scratch VS Code web
#       server, proving the pair installs together (activation is the heavy
#       suite's job). No release yet → SKIP, loudly.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
log() { printf '[contract] %s\n' "$*" >&2; }

# (a)
(cd extensions/java-core && pnpm run api >/dev/null)
(cd extensions/java-groovy && pnpm exec tsc --noEmit -p tsconfig.json) && log "TYPES-OK (java-groovy against the current api.d.ts, contract $(python3 -c 'import re;print(re.search(r"major: (\d+), minor: (\d+)", open("extensions/java-core/src/api.ts").read()).group(0))'))"

# (b)
if ! command -v gh >/dev/null || ! gh release list --repo batleforc/batlehub-vsx --limit 100 2>/dev/null | grep -qE "java-(core|groovy)-v"; then
  log "SKIP (no tagged release yet: nothing older to hold the PR builds against)"
  exit 0
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
last() { gh release list --repo batleforc/batlehub-vsx --limit 100 | awk -v p="$1-v" '$0 ~ p { print $1; exit }'; }
CORE_TAG="$(last java-core)"; GROOVY_TAG="$(last java-groovy)"
[[ -n "$CORE_TAG" && -n "$GROOVY_TAG" ]] || { log "SKIP (one side has no release yet: core '$CORE_TAG', groovy '$GROOVY_TAG')"; exit 0; }
gh release download "$CORE_TAG" --repo batleforc/batlehub-vsx --pattern 'java-core-*.vsix' --dir "$WORK"
gh release download "$GROOVY_TAG" --repo batleforc/batlehub-vsx --pattern 'java-groovy-*.vsix' --dir "$WORK"
(cd extensions/java-core && pnpm run package >/dev/null) && (cd extensions/java-groovy && pnpm run package >/dev/null)
VSCODE_DIR="${HOME}/.cache/batlehub-heavy/vscode-server-web-${VSCODE_VERSION:-1.136.1}"
[[ -x "$VSCODE_DIR/bin/code-server" ]] || { log "SKIP (no VS Code web build at $VSCODE_DIR; run the heavy suite once)"; exit 0; }
pair() { # pair <label> <core.vsix> <groovy.vsix>
  local d="$WORK/$1"; mkdir -p "$d"
  env -u VSCODE_IPC_HOOK_CLI "$VSCODE_DIR/bin/code-server" --server-data-dir "$d/s" --user-data-dir "$d/u" --extensions-dir "$d/e" \
    --install-extension "$2" --install-extension "$3" >"$d/install.txt" 2>&1 || { cat "$d/install.txt" >&2; log "FAIL ($1)"; exit 1; }
  grep -qi "successfully installed" "$d/install.txt" && log "PAIR-OK ($1)"
}
pair "pr-core+tagged-groovy" extensions/java-core/java-core.vsix "$WORK"/java-groovy-*.vsix
pair "tagged-core+pr-groovy" "$WORK"/java-core-*.vsix extensions/java-groovy/java-groovy.vsix
log "CONTRACT-OK"

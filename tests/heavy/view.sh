#!/usr/bin/env bash
# The proof with a real client — RFC 0011 §12 phases 7 and 8 in a **real
# VS Code**: the web build (`server-linux-x64-web`, the same server a
# che-code workspace runs), the extension installed from the `.vsix` this
# repository packages, a real BatleHub of this workspace, the workbench
# driven in the browser sidecar over CDP. What the views show is read off
# the DOM (`tests/heavy/view.mjs`), not inferred from a request log.
#
# Two editors, two modes, in order:
#
#   marketplace  A stock build: `product.json` names Microsoft's gallery,
#                which cannot be repointed, so the extension is the surface.
#                The registry requires a credential; `BATLEHUB_TOKEN` is in
#                the editor's environment (chain step 2). Proves: the
#                BatleHub view lists the registry's extensions; its inline
#                Install fetches the registry-signed fixture, verifies the
#                Ed25519 signature against the registry's key (RFC 0020) and
#                installs it through the editor's own command; the editor's
#                Extensions view then lists it as installed; the status bar
#                names the credential; the log says the signature verified.
#
#   broker       The editor's gallery is the local proxy of RFC 0011 §4.4
#                (`batlehub-cli proxy serve`), `VSX_REGISTRY_AUTH_SUPPORT=1`
#                in its environment, no credential anywhere. Proves: the
#                Account view and the status bar say "sign in"; the
#                Extensions view lists the sign-in entry alone; once the CLI
#                can hand out a credential, "Refresh the credential now"
#                makes the extension write the contract file (chain step 3)
#                and re-query the gallery — the proxy reads the file, and
#                the same view, no reload, lists the real extension.
#
#   registry     RFC 0001 phase 5, decision 39: batlehub-vsx signed in
#                (BATLEHUB_TOKEN) beside java-core with the registry link
#                on, pointing at the run's Maven registry (a proxy of Central
#                that refuses anonymous reads). Proves: the core writes the
#                mirror and the token — handed over by batlehub-vsx, never
#                read from the contract file — into the run's own
#                ~/.m2/settings.xml (0600) and ~/.gradle/init.d; then a real
#                Maven resolves a dependency through the hub with that file.
#
#   java         RFC 0001 §10 layer 4, decision 39: the same editor with
#                `redhat.java` (pinned) and `java-core` installed, the
#                `maven-multi` fixture open, **no BatleHub and no Postgres**.
#                Proves: the status bar item; the log; the newcomer story
#                (no JAVA_HOME, the core writes the language server's JDK);
#                Standard mode reached; the JDK quick pick; spike (a) — the
#                m2e preference and the classpath; RFC 0012 use cases 1–3 —
#                the default-on write of java.completion.chain.enabled, a
#                chain on the completion shortcut, its cost and its Undo
#                (run in "shortcut"); RFC 0012 use case 4 — in "auto" the
#                bundle's delegate answers an `int` chain while typing,
#                gated at chainDelegateMs < 150 ms;
#                RFC 0007 use case 1 —
#                `Java: Import from IntelliJ` → Code style, gated on trust,
#                planned as a diff, and `Format Document` matching the
#                golden IDEA itself produced; clean removal; and prints
#                the performance numbers (gated from phase 3).
#
# Ports: 8124 (server), 8132 (the editor's web server); the proxy binds an
# ephemeral loopback port. Needs network once for the VS Code download and
# the fixture (cached under ~/.cache/batlehub-heavy, shared with the
# BatleHub repository's heavy suites), and the browser needs to reach
# vscode-cdn.net (the stock web build loads its webviews from there).
#
# Environment: DATABASE_URL (required); BATLEHUB_SRC (a BatleHub checkout —
# `cargo run` builds server and CLI; default ../batlehub or ../proxy-cache
# when one exists) or BATLEHUB_BIN + BATLEHUB_CLI (release binaries,
# `task hub:install`); HEAVY_PORT, HEAVY_EDITOR_PORT, VSCODE_VERSION
# (1.136.1), WEEBO_VERSION (0.5.0), CDP_URL (http://127.0.0.1:9222),
# HEAVY_ONLY=marketplace|broker|java|registry|seasons|quarkus|spring|sonar, REDHAT_JAVA_VERSION (1.56.0,
# decision 8).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"
HEAVY_RUN="$(date +%s)-$$"
HEAVY_PORT="${HEAVY_PORT:-8124}"
EDITOR_PORT="${HEAVY_EDITOR_PORT:-8132}"
HEAVY_BASE="http://127.0.0.1:$HEAVY_PORT"
HEAVY_CACHE="${HEAVY_CACHE:-$HOME/.cache/batlehub-heavy}"
HEAVY_WORK="$REPO/tests/heavy/work/$HEAVY_RUN"
VSCODE_VERSION="${VSCODE_VERSION:-1.136.1}"
WEEBO_VERSION="${WEEBO_VERSION:-0.5.0}"
WEEBO_BASE_URL="${WEEBO_BASE_URL:-https://github.com/batleforc/weebo-che-notify/releases/download}"
CDP_URL="${CDP_URL:-http://127.0.0.1:9222}"
ONLY="${HEAVY_ONLY:-all}"
ADMIN_TOKEN="heavy-admin-token"
USER_TOKEN="heavy-user-token"
REG="vsx-$HEAVY_RUN"
REGISTRY_BASE="$HEAVY_BASE/proxy/$REG"
EXT_ID="batleforc.weebo-bridge-notify"
MATCH="Weebo"

# Each run keeps its editors' data (~100 MB, 8.8 GB after 80 runs): only the
# newest few are worth reading back. Names start with the epoch, so they sort.
{ ls -1d "$REPO"/tests/heavy/work/[0-9]*/ 2>/dev/null || true; } | sort | head -n -"${HEAVY_KEEP:-3}" | xargs -r rm -rf
mkdir -p "$HEAVY_WORK/shots" "$HEAVY_CACHE"
ln -sfn "$HEAVY_WORK" "$REPO/tests/heavy/work/last"
LOG="$HEAVY_WORK/suite.log"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }
# On a failure with an editor up, the two logs a CI runner never shows:
# the extension host's and JDT.LS's own (.metadata/.log of its workspace).
DUMP_ON_FAIL=""
dump_editor_logs() {
  local f
  for f in $(find "$1" -name remoteexthost.log -o -path '*jdt_ws/.metadata/.log' -o -name 'client.log*' 2>/dev/null | head -6); do
    printf '\n===== %s (last 60 lines) =====\n' "$f" >&2; tail -60 "$f" >&2
  done
}
DUMP_JSONL=""
fail() {
  log "FAIL: $*"
  [[ -n "$DUMP_JSONL" && -f "$DUMP_JSONL" ]] && grep -E '"phase": "(log2|ready|reload|bundle)"' "$DUMP_JSONL" >&2
  [[ -n "$DUMP_ON_FAIL" ]] && dump_editor_logs "$DUMP_ON_FAIL"
  exit 1
}
fetch() { curl -fsSL --proto '=https' --proto-redir '=https' "$@"; }
# The JDT bundle java-core carries (`javaExtensions`), built before any half
# packages java-core — a CI job runs one half alone, and a jar the manifest
# names but the VSIX lacks breaks JDT.LS's bundle loading for every extension.
jdt_bundle() {
  [[ -s "$REPO/extensions/java-core/jdt/batlehub-jdt-core.jar" ]] && return
  log "Building the JDT bundle (task jdt:deps, jdt:build)"
  (cd "$REPO" && task jdt:deps >>"$HEAVY_WORK/package.log" 2>&1 && task jdt:build >>"$HEAVY_WORK/package.log" 2>&1) \
    || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "the JDT bundle build failed"; }
}

PIDS=()
PRODUCT_JSON=""
PRODUCT_BACKUP=""
cleanup() {
  [[ -n "${EDITOR_PID:-}" ]] && { kill -- -"$EDITOR_PID" 2>/dev/null || kill "$EDITOR_PID" 2>/dev/null || true; }
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && { kill -- -"$p" 2>/dev/null || kill "$p" 2>/dev/null || true; }; done
  if [[ -n "$PRODUCT_BACKUP" && -f "$PRODUCT_BACKUP" ]]; then cp "$PRODUCT_BACKUP" "$PRODUCT_JSON"; fi
}
trap cleanup EXIT

REDHAT_JAVA_VERSION="${REDHAT_JAVA_VERSION:-1.56.0}"
NEED_HUB=1; [[ "$ONLY" == "java" || "$ONLY" == "seasons" || "$ONLY" == "quarkus" || "$ONLY" == "spring" || "$ONLY" == "sonar" ]] && NEED_HUB=0
[[ "$NEED_HUB" == 0 || -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is required (the Postgres sidecar: postgresql://batlehub:changeme@127.0.0.1:5432/batlehub)"
command -v node >/dev/null || fail "node is required"
command -v python3 >/dev/null || fail "python3 is required"
curl -sf "$CDP_URL/json/version" >/dev/null || fail "no browser at $CDP_URL — Chrome is parked in the sidecar: run 'task browser:start' (CDP_URL points elsewhere)"
[[ -d "$REPO/extensions/batlehub-vsx/node_modules/puppeteer-core" ]] || fail "puppeteer-core is missing — run 'pnpm install' first"

# ── 0. The server and CLI binaries ───────────────────────────────────────
if [[ "$NEED_HUB" == 1 ]]; then
if [[ -z "${BATLEHUB_SRC:-}" ]]; then
  for c in "$REPO/../batlehub" "$REPO/../proxy-cache"; do
    [[ -f "$c/Cargo.toml" ]] && { BATLEHUB_SRC="$(cd "$c" && pwd)"; break; }
  done
fi
if [[ -n "${BATLEHUB_BIN:-}" ]]; then
  SERVER_CMD=("$BATLEHUB_BIN")
  CLI="${BATLEHUB_CLI:-$(dirname "$BATLEHUB_BIN")/batlehub-cli}"
elif [[ -n "${BATLEHUB_SRC:-}" ]]; then
  log "Building the BatleHub server and CLI from $BATLEHUB_SRC"
  (cd "$BATLEHUB_SRC" && cargo build -p batlehub-server -p batlehub-cli >"$HEAVY_WORK/build.log" 2>&1) \
    || { tail -20 "$HEAVY_WORK/build.log" >&2; fail "the BatleHub build failed"; }
  TARGET="$(cd "$BATLEHUB_SRC" && cargo metadata --format-version 1 --no-deps | python3 -c 'import json,sys;print(json.load(sys.stdin)["target_directory"])')"
  SERVER_CMD=("$TARGET/debug/batlehub-server")
  [[ -x "${SERVER_CMD[0]}" ]] || SERVER_CMD=("$TARGET/debug/batlehub")
  CLI="$TARGET/debug/batlehub-cli"
else
  fail "no BatleHub: set BATLEHUB_SRC to a checkout, or BATLEHUB_BIN/BATLEHUB_CLI to release binaries (task hub:install)"
fi
[[ -x "${SERVER_CMD[0]}" ]] || fail "no server binary at ${SERVER_CMD[0]}"
[[ -x "$CLI" ]] || fail "no batlehub-cli at $CLI"
log "Server: ${SERVER_CMD[*]}; CLI: $CLI"
fi

# ── 1. The extension package ─────────────────────────────────────────────
log "Packaging the extension"
(cd "$REPO/extensions/batlehub-vsx" && pnpm run package >"$HEAVY_WORK/package.log" 2>&1) \
  || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "packaging failed"; }
(cd "$REPO/extensions/che-notify" && pnpm run package >>"$HEAVY_WORK/package.log" 2>&1) \
  || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "packaging che-notify failed"; }
CHE_NOTIFY_VSIX="$REPO/extensions/che-notify/che-notify.vsix"
[[ -s "$CHE_NOTIFY_VSIX" ]] || fail "no $CHE_NOTIFY_VSIX"
VSIX="$REPO/extensions/batlehub-vsx/batlehub-vsx.vsix"
[[ -s "$VSIX" ]] || fail "no $VSIX"
EXT_VERSION="$(python3 -c 'import json;print(json.load(open("extensions/batlehub-vsx/package.json"))["version"])')"
log "PACKAGE-OK ($(stat -c %s "$VSIX") bytes, batlehub.batlehub-vsx $EXT_VERSION)"

# ── 2. The BatleHub of this run ──────────────────────────────────────────
if [[ "$NEED_HUB" == 1 ]]; then
if (exec 3<>"/dev/tcp/127.0.0.1/$HEAVY_PORT") 2>/dev/null; then fail "port $HEAVY_PORT is taken (HEAVY_PORT picks another)"; fi
export HEAVY_RUN HEAVY_STORAGE="$HEAVY_WORK/storage"
mkdir -p "$HEAVY_STORAGE"
setsid "${SERVER_CMD[@]}" --config tests/heavy/config.toml >"$HEAVY_WORK/server.log" 2>&1 &
PIDS+=($!)
for i in $(seq 1 90); do
  curl -sf "$HEAVY_BASE/healthz" >/dev/null 2>&1 && break
  kill -0 "${PIDS[-1]}" 2>/dev/null || { tail -30 "$HEAVY_WORK/server.log" >&2; fail "the server exited"; }
  sleep 1
  [[ "$i" == 90 ]] && fail "the server never became healthy"
done
log "Server healthy at $HEAVY_BASE (registry $REG)"

FIXTURE="$HEAVY_CACHE/weebo-bridge-notify-$WEEBO_VERSION.vsix"
[[ -s "$FIXTURE" ]] || { log "Downloading weebo-bridge-notify v$WEEBO_VERSION"; fetch -o "$FIXTURE" "$WEEBO_BASE_URL/v$WEEBO_VERSION/weebo-bridge-notify-$WEEBO_VERSION.vsix"; }
curl -fsS -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @"$FIXTURE" "$REGISTRY_BASE/$EXT_ID/$WEEBO_VERSION/vsix" >"$HEAVY_WORK/publish-fixture.json" || fail "publishing the fixture failed"
curl -fsS -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/octet-stream" \
  --data-binary @"$VSIX" "$REGISTRY_BASE/batlehub.batlehub-vsx/$EXT_VERSION/vsix" >"$HEAVY_WORK/publish-self.json" || fail "publishing the extension itself failed"
ANON="$(curl -s -o /dev/null -w '%{http_code}' "$REGISTRY_BASE/api/-/search?query=weebo")"
[[ "$ANON" == "401" || "$ANON" == "403" ]] || fail "anonymous search answered $ANON, expected a refusal — the registry must require a credential"
SIGNED="$(curl -s -H "Authorization: Bearer $USER_TOKEN" "$REGISTRY_BASE/api/batleforc/weebo-bridge-notify" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("signature" in d.get("files",{}) and "publicKey" in d.get("files",{}))')"
[[ "$SIGNED" == "True" ]] || fail "the registry does not advertise a signature and a public key for the fixture — is vsx_signing configured?"
log "REGISTRY-OK (two entries published; anonymous refused with $ANON; the fixture is registry-signed)"
fi

# ── 3. The editor's web build ────────────────────────────────────────────
VSCODE_DIR="$HEAVY_CACHE/vscode-server-web-$VSCODE_VERSION"
CODE_SERVER="$VSCODE_DIR/bin/code-server"
if [[ ! -x "$CODE_SERVER" ]]; then
  log "Downloading VS Code $VSCODE_VERSION (server-linux-x64-web) into $VSCODE_DIR"
  mkdir -p "$VSCODE_DIR"
  fetch "https://update.code.visualstudio.com/$VSCODE_VERSION/server-linux-x64-web/stable" | tar -xz -C "$VSCODE_DIR" --strip-components=1
fi
[[ -x "$CODE_SERVER" ]] || fail "no bin/code-server in $VSCODE_DIR"
PRODUCT_JSON="$VSCODE_DIR/product.json"
PRODUCT_BACKUP="$HEAVY_WORK/product.json.orig"
cp "$PRODUCT_JSON" "$PRODUCT_BACKUP"

EDITOR_PID=""
INSTALL_VSIX=("$VSIX" "$CHE_NOTIFY_VSIX")
EDITOR_FOLDER=""
start_editor() {
  # start_editor <data-dir> <settings-json> [ENV=VALUE …]
  local data="$1" settings="$2"; shift 2
  mkdir -p "$data/server/data/Machine" "$data/user" "$data/extensions"
  printf '%s\n' "$settings" >"$data/server/data/Machine/settings.json"
  local code=("$CODE_SERVER" --server-data-dir "$data/server" --user-data-dir "$data/user" --extensions-dir "$data/extensions")
  : >"$data/install.txt"
  for v in "${INSTALL_VSIX[@]}"; do
    env -u VSCODE_IPC_HOOK_CLI "$@" "${code[@]}" --install-extension "$v" >>"$data/install.txt" 2>&1 \
      || { cat "$data/install.txt" >&2; fail "installing $v into the editor failed"; }
  done
  grep -qi "successfully installed" "$data/install.txt" || { cat "$data/install.txt" >&2; fail "the editor did not report the extension installed"; }
  if (exec 3<>"/dev/tcp/127.0.0.1/$EDITOR_PORT") 2>/dev/null; then fail "port $EDITOR_PORT is taken (HEAVY_EDITOR_PORT picks another)"; fi
  env -u VSCODE_IPC_HOOK_CLI "$@" setsid "${code[@]}" --host 127.0.0.1 --port "$EDITOR_PORT" --without-connection-token \
    --accept-server-license-terms ${EDITOR_FOLDER:+--default-folder "$EDITOR_FOLDER"} >"$data/editor.log" 2>&1 &
  EDITOR_PID=$!
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "http://127.0.0.1:$EDITOR_PORT/" && break
    kill -0 "$EDITOR_PID" 2>/dev/null || { cat "$data/editor.log" >&2; fail "the editor's web server exited"; }
    sleep 1
  done
  curl -sf -o /dev/null "http://127.0.0.1:$EDITOR_PORT/" || fail "the editor never answered on $EDITOR_PORT"
}
stop_editor() {
  [[ -n "$EDITOR_PID" ]] && { kill -- -"$EDITOR_PID" 2>/dev/null || true; }
  EDITOR_PID=""
  for _ in $(seq 1 20); do (exec 3<>"/dev/tcp/127.0.0.1/$EDITOR_PORT") 2>/dev/null || break; sleep 0.5; done
}

drive() {
  # drive <phase> <out.jsonl> [driver args…]
  local phase="$1" out="$2"; shift 2
  node tests/heavy/view.mjs --url "http://127.0.0.1:$EDITOR_PORT/" --shots "$HEAVY_WORK/shots" --cdp "$CDP_URL" \
    --phase "$phase" --match "$MATCH" "$@" >"$out" 2>"$out.err" || { cat "$out.err" >&2; cat "$out" >&2; fail "the $phase driver failed"; }
}
field() { python3 -c 'import json,sys
want=sys.argv[2]
for line in open(sys.argv[1]):
    d=json.loads(line)
    if d.get("phase")==want: print(json.dumps(d)); break' "$1" "$2"; }
assert_json() {
  # assert_json <jsonl> <phase> <python expression over d> <message>
  local got
  got="$(field "$1" "$2")"
  [[ -n "$got" ]] || fail "no '$2' line in $1"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if eval(sys.argv[2]) else 1)' "$got" "$3" \
    || { echo "$got" >&2; fail "$4"; }
}

# ── 4. Marketplace mode: a stock build ───────────────────────────────────
if [[ "$ONLY" == "all" || "$ONLY" == "marketplace" ]]; then
  log "Marketplace mode: stock product.json, BATLEHUB_TOKEN in the editor's environment"
  M="$HEAVY_WORK/editor-marketplace"
  start_editor "$M" "{ \"batlehub.registry\": \"$REGISTRY_BASE\", \"batlehub.cliPath\": \"/nonexistent/batlehub-cli\" }" \
    BATLEHUB_TOKEN="$USER_TOKEN"
  log "Editor (VS Code $VSCODE_VERSION, web) at http://127.0.0.1:$EDITOR_PORT, gallery stock"
  drive marketplace "$HEAVY_WORK/marketplace.jsonl"
  stop_editor
  cat "$HEAVY_WORK/marketplace.jsonl" >>"$LOG"
  assert_json "$HEAVY_WORK/marketplace.jsonl" rows "any('$MATCH' in r['name'] for r in d['rows']) and any('batlehub-vsx' in r['name'].lower() or 'BatleHub' in r['name'] for r in d['rows'])" \
    "the BatleHub view did not list the fixture and the extension itself"
  log "VIEW-OK (the BatleHub view lists the registry's entries, filtered by the credential)"
  assert_json "$HEAVY_WORK/marketplace.jsonl" install "d['clicked'] and any(n.startswith('BatleHub: installed') and '$EXT_ID' in n for n in d['notifications'])" \
    "the inline Install did not end in 'BatleHub: installed $EXT_ID'"
  assert_json "$HEAVY_WORK/marketplace.jsonl" install "d['row'] is not None and 'installed' in d['row']['description']" \
    "the row did not turn to 'installed' after the click"
  log "INSTALL-OK (inline Install → the editor's own install command; the row says installed)"
  assert_json "$HEAVY_WORK/marketplace.jsonl" installed "any('$MATCH'.lower() in e['name'].lower() for e in d['entries'])" \
    "the editor's Extensions view does not list the fixture under @installed"
  log "EDITOR-OK (the editor's own Extensions view lists it as installed)"
  assert_json "$HEAVY_WORK/marketplace.jsonl" status "any(i['text'].startswith('BatleHub: oidc') or i['text'].startswith('BatleHub: pat') for i in d['items'])" \
    "the status bar does not name the credential"
  assert_json "$HEAVY_WORK/marketplace.jsonl" log "'installed $EXT_ID' in ' '.join(d['lines']) and 'Ed25519 signature verifies' in ' '.join(d['lines'])" \
    "the log does not say the registry's Ed25519 signature verified before the install"
  log "SIGNATURE-OK (the log: the registry's Ed25519 signature verified with its key before the install)"
  assert_json "$HEAVY_WORK/marketplace.jsonl" log "'mode marketplace' in ' '.join(d['lines'])" "the extension did not activate in marketplace mode"
  assert_json "$HEAVY_WORK/marketplace.jsonl" notify "d.get('commandFound') and any('Che Notify test notification' in n for n in d.get('notifications', []))" \
    "Che Notify did not tail its file and display a native notification in the real editor"
  log "CHE-NOTIFY-OK (real command → watched file → workbench notification)"
fi

# ── 5. Broker mode: the gallery is the local proxy ───────────────────────
if [[ "$ONLY" == "all" || "$ONLY" == "broker" ]]; then
  log "Broker mode: product.json → the local gallery proxy, VSX_REGISTRY_AUTH_SUPPORT=1, no credential yet"
  B="$HEAVY_WORK/editor-broker"
  HOME2="$HEAVY_WORK/home"
  mkdir -p "$HOME2/.batlehub/state" "$HOME2/.config/batlehub"
  CONTRACT="$HOME2/.batlehub/state/vsx-token.json"
  rm -f "$CONTRACT"
  "$CLI" proxy serve --registry "$REGISTRY_BASE" --contract "$CONTRACT" --state-dir "$HOME2/.batlehub/state" --print-gallery-url \
    >"$HEAVY_WORK/proxy.url" 2>"$HEAVY_WORK/proxy.err" &
  PIDS+=($!)
  for _ in $(seq 1 30); do [[ -s "$HEAVY_WORK/proxy.url" ]] && break; sleep 1; done
  GALLERY="$(head -1 "$HEAVY_WORK/proxy.url")"
  [[ "$GALLERY" == http://127.0.0.1:* ]] || { cat "$HEAVY_WORK/proxy.err" >&2; fail "the proxy printed no loopback gallery URL"; }
  log "Gallery proxy at $GALLERY"
  python3 - "$PRODUCT_JSON" "$GALLERY" <<'PY'
import json, sys
path, base = sys.argv[1:]
p = json.load(open(path, encoding="utf-8"))
p["extensionsGallery"] = {
    "serviceUrl": f"{base}/vscode/gallery",
    "itemUrl": f"{base}/vscode/item",
    "resourceUrlTemplate": f"{base}/vscode/unpkg/{{publisher}}/{{name}}/{{version}}/{{path}}",
}
json.dump(p, open(path, "w", encoding="utf-8"))
PY
  # The CLI config the extension's step 3 will read — written by --after-anon,
  # not now: the first look must find no credential anywhere.
  CLI_CONFIG="$HOME2/.config/batlehub/config.toml"
  rm -f "$CLI_CONFIG"
  GIVE_CLI="printf '[default]\nserver_url = \"%s\"\ntoken = \"%s\"\n' '$HEAVY_BASE' '$USER_TOKEN' > '$CLI_CONFIG'"
  start_editor "$B" "{ \"batlehub.registry\": \"$REGISTRY_BASE\", \"batlehub.cliPath\": \"$CLI\" }" \
    VSX_REGISTRY_AUTH_SUPPORT=1 BATLEHUB_HOME="$HOME2/.batlehub" XDG_CONFIG_HOME="$HOME2/.config" HOME="$HOME2"
  curl -s "http://127.0.0.1:$EDITOR_PORT/" | grep -q "$(python3 -c 'import html,sys;print(html.escape(sys.argv[1], quote=True))' "$GALLERY/vscode/gallery")" \
    || fail "the workbench page does not name the proxy as its gallery"
  log "Editor at http://127.0.0.1:$EDITOR_PORT, gallery = the proxy"
  drive broker "$HEAVY_WORK/broker.jsonl" --after-anon "$GIVE_CLI"
  stop_editor
  cat "$HEAVY_WORK/broker.jsonl" >>"$LOG"
  assert_json "$HEAVY_WORK/broker.jsonl" welcome "any('Sign in' in w for w in d['welcome']) and any('sign in' in i['text'].lower() for i in d['status'])" \
    "before any credential, the Account view and the status bar should say sign in"
  log "ANON-OK (Account view and status bar: sign in)"
  assert_json "$HEAVY_WORK/broker.jsonl" browse "len(d['entries'])==1 and d['entries'][0]['name']=='Sign in to BatleHub'" \
    "unauthenticated, the Extensions view should list the sign-in entry alone"
  log "BOOTSTRAP-OK (the proxy's sign-in entry, alone, in the view)"
  assert_json "$HEAVY_WORK/broker.jsonl" refresh "any('Refresh the credential' in r for r in d['palette'])" "the palette did not offer the refresh command"
  [[ -s "$CONTRACT" ]] || fail "the extension did not write the contract file $CONTRACT"
  python3 - "$CONTRACT" "$HEAVY_BASE" <<'PY' || fail "the contract file is not what the broker should have written"
import json, os, stat, sys
path, origin = sys.argv[1:]
mode = stat.S_IMODE(os.stat(path).st_mode)
assert mode == 0o600, f"mode {oct(mode)}"
d = json.load(open(path))
e = d["registries"][origin]
assert isinstance(e["token"], str) and e["token"], e
assert e["refresh"] == {"source": "cli", "owner": "batlehub-cli"}, e["refresh"]
print("contract:", {k: v for k, v in e.items() if k != "token"})
PY
  log "CONTRACT-OK (written 0600 by the extension, refresh owned by the CLI, token never logged)"
  assert_json "$HEAVY_WORK/broker.jsonl" log "'re-queried' in ' '.join(d['lines'])" \
    "the extension did not run the editor's Extensions-view refresh after writing the credential"
  log "REQUERY-OK (the extension ran the editor's own Extensions-view refresh)"
  assert_json "$HEAVY_WORK/broker.jsonl" status "any(i['text'].startswith('BatleHub: oidc') or i['text'].startswith('BatleHub: pat') for i in d['items'])" \
    "the status bar does not name the credential after the refresh"
  assert_json "$HEAVY_WORK/broker.jsonl" log "'mode broker' in ' '.join(d['lines'])" "the extension did not activate in broker mode"

  # The view after the re-query. The extension files its entry under the
  # **origin** — RFC 0011 §4.1, the JSON Schema, and what the che-code patch
  # reads (`new URL(url).origin`) — and the CLI's gallery proxy looks it up
  # the same way, so what the extension wrote is what the proxy sends.
  #
  # It did not always: `contract::normalize_origin` once only trimmed a
  # trailing slash, so a proxy started with `--registry <base>/proxy/vsx`
  # searched for a key no schema-conformant writer produces and kept serving
  # the sign-in entry to an editor that was signed in. Found by this suite,
  # fixed in the CLI, and this is the assertion that would find it again.
  QUERY='{"filters":[{"criteria":[{"filterType":10,"value":"weebo"}],"pageNumber":1,"pageSize":50}],"flags":914}'
  SERVED="$(curl -s -X POST -H 'Content-Type: application/json' -d "$QUERY" "$GALLERY/vscode/gallery/extensionquery" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(" ".join(e["extensionName"] for e in d["results"][0]["extensions"]))')"
  [[ "$SERVED" == *weebo-bridge-notify* ]] \
    || fail "the proxy answered '$SERVED' for the entry the extension filed under the origin $HEAVY_BASE — is the CLI's contract::normalize_origin keying by something other than the origin again?"
  log "PROXY-OK (the credential the extension wrote authenticates the gallery: the proxy serves '$SERVED')"
  assert_json "$HEAVY_WORK/broker.jsonl" search "len(d['entries'])>0 and not any(e['name']=='Sign in to BatleHub' for e in d['entries']) and any('$MATCH'.lower() in e['name'].lower() for e in d['entries']) and not d['viaViewRefresh']" \
    "after the refresh, the same Extensions view should list the real extension and no sign-in entry, without anyone clicking the view's Refresh"
  log "REQUERY-VIEW-OK (same workbench, no reload, nobody clicking Refresh: the view lists the registry's extension)"
  log "BROKER-OK"
fi

# ── 5b. Registry link: batlehub-vsx hands the token to java-core ─────────
if [[ "$ONLY" == "all" || "$ONLY" == "registry" ]]; then
  log "Registry half: batlehub-vsx (BATLEHUB_TOKEN) + java-core, registry link → $HEAVY_BASE/proxy/mvn-$HEAVY_RUN/maven2"
  jdt_bundle
  (cd "$REPO/extensions/java-core" && pnpm run package >>"$HEAVY_WORK/package.log" 2>&1) || fail "packaging java-core failed"
  JAVA_CORE_VSIX="$REPO/extensions/java-core/java-core.vsix"
  REDHAT_VSIX="$HEAVY_CACHE/redhat.java-$REDHAT_JAVA_VERSION.vsix"
  [[ -s "$REDHAT_VSIX" ]] || fetch -o "$REDHAT_VSIX" "https://open-vsx.org/api/redhat/java/$REDHAT_JAVA_VERSION/file/redhat.java-$REDHAT_JAVA_VERSION.vsix"
  RG="$HEAVY_WORK/editor-registry"
  RWS="$HEAVY_WORK/registry-ws"
  RHOME="$HEAVY_WORK/home-registry"
  rm -rf "$RWS" "$RHOME" && cp -r "$REPO/tests/heavy/fixtures/maven-multi" "$RWS" && mkdir -p "$RHOME"
  MVN_REG="$HEAVY_BASE/proxy/mvn-$HEAVY_RUN/maven2"
  JDK21="$(mise where java@temurin-21.0.11+10.0.LTS 2>/dev/null || true)"
  INSTALL_VSIX=("$VSIX" "$REDHAT_VSIX" "$JAVA_CORE_VSIX")
  EDITOR_FOLDER="$RWS"
  start_editor "$RG" "{ \"workbench.startupEditor\": \"none\", \"batlehub.registry\": \"$REGISTRY_BASE\", \"batlehub.cliPath\": \"/nonexistent/batlehub-cli\", \"batlehub.java.registry.enabled\": \"true\", \"batlehub.java.registry.url\": \"$MVN_REG\", \"java.server.launchMode\": \"LightWeight\", \"java.jdt.ls.java.home\": \"$JDK21\", \"batlehub.java.log.level\": \"debug\", \"extensions.ignoreRecommendations\": true, \"git.openRepositoryInParentFolders\": \"never\" }" \
    BATLEHUB_TOKEN="$USER_TOKEN" HOME="$RHOME" BATLEHUB_HOME="$RHOME/.batlehub" XDG_CONFIG_HOME="$RHOME/.config" JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=6"
  log "Editor at http://127.0.0.1:$EDITOR_PORT, folder $RWS, HOME $RHOME"
  node tests/heavy/registry.mjs --url "http://127.0.0.1:$EDITOR_PORT/?folder=$RWS" --shots "$HEAVY_WORK/shots" --cdp "$CDP_URL" >"$HEAVY_WORK/registry.jsonl" 2>"$HEAVY_WORK/registry.jsonl.err" \
    || { cat "$HEAVY_WORK/registry.jsonl.err" >&2; fail "the registry driver failed"; }
  stop_editor
  cat "$HEAVY_WORK/registry.jsonl" >>"$LOG"
  assert_json "$HEAVY_WORK/registry.jsonl" link "not d['timedOut'] and d['enabled'] and d['withToken']" \
    "the core did not report the registry link written with a token from batlehub-vsx: $(field "$HEAVY_WORK/registry.jsonl" link | cut -c1-300)"
  log "LINK-OK ($(field "$HEAVY_WORK/registry.jsonl" link | python3 -c 'import json,sys;print(json.load(sys.stdin)["line"][:140])'))"
  M2="$RHOME/.m2/settings.xml"
  [[ -s "$M2" ]] || fail "no $M2 written"
  MODE="$(stat -c %a "$M2")"; [[ "$MODE" == "600" ]] || fail "$M2 has mode $MODE, expected 600"
  grep -q "<!-- batlehub:mirror -->" "$M2" && grep -q "<url>$MVN_REG</url>" "$M2" && grep -q "<value>Bearer $USER_TOKEN</value>" "$M2" \
    || { sed 's/Bearer [^<]*/Bearer <redacted>/' "$M2" >&2; fail "the mirror block, the URL or the bearer token is missing from $M2"; }
  INIT="$RHOME/.gradle/init.d/batlehub.gradle"
  [[ -s "$INIT" ]] && grep -q "$MVN_REG" "$INIT" && grep -q "Bearer $USER_TOKEN" "$INIT" || fail "the Gradle init script was not written with the mirror and the bearer"
  log "FILES-OK (settings.xml 0600 with the batlehub mirror block and the bearer, init.d/batlehub.gradle with the same)"
  # The real client: Maven resolves the profile-only dependency through the
  # hub with the file the core wrote — a fresh local repository, so every
  # request goes to the mirror, which refuses anonymous reads.
  M2REPO="$HEAVY_WORK/m2-registry"
  (cd "$RWS" && JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=6" mise exec java@temurin-21.0.11+10.0.LTS maven@3.9.16 -- mvn -B -q -s "$M2" -Dmaven.repo.local="$M2REPO" -Pdev -pl core dependency:resolve >"$HEAVY_WORK/mvn-registry.log" 2>&1) \
    || { tail -30 "$HEAVY_WORK/mvn-registry.log" >&2; fail "mvn dependency:resolve through the BatleHub mirror failed"; }
  [[ -f "$M2REPO/org/apache/commons/commons-lang3/3.17.0/commons-lang3-3.17.0.jar" ]] || fail "commons-lang3 did not land in the fresh local repository"
  # Maven records which repository id served each artifact; the hub logs only
  # errors at its default level, so the local repository is the witness.
  REMOTE="$M2REPO/org/apache/commons/commons-lang3/3.17.0/_remote.repositories"
  grep -q ">batlehub=" "$REMOTE" || { cat "$REMOTE" >&2; fail "commons-lang3 was not served by the batlehub mirror"; }
  log "MAVEN-OK (mvn resolved commons-lang3 through $MVN_REG with the settings.xml the core wrote: _remote.repositories says 'batlehub' served it; anonymous reads are refused, so the bearer header was used)"
  log "REGISTRY-LINK-OK"
fi

# ── 6. Java: the Java extensions alone (RFC 0001, decision 39) ───────────
if [[ "$ONLY" == "all" || "$ONLY" == "java" ]]; then
  log "Java half: redhat.java $REDHAT_JAVA_VERSION + java-core (+ its JDT bundle) + java-groovy, the maven-multi fixture, no BatleHub"
  jdt_bundle
  (cd "$REPO/extensions/java-core" && pnpm run package >>"$HEAVY_WORK/package.log" 2>&1) \
    || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "packaging java-core failed"; }
  JAVA_CORE_VSIX="$REPO/extensions/java-core/java-core.vsix"
  [[ -s "$JAVA_CORE_VSIX" ]] || fail "no $JAVA_CORE_VSIX"
  [[ "$(unzip -l "$JAVA_CORE_VSIX" | grep -c "jdt/batlehub-jdt-core.jar")" -gt 0 ]] || fail "java-core.vsix does not carry the JDT bundle"
  (cd "$REPO" && task groovy:fetch >>"$HEAVY_WORK/package.log" 2>&1 && cd extensions/java-groovy && pnpm run package >>"$HEAVY_WORK/package.log" 2>&1) \
    || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "packaging java-groovy failed"; }
  JAVA_GROOVY_VSIX="$REPO/extensions/java-groovy/java-groovy.vsix"
  [[ -s "$JAVA_GROOVY_VSIX" ]] || fail "no $JAVA_GROOVY_VSIX"
  REDHAT_VSIX="$HEAVY_CACHE/redhat.java-$REDHAT_JAVA_VERSION.vsix"
  [[ -s "$REDHAT_VSIX" ]] || { log "Downloading redhat.java $REDHAT_JAVA_VERSION from Open VSX"; fetch -o "$REDHAT_VSIX" "https://open-vsx.org/api/redhat/java/$REDHAT_JAVA_VERSION/file/redhat.java-$REDHAT_JAVA_VERSION.vsix"; }
  # RFC 0013: cspell is a pack member; pinned to its newest stable release
  # (Open VSX's newer versions are pre-releases).
  CSPELL_VERSION="${CSPELL_VERSION:-4.9.3}"
  CSPELL_VSIX="$HEAVY_CACHE/streetsidesoftware.code-spell-checker-$CSPELL_VERSION.vsix"
  [[ -s "$CSPELL_VSIX" ]] || { log "Downloading code-spell-checker $CSPELL_VERSION from Open VSX"; fetch -o "$CSPELL_VSIX" "https://open-vsx.org/api/streetsidesoftware/code-spell-checker/$CSPELL_VERSION/file/streetsidesoftware.code-spell-checker-$CSPELL_VERSION.vsix"; }
  # RFC 0014: the theme is not in the pack and not recommended, so it is not
  # part of the Java story — it is installed here because a theme is only
  # proven by a real client rendering it (§10 heavy).
  (cd "$REPO/extensions/batlehub-theme" && pnpm run package >>"$HEAVY_WORK/package.log" 2>&1) \
    || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "packaging batlehub-theme failed"; }
  THEME_VSIX="$REPO/extensions/batlehub-theme/batlehub-theme.vsix"
  [[ -s "$THEME_VSIX" ]] || fail "no $THEME_VSIX"
  log "PACKAGE-OK (java-core $(stat -c %s "$JAVA_CORE_VSIX") bytes with the bundle, java-groovy $(stat -c %s "$JAVA_GROOVY_VSIX") bytes, batlehub-theme $(stat -c %s "$THEME_VSIX") bytes, redhat.java $REDHAT_JAVA_VERSION)"
  J="$HEAVY_WORK/editor-java"
  JWS="$HEAVY_WORK/java-ws"
  rm -rf "$JWS" && cp -r "$REPO/tests/heavy/fixtures/maven-multi" "$JWS"
  # The Groovy files of the groovy fixture, beside the Maven build: the
  # server compiles by folder, Maven is irrelevant to it.
  mkdir -p "$JWS/src/main/groovy/com/acme" && cp "$REPO/tests/heavy/fixtures/groovy-project/src/main/groovy/com/acme/Hello.groovy" "$JWS/src/main/groovy/com/acme/" && cp "$REPO/tests/heavy/fixtures/groovy-project/Jenkinsfile" "$JWS/"
  # RFC 0006 use case 5: the workspace starts on the v1 layout — the manifest
  # beside the team's files, the .gitignore line that hid the whole directory.
  mkdir -p "$JWS/.batlehub/java"
  printf '{\n  "version": 1,\n  "entries": []\n}\n' >"$JWS/.batlehub/java/written.json"
  printf 'target/\n/.batlehub/java/  # batlehub-java: the Maven overlay carries credentials\n' >"$JWS/.gitignore"
  # The newcomer's environment (§2 point 1): no JAVA_HOME, no JDK on PATH —
  # only a manager. `mise` stays reachable; its `java` shim answers nothing
  # without a global version, which is what a fresh Che workspace has.
  JAVA_ENV_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v -E '/java|/jdk|/jvm' | paste -sd: -)"
  # RFC 0007 use case 2 reads user-level live templates, and §4.2 reads them
  # from outside the workspace. HOME stays the real one (mise's installs are
  # what DETECT-OK finds); the IDEA half of the configuration moves through
  # XDG_CONFIG_HOME, which is where IDEA itself looks on Linux, with mise's own
  # config linked in beside it so `mise ls java` still answers.
  JCFG="$HEAVY_WORK/config-java"
  rm -rf "$JCFG" && cp -r "$REPO/tests/heavy/fixtures/idea-home" "$JCFG"
  [[ -d "${XDG_CONFIG_HOME:-$HOME/.config}/mise" ]] && ln -s "${XDG_CONFIG_HOME:-$HOME/.config}/mise" "$JCFG/mise"
  INSTALL_VSIX=("$REDHAT_VSIX" "$JAVA_CORE_VSIX" "$JAVA_GROOVY_VSIX" "$THEME_VSIX" "$CSPELL_VSIX")
  EDITOR_FOLDER="$JWS"
  T_START=$SECONDS
  # The suite lives inside the container's memory budget (§2 point 7 is not
  # theory: a 16 GiB tools container with rust-analyzer in it killed this
  # run twice): JDT.LS at 1 GiB, every other JVM the editor spawns (the
  # Groovy server) at 6% of the container through JAVA_TOOL_OPTIONS.
  # cSpell.useGitignore: the suite's workspaces live under tests/heavy/work/,
  # which this repository git-ignores, and cspell skips git-ignored files —
  # a user's project is not git-ignored, so the suite says so (RFC 0013).
  start_editor "$J" '{ "workbench.startupEditor": "none", "cSpell.useGitignore": false, "batlehub.java.completion.chain": "shortcut", "java.server.launchMode": "Standard", "java.jdt.ls.vmargs": "-XX:+UseParallelGC -XX:GCTimeRatio=4 -XX:AdaptiveSizePolicyWeight=90 -Dsun.zip.disableMemoryMapping=true -Xmx1G -Xms100m -Xlog:disable", "batlehub.java.log.level": "debug", "security.workspace.trust.enabled": false, "extensions.ignoreRecommendations": true, "git.openRepositoryInParentFolders": "never", "terminal.integrated.gpuAcceleration": "off" }' \
    JAVA_HOME= JDK_HOME= PATH="$JAVA_ENV_PATH" XDG_CONFIG_HOME="$JCFG" JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=6"
  log "Editor (VS Code $VSCODE_VERSION, web) at http://127.0.0.1:$EDITOR_PORT, folder $JWS, started in $(( SECONDS - T_START )) s"
  DUMP_ON_FAIL="$J"; DUMP_JSONL="$HEAVY_WORK/java.jsonl"
  PREFS="$JWS/core/.settings/org.eclipse.m2e.core.prefs"
  GIVE_PROFILE="mkdir -p '$(dirname "$PREFS")' && printf 'activeProfiles=dev\\neclipse.preferences.version=1\\nresolveWorkspaceProjects=true\\nversion=1\\n' > '$PREFS' && echo 'spike (a): wrote activeProfiles=dev into $PREFS' >&2"
  # The satellite's status bar item is hidden by default (§4.2); the toggle is a workspace setting.
  SHOW_GROOVY_ITEM="python3 - '$JWS/.vscode/settings.json' <<'PY'
import json, os, sys
p = sys.argv[1]; os.makedirs(os.path.dirname(p), exist_ok=True)
d = json.load(open(p)) if os.path.exists(p) else {}
d['batlehub.java.statusBar.items'] = {'groovy.server': True}
json.dump(d, open(p, 'w'), indent=2)
print('toggle: groovy.server shown', file=sys.stderr)
PY"
  BATLEHUB_THEME=1 node tests/heavy/java.mjs --url "http://127.0.0.1:$EDITOR_PORT/?folder=$JWS" --shots "$HEAVY_WORK/shots" --cdp "$CDP_URL" \
    --workspace "$JWS" --after-baseline "$GIVE_PROFILE" --after-groovy "$SHOW_GROOVY_ITEM" >"$HEAVY_WORK/java.jsonl" 2>"$HEAVY_WORK/java.jsonl.err" \
    || { cat "$HEAVY_WORK/java.jsonl.err" >&2; cat "$HEAVY_WORK/java.jsonl" >&2; fail "the java driver failed"; }
  stop_editor
  cat "$HEAVY_WORK/java.jsonl" >>"$LOG"
  J_="$HEAVY_WORK/java.jsonl"
  num() { field "$J_" "$1" | python3 -c "import json,sys;print(json.load(sys.stdin).get('$2', -1))"; }
  assert_json "$J_" status "len(d['items'])>0 and any('BatleHub Java' in i['label'] for i in d['items'])" "the Java status bar item never appeared"
  log "STATUS-OK (one Java item in the status bar, $(num status ms) ms after the page loaded)"
  assert_json "$J_" trusted "not d['timedOut']" "the workspace could not be trusted, or the core did not re-detect on trust"
  assert_json "$J_" log "'JavaSE-21@mise' in ' '.join(d['lines']) and 'wrote java.configuration.runtimes' in ' '.join(d['lines'])" \
    "the log does not show the mise JDK 21 and the java.configuration.runtimes write (v0.1's foreign write)"
  log "DETECT-OK (mise JDKs detected in $(num perf detectionMs) ms, java.configuration.runtimes written through the manifest)"
  assert_json "$J_" reload "d['reloaded']" \
    "with no JAVA_HOME and no java on PATH the core should have pointed the language server at a JDK and the suite reloaded"
  log "NEWCOMER-OK (no JAVA_HOME, no java on PATH: the core wrote java.jdt.ls.java.home, the editor reloaded)"
  assert_json "$J_" ready "not d['timedOut'] and any('Server mode: Standard' in i['label'] for i in d['items'])" \
    "the language server never reached Standard mode with the JDK the core handed it"
  assert_json "$J_" log2 "'redhat.java $REDHAT_JAVA_VERSION' in ' '.join(d['lines']) and 'activated in' in ' '.join(d['lines'])" \
    "after the reload the log does not name the pinned redhat.java and the activation time"
  log "SERVER-OK (JDT.LS in Standard mode on the JDK the core resolved, $(num ready ms) ms after the reload; redhat.java $REDHAT_JAVA_VERSION)"
  assert_json "$J_" bundle "d['loaded']" "the JDT bundle did not answer batlehub.ping (the JDT channel: $(field "$J_" bundle | cut -c1-300))"
  log "BUNDLE-OK (the OSGi bundle loaded into JDT.LS and answered batlehub.ping)"
  assert_json "$J_" pick "any('JavaSE-21' in r for r in d['rows']) and any('Install a JDK' in r for r in d['rows'])" \
    "the JDK quick pick does not list the mise runtime and the install entry"
  log "PICK-OK (the quick pick lists the runtimes and the install-by-manager entry)"
  assert_json "$J_" panel "d['found'] and len(d['tabs'])>=4 and 'tab' in d['roles'] and 'tabpanel' in d['roles'] and 'tablist' in d['roles'] and d['arrowMoved'] and d['tabs'][0]['tabindex']=='0'" \
    "the Java panel is missing tabs, ARIA roles or keyboard navigation: $(field "$J_" panel | cut -c1-300)"
  log "PANEL-OK (tabs $(field "$J_" panel | python3 -c 'import json,sys;print(",".join(t["text"] for t in json.load(sys.stdin)["tabs"]))'), ARIA tabs pattern, ArrowRight moves the selection; light/dark/high-contrast screenshots taken; first paint $(num perf panelPaintMs) ms after activation)"
  # ── RFC 0014: the three BatleHub themes, as the editor painted them ──
  # The expected values come from the theme files themselves, so a palette
  # bump moves the assertion with the derivation instead of against it.
  THEME_DIR="$REPO/extensions/batlehub-theme/themes"
  tcol() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['colors'][sys.argv[2]])" "$THEME_DIR/batlehub-$1.json" "$2"; }
  assert_json "$J_" theme "d['dark']['chrome']['editor-background']=='$(tcol dark editor.background)' and d['dark']['chrome']['ground']=='$(tcol dark editor.background)' and d['dark']['chrome']['focusBorder']=='$(tcol dark focusBorder)'" \
    "BatleHub Dark did not paint DESIGN.md's ground and amber focus ring: $(field "$J_" theme | cut -c1-300)"
  log "THEME-DARK-OK (the workbench ground is $(tcol dark editor.background), --vscode-focusBorder is the amber token $(tcol dark focusBorder); screenshot kept)"
  assert_json "$J_" theme "d['dark']['found'] and d['dark']['panel']['tabUnderline']=='$(tcol dark panelTitle.activeBorder)' and d['dark']['panel']['tabForeground']=='$(tcol dark panelTitle.activeForeground)' and not (set(d['dark']['panel']['used']) - set(json.load(open('$THEME_DIR/batlehub-dark.json'))['colors'].values()))" \
    "the Java panel under BatleHub Dark renders a colour the theme does not name: $(field "$J_" theme | python3 -c 'import json,sys;t=set(json.load(open("'"$THEME_DIR"'/batlehub-dark.json"))["colors"].values());print(sorted(set(json.load(sys.stdin)["dark"]["panel"]["used"])-t))' | cut -c1-400)"
  log "THEME-PANEL-OK (the selected tab's edge is the crimson token, its text is ink, and every colour the panel renders comes from the theme's own map)"
  assert_json "$J_" theme "d['light']['chrome']['editor-background']=='$(tcol light editor.background)' and d['light']['panel']['tabUnderline']=='$(tcol light panelTitle.activeBorder)'" \
    "BatleHub Light did not paint the paper ground and the light crimson edge: $(field "$J_" theme | cut -c1-300)"
  python3 -c '
import json, sys
d = json.loads(sys.argv[1])["light"]["chrome"]
def lum(h):
    c = [int(h[i:i+2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
a, b = sorted((lum(d["foreground"]), lum(d["editor-background"])), reverse=True)
r = (a + 0.05) / (b + 0.05)
assert r >= 16, f"foreground on editor.background is {r:.2f}:1, under the 16:1 floor"
print(f"{r:.2f}")' "$(field "$J_" theme)" >"$HEAVY_WORK/theme-light.txt" || fail "BatleHub Light: ink on paper is under 16:1"
  log "THEME-LIGHT-OK (paper ground, the light crimson edge, ink on paper $(cat "$HEAVY_WORK/theme-light.txt"):1 as measured in the browser)"
  assert_json "$J_" theme "d['hc']['chrome']['contrastBorder']=='$(tcol hc contrastBorder)' and d['hc']['chrome']['contrastActiveBorder']=='$(tcol hc contrastActiveBorder)' and d['hc']['panel']['ringColor']=='$(tcol hc focusBorder)' and d['hc']['panel']['ringWidth'] not in ('', '0px')" \
    "BatleHub High Contrast does not set the two contrast borders, or the panel's focus ring is not the amber token: $(field "$J_" theme | cut -c1-400)"
  log "THEME-HC-OK (contrastBorder and contrastActiveBorder set, the keyboard-focused tab outlined in the amber token; screenshot kept)"
  voice() { python3 -c "import json,sys;v=json.load(open(sys.argv[1]))['semanticTokenColors'][sys.argv[2]];print(v['foreground'] if isinstance(v,dict) else v)" "$THEME_DIR/batlehub-dark.json" "$1"; }
  assert_json "$J_" theme-tokens "d['pick'].get('class')=='$(voice class)' and d['pick'].get('method')=='$(voice method)' and d['pick'].get('keyword')=='$(voice keyword)' and d['pick'].get('string')=='$(voice string)' and d['pick'].get('annotation')=='$(voice annotation)' and '$(tcol dark button.background)' not in d['all']" \
    "the Java voices are not the theme's, or crimson reached a token colour: $(field "$J_" theme-tokens | cut -c1-400)"
  log "THEME-TOKENS-OK (the class, the method and the keyword in the editor's own colours re-lit on the BatleHub ground, the string and the annotation in copper; crimson in no rendered token colour — the One Synthetic Rule on screen)"

  assert_json "$J_" explorer "any('JDK JavaSE-21' in r for r in d['rows']) and any(r.startswith('maven-multi') for r in d['rows'])" \
    "the Projects explorer does not show the JDK and the module: $(field "$J_" explorer | cut -c1-300)"
  log "EXPLORER-OK (folder → JDK → modules)"
  assert_json "$J_" tasks "any('maven compile' in r or 'maven package' in r for r in d['rows']) and d['ran']" \
    "Tasks: Run Task does not list the batlehub-java Maven goals, or 'maven compile' did not end in BUILD SUCCESS: $(field "$J_" tasks | cut -c1-400)"
  log "TASKS-OK (the batlehub-java provider's goals in the editor's own task picker; 'maven compile' ran to BUILD SUCCESS in the terminal with the resolved JDK)"
  assert_json "$J_" inspections "any('batlehub' in r for r in d['problems']) and d.get('golden') and d['fixed'].strip() == d['golden'].strip()" \
    "the bundle's inspections did not reach the Problems panel, or Fix all in file is not .idea/golden/Greeter.fixed.java: $(field "$J_" inspections | python3 -c 'import sys, json, difflib; d = json.loads(sys.stdin.read() or "{}")
print("problems:", (d.get("problems") or [])[:3])
print("".join(list(difflib.unified_diff((d.get("golden") or "").splitlines(True), (d.get("fixed") or "").splitlines(True), "golden", "editor"))[:24]))')"
  assert_json "$J_" spelling "d['detected'] and len(d['problems']) >= 1 and any('spelling/unknownWord' in r and 'via cspell' in r for r in d['view']) and 'Speller.java3' in d['view']" \
    "cspell's findings in Speller.java did not reach the Problems panel and the Inspections view as spelling/unknownWord: $(field "$J_" spelling | cut -c1-900)"
  log "SPELL-OK (cspell $CSPELL_VERSION detected and bridged; recieve, Mesage, retuns in Speller.java: rows with source cSpell in the Problems panel, and one rule in the Inspections view, Speller.java 3 — $(field "$J_" spelling | python3 -c 'import json,sys;print(next((r for r in json.load(sys.stdin)["view"] if "spelling" in r), ""))') — RFC 0013 case 1)"
  assert_json "$J_" spellDict "d['picked'] and d['cspellJson'] and '\"Mesage\"' in d['cspellJson'] and '\"0.2\"' in d['cspellJson'] and 'target/**' in d['cspellJson'] and 'cSpell' not in (d['settings'] or '') and d['mesageGone']" \
    "Add to project dictionary did not create cspell.json with the word, or the row stayed, or a cSpell key reached settings.json: $(field "$J_" spellDict | cut -c1-1200)"
  log "SPELL-DICT-OK (the lightbulb on Mesage: the core's Add to project dictionary beside cspell's own fixes; cspell.json created — version 0.2, words [Mesage], ignorePaths target/** build/** —, nothing in settings.json, the row gone — RFC 0013 case 4)"
  assert_json "$J_" inspections-cleanup "not d['greeterDirty']" \
    "Greeter.java stayed dirty after the inspections step put the fixture back: every later step runs over a stale buffer"
  log "INSPECTIONS-OK (batlehub diagnostics on Greeter.java; Fix all in file left the buffer byte-for-byte .idea/golden/Greeter.fixed.java — receivers kept, size() == 0 now isEmpty())"
  assert_json "$J_" generate "d['generated']" "Java: Getters and setters… did not write the accessors into Person.java: $(field "$J_" generate | cut -c1-300)"
  log "GENERATE-OK (the Generate menu wrote getters and setters through the bundle's delegate)"
  assert_json "$J_" mcp "d['listening'] and not d.get('error') and d['tools']==['java_status','java_inspect','java_fix','java_generate','java_rename'] and d['status']['bundle'] and d['status']['server']['mode']=='Standard'" \
    "the live editor's MCP server is not reachable through the relay, or tools/list is not the five tools: $(field "$J_" mcp | cut -c1-900)"
  assert_json "$J_" mcp "sorted((f['code'], f['differs']) for f in d['inspect'])==[('collections/sizeIsZero',False),('performance/stringConcatInLoop',True),('style/redundantThis',True),('unused/privateField',False)] and not any('stringConcatInLoop' in r for r in d['panel'])" \
    "case 8: java_inspect did not return the four findings at the project's severities with the two overridden rows marked, or the Problems panel did not apply the override: $(field "$J_" mcp | cut -c1-1200)"
  log "MCP-PROJECT-VALUES-OK (a committed .vscode/settings.json turns stringConcatInLoop off and redundantThis to hint: the Problems panel follows it, java_inspect still returns the four findings at the bundle's severities, the two rows marked differsFromEditor — RFC 0002 case 8, editor side)"
  assert_json "$J_" mcp "d['dry']['applied'] is False and not d['rename']['isError'] and d['rename']['applied'] and set(d['rename']['files'])>={'core/src/main/java/com/acme/core/Greeter.java','app/src/main/java/com/acme/app/Main.java','app/src/test/java/com/acme/app/MainTest.java'} and d['mainBuffer'] and d['greeterBuffer']==2 and d['disk']['greeter'] and d['disk']['main'] and d['mainAfterUndo'] and not d['greeterAfterUndo']['everyone'] and d['greeterAfterUndo']['unsavedCallerKept'] and d['jdtls']['after']==d['jdtls']['before'] and d['typeRename']['isError'] and 'is a type' in d['typeRename']['text']" \
    "case 7: java_rename through the live editor did not rename the unsaved caller across modules, reached disk, needed more than one undo, or started a server: $(field "$J_" mcp | cut -c1-1200)"
  log "MCP-LIVE-OK (node mcp-relay.js <socket> as the agent: java_rename com.acme.core.Greeter#all → everyone renamed the declaration, the unsaved caller typed above isEmpty()'s return, Main.java and MainTest.java across modules in $(field "$J_" mcp | python3 -c 'import json,sys;print(json.load(sys.stdin)["renameMs"])') ms; buffers dirty, disk unchanged, one undo took it all back, a type rename refused (it would move a file), JDT.LS processes $(field "$J_" mcp | python3 -c 'import json,sys;j=json.load(sys.stdin)["jdtls"];print(j["before"],"→",j["after"])') — RFC 0002 case 7)"
  assert_json "$J_" shortcuts "'public static Builder builder()' in d['generated'] and 'private Customer(Builder b)' in d['generated'] and 'this.id = b.id;' in d['generated'] and 'public static final class Builder' in d['generated'] and 'public Builder withName(String name)' in d['generated'] and 'public Customer build()' in d['generated'] and not d['errors'] and d['undone'] and d['rerun']['withName']==1 and d['rerun']['withEmail']==1 and d['rerun']['emailAssigned']" \
    "Generate ▸ Builder… did not write the inner builder of RFC 0015 use case 1 (or left an error, needed more than one undo), or the re-run of use case 2 duplicated a member: $(field "$J_" shortcuts | cut -c1-1500)"
  assert_json "$J_" shortcuts "'int b;\n        try {\n            int a = 1; // first\n            System.out.println(a);\n            b = a + 1;\n        } catch (' in d['surround']['wrapped'] and d['surround']['refusal'] and d['surround']['laterUnchanged']" \
    "Surround with… did not widen the selection to the three statements and hoist b (use case 5), or did not refuse the var local used after it (use case 6): $(field "$J_" shortcuts | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["surround"])[:1500])')"
  log "SURROUND-OK (Surround with… ▸ try / catch on a selection from mid-way through int a = 1 to before the third statement's semicolon: the three whole statements in the try, the comment kept, b hoisted as int b; and assigned inside; on var v used below the selection: '$(field "$J_" shortcuts | python3 -c 'import json,sys;print((json.load(sys.stdin)["surround"]["refusal"] or "")[:90])')', the file unchanged — RFC 0015 use cases 5–6)"
  assert_json "$J_" shortcuts "any('@Builder (Lombok)' in r for r in d['lombok']['step']) and '@Builder' in d['lombok']['text'] and 'import lombok.Builder;' in d['lombok']['text'] and 'class Builder' not in d['lombok']['text']" \
    "in the orders module, which depends on Lombok, Builder… did not offer @Builder (Lombok) first, or taking it wrote more than the annotation and its import: $(field "$J_" shortcuts | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["lombok"])[:900])')"
  log "LOMBOK-OK (Builder… in the orders module, Lombok on its classpath: the first step offered '@Builder (Lombok)' above 'Generated code', Enter took it — @Builder and import lombok.Builder, no generated member; in core, without Lombok, the step never showed — RFC 0015 use case 3)"
  log "SHORTCUTS-OK (Generate ▸ Builder… on Customer: fields, prefix and placement through the quick input, the defaults kept with Enter — builder(), a private Customer(Builder b) setting the final id, an inner Builder with withName/withAge/withId and build(); no error on the file; one Ctrl+Z took it all back; after a new field, the same command added only withEmail and its assignment — RFC 0015 use cases 1–2)"
  assert_json "$J_" profileSchema "any(r.startswith('inspections.json') and r.endswith(' 4') for r in d['problems']) and any('Missing property \"why\"' in r for r in d['problems']) and any('ifReturnBool is not allowed' in r for r in d['problems']) and any('needs a \"why\"' in r and 'batlehub' in r for r in d['problems']) and any('unknown rule style/ifReturnBool' in r for r in d['problems'])" \
    "the profile schema did not flag an off without a why and an unknown rule in .batlehub/java/inspections.json, or flagged the valid entry: $(field "$J_" profileSchema | cut -c1-900)"
  log "PROFILE-SCHEMA-OK (.batlehub/java/inspections.json under java-core's schema, generated from the bundle: '$(field "$J_" profileSchema | python3 -c 'import json,sys;print(next((r for r in json.load(sys.stdin)["problems"] if "why" in r), "")[:90])')' and the misspelt style/ifReturnBool flagged, exactly those two on the file — the argued redundantThis off accepted — RFC 0005 phase 1)"
  assert_json "$J_" profile "not any('batlehub style/redundantThis' in r for r in d['problems']) and any(r.startswith('E ') and 'stringConcatInLoop' in r for r in d['problems']) and 'off — profile: house style' in d['pane'] and 'inspections.json has 2 errors' in d['pane'] and any('profile: 11 rules known, 1 off, 1 unknown' in l for l in d['channel'])" \
    "the profile was not applied to Greeter.java (redundantThis off, stringConcatInLoop an error), or the view and the channel did not say so: $(field "$J_" profile | cut -c1-1200)"
  log "PROFILE-OK (.batlehub/java/inspections.json applied: redundantThis gone from Problems, stringConcatInLoop an error, the view's row 'off — profile: house style', its banner 'inspections.json has 2 errors' — the why-less off and the unknown rule, each a row on the file — and the channel's '$(field "$J_" profile | python3 -c 'import json,sys;print(json.load(sys.stdin)["channel"][-1].split("] ")[-1])')' — RFC 0005 phase 2, use cases 1, 2, 4 and 5)"
  assert_json "$J_" profileFixAll "d['thisKept'] and d['sizeFixed']" \
    "Fix all in file applied the fix of a rule the profile turned off, or no fix at all: $(field "$J_" profileFixAll)"
  log "PROFILE-FIXALL-OK (Fix all in file under the profile: size() == 0 became isEmpty(), this.people kept — redundantThis is off for the team — RFC 0005 decision 11)"
  assert_json "$J_" profileOverride "any(r.startswith('W ') and 'batlehub style/redundantThis' in r for r in d['problems']) and 'warning (you) — differs from project: off' in d['pane'] and '1 rule differs from project' in d['pane'] and '1 rule differs from project' in d['panelLine'] and d['profileUnchanged']" \
    "the developer's override did not win over the profile in the editor, or the view did not mark it: $(field "$J_" profileOverride | cut -c1-1200)"
  log "PROFILE-OVERRIDE-OK (severityOverrides redundantThis: warning over the profile's off — the row back as a warning, the view 'warning (you) — differs from project: off' and '1 rule differs from project', the Java panel's inspections line the same count, the profile untouched — RFC 0005 use case 3)"
  assert_json "$J_" profileSave "d['file'] and d['file'].get('\$schema','').endswith('java-inspections.schema.json') and d['file']['version']==1 and d['file']['rules']=={'style/redundantThis':{'severity':'off','why':''},'performance/stringConcatInLoop':{'severity':'error'}} and any('needs a \"why\"' in r for r in d['problems']) and d['manifest']" \
    "Save as project profile did not write the two overrides as the team's file, an empty why on the off, recorded in the manifest: $(field "$J_" profileSave | cut -c1-900)"
  log "PROFILE-SAVE-OK (Java: Save as project profile with two overrides and no file: inspections.json created with \$schema, version 1, style/redundantThis off with an empty why and stringConcatInLoop error, a profile entry in written.json, and the file's row '\"off\" needs a \"why\"' until someone argues it — RFC 0005 use case 6)"
  assert_json "$J_" projectSchema "any(r.startswith('project.json') and r.endswith(' 4') for r in d['problems'])" \
    "the project.json schema (and, RFC 0006 phase 3, the core's own walker) did not flag exactly the string activeProfiles and the boolean registry.enabled, twice each: $(field "$J_" projectSchema | cut -c1-900)"
  log "PROJECT-SCHEMA-OK (.batlehub/java/project.json under java-core's schema: activeProfiles as a string and registry.enabled as a boolean flagged, maven.configuration accepted — $(field "$J_" projectSchema | python3 -c 'import json,sys;print("; ".join(r[:60] for r in json.load(sys.stdin)["problems"][1:3]))') — RFC 0006 phase 1)"
  assert_json "$J_" projectFile "d['prefs']=='ci' and any('project.json: maven.activeProfiles=[\"ci\"] (committed)' in l for l in d['channel'])" \
    "project.json's maven.activeProfiles did not reach core/.settings/org.eclipse.m2e.core.prefs without a command, or the channel did not say so: $(field "$J_" projectFile | cut -c1-600)"
  log "PROJECT-FILE-OK (.batlehub/java/project.json committing maven.activeProfiles [\"ci\"]: the m2e preference of core/ became activeProfiles=ci with nobody running a command, and the channel says 'project.json: maven.activeProfiles=[\"ci\"] (committed)' — RFC 0006 use case 1, trusted)"
  assert_json "$J_" projectOverride "d['prefs']=='dev,ci' and d['effective']['value']==['dev','ci'] and d['effective']['origin']=='settings' and d['effective'].get('differsFromProject') and d['project']['value']==['ci'] and d['project']['origin']=='project.json' and d['fileUnchanged']" \
    "the developer's batlehub.java.maven.activeProfiles did not win over project.json, or Show effective configuration did not mark it: $(field "$J_" projectOverride | cut -c1-900)"
  log "PROJECT-OVERRIDE-OK (batlehub.java.maven.activeProfiles [dev, ci] in settings.json over the file's [ci]: the preference became dev,ci; Java: Show effective configuration gives effective = settings, differsFromProject, and project = [ci] from project.json; the file untouched — RFC 0006 use case 2)"
  assert_json "$J_" projectPanel "'set by you (settings.json) — differs from project: ci' in d['profilesTab'].lower() and d['saved']==['dev','ci'] and d['manifest']" \
    "the Profiles tab did not show the differs-from-project origin, or Save to project did not write the tab's profiles into project.json through the manifest: $(field "$J_" projectPanel | cut -c1-900)"
  log "PROJECT-PANEL-OK (the Profiles tab: 'set by you (settings.json) — differs from project: ci'; Save to project wrote [dev, ci] into project.json, a project entry in the manifest — RFC 0006 §6.4)"
  assert_json "$J_" projectSettingsFile "d['notification'] and 'settings-other.xml' in d['notification'] and d['kept']" \
    "a committed configuration selecting another settings file was not announced, or Keep mine was not honoured: $(field "$J_" projectSettingsFile | cut -c1-600)"
  log "SETTINGSFILE-WARN-OK (project.json selecting ~/.m2/settings-other.xml: one warning naming both files, 'Keep mine' remembered and the developer's own kept — RFC 0006 use case 8)"
  assert_json "$J_" projectInvalid "any('activeProfiles' in r and 'batlehub' in r for r in d['problems'])" \
    "a string maven.activeProfiles in project.json got no batlehub Problems row on the file: $(field "$J_" projectInvalid | cut -c1-600)"
  log "PROJECT-INVALID-OK (maven.activeProfiles as a string: a batlehub row on project.json, '$(field "$J_" projectInvalid | python3 -c 'import json,sys;print(next((r for r in json.load(sys.stdin)["problems"] if "batlehub" in r), "")[:90])')', the key treated as absent — RFC 0006 use case 3)"
  assert_json "$J_" groovy "d['registered'] and d['started'] and 'Groovy' in d['languageMode'] and d['statusItemHidden'] and d['statusItemShownAfterToggle']" \
    "the Groovy satellite did not register and start, or Hello.groovy did not open as Groovy: $(field "$J_" groovy | cut -c1-400)"
  log "GROOVY-OK (java-groovy registered through the contract, the server started on the core's JDK, Hello.groovy in Groovy mode; hover: '$(field "$J_" groovy | python3 -c 'import json,sys;print(json.load(sys.stdin)["hover"][:80])')'; its status bar item hidden by default and shown once batlehub.java.statusBar.items toggles it)"
  assert_json "$J_" procGroovy "d['started'] and d['inSum']" \
    "the Groovy server is not a managed process of the core, or its cap is not in the resources sum: $(field "$J_" procGroovy | cut -c1-400)"
  log "PROC-GROOVY-OK (java-groovy's server started through the contract's process.start — 768 MiB declared, in the JDK tab's sum; RFC 0003 case 5)"
  assert_json "$J_" runOrder "d['written'] and d['up'] and d['answered'] and 'run ● 1 process' in d['status'] and any(l.startswith('step 1 ready (port 18080 in') for l in d['console']) and any('Serving' in r for r in d['terminal']) and 'stopped by user' in d['stopConsole'] and any(l.startswith('stopping 1 (jwebserver) … stopped (term)') for l in d['stopConsole']) and d['portFreeAfter'] and 'run ●' not in d['statusAfter']" \
    "case 1/4: the orchestrated run did not start jwebserver in order, show it, or stop it: $(field "$J_" runOrder | cut -c1-900)"
  log "RUN-ORDER-OK (Java: New run configuration → Orchestrated run wrote a batlehub-run entry; F5: jwebserver in the terminal 'step 1: jwebserver', ready on port 18080, the status bar reads run ● 1 process; Debug: Stop → SIGTERM, the port free, the segment gone — RFC 0003 cases 1 and 4)"
  assert_json "$J_" runAccept "not d['timedOut'] and 'step 1 exited 0' in d['console'] and any(l.startswith('step 2 ready (http') for l in d['console']) and 'step 3 ended (its debugger reports no exit code)' in d['console'] and d.get('itGot') == '200' and 'stopping 3 (Run IT) … already done' in d['console'] and any(l.startswith('stopping 2 (jwebserver) … stopped') for l in d['console']) and 'stopping 1 (batlehub-java: maven compile) … already done' in d['console'] and d['portFreeAfter']" \
    "case 2: the acceptance run did not go task → server ready by HTTP → launch exited 0 → reverse stop: $(field "$J_" runAccept | cut -c1-900)"
  log "RUN-ACCEPT-OK (maven compile exited 0, jwebserver ready by HTTP, the Run IT node launch GETs it (200) and ends — js-debug reports no exit code, and the run says so — then stopping 3 already done, 2 stopped, 1 already done; the port free — RFC 0003 case 2)"
  assert_json "$J_" runTimeout "not d['timedOut'] and 'step 1 not ready after 5 s: http 404 (last)' in d['console'] and any(l.startswith('stopping 1 (jwebserver) … stopped') for l in d['console']) and d['portFreeAfter'] and 'run ●' not in d['statusAfter']" \
    "case 3: a probe that never answers did not fail the run and still stop the process: $(field "$J_" runTimeout | cut -c1-900)"
  log "RUN-TIMEOUT-OK (http 404 for 5 s fails the run with the last answer named, and the reverse stop still ran: the port free, the status bar segment gone — RFC 0003 case 3)"
  CP="$(field "$J_" classpath)"
  log "SPIKE-A: $(printf '%s' "$CP" | cut -c1-300)"
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); assert "classpath of" in d["tail"] or d["entriesAfter"]>0, "no classpath read at all"; assert not d["before"], "commons-lang3 on the classpath before any profile — the fixture is wrong"' "$CP" || fail "spike (a) baseline"
  if python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d["after"] else 1)' "$CP"; then
    log "SPIKE-A-OK (m2e reads activeProfiles= from .settings/org.eclipse.m2e.core.prefs: the profile-only dependency reached the classpath after re-import — no overlay needed, decision 14)"
  else
    log "SPIKE-A-NEGATIVE (the m2e preference did not bring the profile-only dependency into the classpath: decision 14's overlay fallback applies)"
  fi
  assert_json "$J_" idea-untrusted "not any('IntelliJ import plan' in n for n in d['notifications']) and any('Trust this workspace' in n for n in d['notifications']) and d.get('settings') is None and d.get('profile') is None" \
    "the import ran in an untrusted workspace, or its gate said nothing: $(field "$J_" idea-untrusted | cut -c1-300)"
  log "IMPORT-TRUST-OK (untrusted: the command names workspace trust, reads no .idea/ and writes nothing — not even the experimental flag)"
  assert_json "$J_" idea "any('Code style' in r for r in d['scopeRows']) and any('Run configurations' in r for r in d['scopeRows'])" \
    "the scope pick did not offer the kinds: $(field "$J_" idea | cut -c1-300)"
  assert_json "$J_" idea "'options mapped' in d['plan'] and 'WRAP_LONG_LINES' in d['plan'] and 'run configurations' in d['plan']" \
    "the plan did not report its counts and its unmapped options: $(field "$J_" idea | python3 -c 'import json,sys;print(json.load(sys.stdin)["plan"][:400])')"
  assert_json "$J_" idea "d['onDiskDuringPlan'].get('profile') is None and (d['onDiskDuringPlan'].get('settings') is None or 'java.format.settings.url' not in d['onDiskDuringPlan']['settings'])" \
    "Show diff put something on disk: the right-hand side must be a virtual document until Write"
  assert_json "$J_" idea "any('formatter.xml' in t for t in d['diffTabs']) and any('settings.json' in t for t in d['diffTabs'])" \
    "Show diff did not open a diff editor per target: $(field "$J_" idea | python3 -c 'import json,sys;print(json.load(sys.stdin)["diffTabs"])')"
  log "IMPORT-PLAN-OK (scope pick → a plan with its counts and its gaps → a diff editor per target, nothing on disk)"
  assert_json "$J_" idea "d['wroteProfile'] and 'java.format.settings.url' in (d.get('wroteSettings') or '') and 'java.completion.importOrder' in (d.get('wroteSettings') or '') and '[java]' in (d.get('wroteSettings') or '')" \
    "Write did not leave the profile and the settings: $(field "$J_" idea | cut -c1-400)"
  assert_json "$J_" idea "'formatter.xml' in (d.get('manifest') or '') and 'java.format.settings.url' in (d.get('manifest') or '')" \
    "the import's writes did not go through the manifest: $(field "$J_" idea | python3 -c 'import json,sys;print((json.load(sys.stdin)["manifest"] or "")[:400])')"
  assert_json "$J_" idea "d['ideaUnchanged']" "the import modified .idea/ — it is read-only (§6.6)"
  # ── RFC 0007 use cases 2 and 3: live templates and the file header ──
  assert_json "$J_" idea "any('Live templates' in r for r in d['scopeRows']) and any('File templates' in r for r in d['scopeRows'])" \
    "the scope pick does not offer the two template kinds: $(field "$J_" idea | python3 -c 'import json,sys;print(json.load(sys.stdin)["scopeRows"])' | cut -c1-300)"
  assert_json "$J_" idea "'live templates' in d['plan'] and 'from IntelliJIdea2026.1' in d['plan'] and 'iterableVariable()' in d['plan'] and 'HTML_TEXT' in d['plan']" \
    "the plan does not name where the live templates came from, or does not list the iter expression and the non-Java template it skipped: $(field "$J_" idea | python3 -c 'import json,sys;print(json.load(sys.stdin)["plan"])' | cut -c1-600)"
  assert_json "$J_" idea "d.get('snippets') and set(json.loads(d['snippets'])) == {'sout','psvm','fori','iter','file:Class'} and json.loads(d['snippets'])['sout']['body'] == ['System.out.println(' + chr(36) + '0);'] and json.loads(d['snippets'])['fori']['body'][0].count(chr(36) + '{1:i}') == 3 and (chr(36) + '2') in json.loads(d['snippets'])['fori']['body'][0]" \
    "the snippets file is not the four Java live templates plus the file template, with IDEA's variables as tab stops: $(field "$J_" idea | python3 -c 'import json,sys;print(json.load(sys.stdin).get("snippets"))' | cut -c1-600)"
  assert_json "$J_" idea "'div' not in json.loads(d['snippets'])" "the HTML live template reached a Java-scoped snippets file"
  assert_json "$J_" idea "(chr(36) + '{year}') in (d.get('wroteSettings') or '') and 'java.templates.fileHeader' in (d.get('wroteSettings') or '')" \
    "java.templates.fileHeader was not written with JDT's own variables: $(field "$J_" idea | python3 -c 'import json,sys;print(json.load(sys.stdin).get("wroteSettings"))' | cut -c1-400)"
  assert_json "$J_" idea "'PACKAGE_NAME' not in d['snippets'] and 'Copyright' in ' '.join(json.loads(d['snippets'])['file:Class']['body'])" \
    "the file template kept the package line, or lost the header include decision 15 says to expand: $(field "$J_" idea | python3 -c 'import json,sys;print(json.loads(json.load(sys.stdin)["snippets"])["file:Class"])' | cut -c1-400)"
  assert_json "$J_" idea "'intellij.code-snippets' in (d.get('manifest') or '')" \
    "the snippets file is not in the manifest, so Remove BatleHub settings would leave it behind"
  assert_json "$J_" idea-snippet "not d['timedOut'] and any('sout' in s for s in d['suggestions'])" \
    "the imported sout snippet is not offered by the editor's completion in a Java file: $(field "$J_" idea-snippet | cut -c1-300)"
  log "IMPORT-SNIPPET-OK (four Java live templates of the IDEA configuration directory + the project's file template → .vscode/intellij.code-snippets through the manifest; iter's iterableVariable() listed and the template still shipped; the HTML one skipped; java.templates.fileHeader in JDT's variables; sout offered by the editor's own completion)"
  assert_json "$J_" idea "'this.people' in (d.get('greeterBefore') or '') and 'private int unused' in (d.get('greeterBefore') or '')" \
    "Greeter.java was not the committed file before Format Document — an earlier step left a dirty buffer or a saved edit behind"
  assert_json "$J_" idea "not d['formatTimedOut'] and d.get('golden') and d['formatted'].strip() == d['golden'].strip()" \
    "Format Document did not reproduce IDEA's own output: $(field "$J_" idea | python3 -c '
import difflib, json, sys
d = json.load(sys.stdin)
print("".join(list(difflib.unified_diff((d.get("golden") or "").splitlines(True), (d.get("formatted") or "").splitlines(True), "idea", "jdt"))[:24]))')"
  log "IMPORT-OK (the code style of .idea/ → an Eclipse profile + the settings, through the manifest; Format Document on Greeter.java is byte-for-byte what IDEA 2026.1.3 produced with the same scheme; .idea/ untouched)"
  assert_json "$J_" chain "d['settingWritten'] is True and d['manifestHas'] and d['log']" \
    "the core did not write java.completion.chain.enabled through the manifest: $(field "$J_" chain | cut -c1-300)"
  assert_json "$J_" chain "'Chain completion turned on' in d['notice'] and 'Undo' in d['notice']" \
    "the Java panel did not show the default-on line with its undo: $(field "$J_" chain | python3 -c 'import json,sys;print(json.load(sys.stdin)["notice"][:200])')"
  log "CHAIN-WRITE-OK (java.completion.chain.enabled written at workspace scope through the manifest; the panel says so once, with Undo)"
  log "CHAIN-TRACE $(field "$J_" chain | python3 -c 'import json,sys;print((json.load(sys.stdin).get("requestTrace") or "redhat.java request trace: no line")[-80:])')"
  assert_json "$J_" chain "d['hasChain'] and not d['offHasChain']" \
    "no chain proposal on the completion shortcut, or one still there with the setting off: $(field "$J_" chain | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["items"])')"
  log "CHAIN-OK (a chain to the expected type on the completion shortcut — $(field "$J_" chain | python3 -c 'import json,sys;d=json.load(sys.stdin);print(next((r for r in d["items"] if "getServer" in r), "?"))'); absent with the setting off)"
  assert_json "$J_" chain "d['afterUndo']['clicked'] and d['afterUndo']['setting'] is None and not d['afterUndo']['manifestHas'] and d['afterUndo']['manifestOther'] > 0" \
    "Undo did not remove the setting and its one manifest entry, or it removed more than that: $(field "$J_" chain | python3 -c 'import json,sys;print(json.load(sys.stdin)["afterUndo"])')"
  log "UNDO-OK (Undo restored java.completion.chain.enabled to unset and dropped that one manifest entry, leaving every other write alone)"
  assert_json "$J_" chainDelegate "d['found'] and not d['truncated']" \
    "the delegate did not answer config.getServer().getPort() for an int while typing in \"auto\", or it was truncated on the fixture: $(field "$J_" chainDelegate | cut -c1-400)"
  log "CHAIN-DELEGATE-OK (int p = g → $(field "$J_" chainDelegate | python3 -c 'import json,sys;d=json.load(sys.stdin);print(next((r for r in d["items"] if "getPort" in r), "?"))'), no shortcut; provider round trips $(field "$J_" chainDelegate | python3 -c 'import json,sys;print(json.load(sys.stdin)["trips"])') ms)"
  log "CHAIN-RANK $(field "$J_" chain | python3 -c 'import json,sys;d=json.load(sys.stdin);print("rank", d["chainRank"], "of", d.get("rankedCount"), "after typing con; the server sorts every chain last (sortText 999999979) —", d["rankedItems"][:4])')"
  assert_json "$J_" remove "any(c.startswith('Restore') for c in d['clicked']) and (d['settings'] is None or 'java.configuration.runtimes' not in d['settings'])" \
    "Remove BatleHub settings did not restore java.configuration.runtimes"
  log "REMOVE-OK (the manifest replayed: java.configuration.runtimes and java.jdt.ls.java.home restored, the dialog listed what it would do)"
  MIGRATED="$(grep -rh "migrated .batlehub/java to the local/ layout" "$J/server/data/logs" 2>/dev/null | head -1)"
  [[ -n "$MIGRATED" ]] || fail "RFC 0006 use case 5: the v1 layout was not migrated at activation (no 'migrated' line in the BatleHub Java channel)"
  ! grep -q "batlehub-java" "$JWS/.gitignore" || fail "RFC 0006 use case 5: after migration and removal, .gitignore still carries a batlehub-java line: $(cat "$JWS/.gitignore")"
  [[ ! -e "$JWS/.batlehub/java/written.json" && ! -e "$JWS/.batlehub/java/local/written.json" ]] || fail "RFC 0006 use case 5: a manifest survived Remove BatleHub settings"
  log "MIGRATE-V1-OK (a workspace on the v1 layout — written.json beside the team's files, '/.batlehub/java/' in .gitignore — migrated at activation: the manifest into local/, the line narrowed to local/ and recorded; every later write landed in local/written.json, and Remove BatleHub settings left no manifest and no batlehub-java line — RFC 0006 phase 2)"
  PERF="$(field "$J_" perf)"
  log "PERF $PERF"
  # The gate of §4.2 "Performance is measured before it is gated": thresholds
  # set from phase 2's measurement in this workspace (status bar 1.9 s,
  # detection 0.6 s, Standard 2.1 s after the reload, activation < 1 s),
  # each at roughly five times what was measured. A CI runner is slower;
  # HEAVY_PERF_FACTOR widens them.
  F="${HEAVY_PERF_FACTOR:-1}"
  python3 - "$PERF" "$F" <<'PY' || fail "the performance gate"
import json, sys
d = json.loads(sys.argv[1]); f = float(sys.argv[2])
# panelPaintMs is measured from activation and includes the minutes the
# driver spends elsewhere before opening the panel: printed, not gated.
# chainMs is RFC 0012 §2.1 use case 3: the median of ten completion round
# trips with chain completion on, read from redhat.java's own request trace.
# chainOffMs is the same with it off, printed beside it so the cost of the
# feature is a delta in the log rather than a feeling. chainDelegateMs is
# use case 4: the median of ten provider round trips in "auto", cold cache.
gates = {"statusBarMs": 10000, "detectionMs": 3000, "readyMs": 60000, "activationMs": 5000, "chainMs": 800, "chainDelegateMs": 150}
bad = [f"{k}={d.get(k)} > {v*f:.0f}" for k, v in gates.items() if d.get(k, -1) < 0 or d.get(k) > v * f]
if bad: print("PERF-GATE failed: " + ", ".join(bad)); sys.exit(1)
print("PERF-GATE ok: " + ", ".join(f"{k}={d[k]} ms (< {v*f:.0f})" for k, v in gates.items())
      + f"; chain completion costs {d.get('chainMs', -1) - d.get('chainOffMs', -1)} ms over chainOffMs={d.get('chainOffMs')} ms, rank {d.get('chainRank')}")
PY
  # The other half of §2 point 1, and what the runner found (§15.5): a desktop
  # — or a CI runner with /usr/lib/jvm — has a JDK `redhat.java` finds on its
  # own. The core must then leave `java.jdt.ls.java.home` alone and never
  # reload a server that is already starting; two JDT.LS on one `jdt_ws` is a
  # bundle ping that waits ten minutes. Handing redhat.java a JAVA_HOME is how
  # the suite creates that precondition without root.
  DESKTOP_JDK="${JAVA_HOME:-}"
  [[ -n "$DESKTOP_JDK" ]] || DESKTOP_JDK="$(mise ls java --json 2>/dev/null | python3 -c 'import json,sys
try: paths = [e["install_path"] for e in json.load(sys.stdin) if e.get("install_path")]
except Exception: paths = []
print(paths[-1] if paths else "")' 2>/dev/null || true)"
  if [[ -n "$DESKTOP_JDK" && -x "$DESKTOP_JDK/bin/java" ]]; then
    J2="$HEAVY_WORK/editor-java-desktop"
    JWS2="$HEAVY_WORK/java-ws-desktop"
    rm -rf "$JWS2" && cp -r "$REPO/tests/heavy/fixtures/maven-multi" "$JWS2"
    mkdir -p "$HEAVY_WORK/shots/desktop"
    EDITOR_FOLDER="$JWS2"
    start_editor "$J2" '{ "workbench.startupEditor": "none", "java.server.launchMode": "Standard", "java.jdt.ls.vmargs": "-XX:+UseParallelGC -Xmx1G -Xms100m -Xlog:disable", "batlehub.java.log.level": "debug", "security.workspace.trust.enabled": false, "extensions.ignoreRecommendations": true, "git.openRepositoryInParentFolders": "never", "terminal.integrated.gpuAcceleration": "off" }' \
      JAVA_HOME="$DESKTOP_JDK" PATH="$DESKTOP_JDK/bin:$JAVA_ENV_PATH" JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=6"
    DUMP_ON_FAIL="$J2"; DUMP_JSONL="$HEAVY_WORK/java-desktop.jsonl"
    # Four phases and out: this session is about what the core does *not* do.
    node tests/heavy/java.mjs --url "http://127.0.0.1:$EDITOR_PORT/?folder=$JWS2" --shots "$HEAVY_WORK/shots/desktop" --cdp "$CDP_URL" \
      --workspace "$JWS2" --stop-after reload >"$HEAVY_WORK/java-desktop.jsonl" 2>"$HEAVY_WORK/java-desktop.jsonl.err" \
      || { cat "$HEAVY_WORK/java-desktop.jsonl.err" >&2; cat "$HEAVY_WORK/java-desktop.jsonl" >&2; fail "the java desktop driver failed"; }
    stop_editor
    cat "$HEAVY_WORK/java-desktop.jsonl" >>"$LOG"
    D_="$HEAVY_WORK/java-desktop.jsonl"
    assert_json "$D_" log "'wrote java.jdt.ls.java.home' not in ' '.join(d['lines'])" \
      "redhat.java had its own JDK through JAVA_HOME and the core wrote java.jdt.ls.java.home anyway — that write is the second JDT.LS of §15.5"
    assert_json "$D_" reload "not d['reloaded']" "the core reloaded a language server that was already starting"
    log "DESKTOP-OK (redhat.java found its own JDK: no java.jdt.ls.java.home write, no reload — the double-server race of §15.5 cannot happen)"
  else
    log "DESKTOP-SKIP (no JDK to hand redhat.java directly: set JAVA_HOME, or install one with mise)"
  fi
  log "JAVA-OK"
fi

# ---- 7. The seasons half (RFC 0019 section 10) --------------------------
if [[ "$ONLY" == "all" || "$ONLY" == "seasons" ]]; then
  log "Seasons half: batlehub-seasons in the real editor - a one-day window covering today, then the undo from the palette"
  (cd "$REPO/extensions/batlehub-seasons" && pnpm run package >>"$HEAVY_WORK/package.log" 2>&1) \
    || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "packaging batlehub-seasons failed"; }
  SEASONS_VSIX="$REPO/extensions/batlehub-seasons/batlehub-seasons.vsix"
  [[ -s "$SEASONS_VSIX" ]] || fail "no $SEASONS_VSIX"
  log "PACKAGE-OK (batlehub-seasons $(stat -c %s "$SEASONS_VSIX") bytes)"

  S="$HEAVY_WORK/editor-seasons"
  # The window the suite runs in is a one-day user entry covering today: the
  # config surface is its own test seam, which is why the extension has no
  # date-forcing setting (RFC 0019 section 10).
  S_TODAY="$(date +%m-%d)"
  # Overridable, so the half doubles as the way to actually look at a shipped
  # palette in a real editor (RFC 0019 open question 1):
  #   SEASONS_BG=#a8470a SEASONS_FG=#fff6ec SEASONS_GLYPH=🎃 \
  #     SEASONS_NAME=Halloween task heavy:view:seasons
  S_BG="${SEASONS_BG:-#7a1f6b}"
  S_FG="${SEASONS_FG:-#fdf2fb}"
  S_GLYPH="${SEASONS_GLYPH:-🧪}"
  S_NAME="${SEASONS_NAME:-Heavy day}"
  # A literal with no ${...} variable in it, so document.title is exactly this
  # and the glyph assertion is unambiguous with no folder open.
  S_TITLE="heavy-title-marker"
  # Every setting of this extension is application-scoped (section 7), and in
  # the web build user settings live in the browser rather than in the
  # server's data dir, so they cannot be seeded from a file - the driver types
  # them through `Preferences: Open User Settings (JSON)`. One line, so
  # auto-indent cannot touch it.
  S_SEED="$(python3 - "$S_TODAY" "$S_BG" "$S_FG" "$S_GLYPH" "$S_NAME" "$S_TITLE" <<'SEEDPY'
import json, sys
today, bg, fg, glyph, name, title = sys.argv[1:7]
print(json.dumps({
    "window.title": title,
    "batlehub.seasons.events": [
        {"name": name, "from": today, "to": today, "glyph": glyph, "background": bg, "foreground": fg}
    ],
}, ensure_ascii=False))
SEEDPY
)"
  INSTALL_VSIX=("$SEASONS_VSIX")
  # A folder, even an empty one: with no folder open the editor paints the
  # status bar from `statusBar.noFolderBackground`, which is not a key the
  # overlay owns, and every real window has one anyway.
  SWS="$HEAVY_WORK/seasons-ws"
  mkdir -p "$SWS"
  printf '# seasons\n' >"$SWS/README.md"
  EDITOR_FOLDER="$SWS"
  # Monaco's auto-closing off, so the JSON the driver types arrives literally.
  start_editor "$S" '{ "workbench.startupEditor": "none", "workbench.colorTheme": "Dark Modern", "security.workspace.trust.enabled": false, "extensions.ignoreRecommendations": true, "terminal.integrated.gpuAcceleration": "off", "editor.autoClosingBrackets": "never", "editor.autoClosingQuotes": "never", "editor.autoSurround": "never", "editor.autoIndent": "none", "editor.formatOnType": false, "editor.formatOnSave": false, "files.autoSave": "off" }'
  log "Editor (VS Code $VSCODE_VERSION, web) at http://127.0.0.1:$EDITOR_PORT, folder $SWS"
  DUMP_ON_FAIL="$S"; DUMP_JSONL="$HEAVY_WORK/seasons.jsonl"
  node tests/heavy/seasons.mjs --url "http://127.0.0.1:$EDITOR_PORT/?folder=$SWS" --shots "$HEAVY_WORK/shots" --cdp "$CDP_URL" \
    --seed "$S_SEED" --background "$S_BG" --glyph "$S_GLYPH" --name "$S_NAME" --title "$S_TITLE" \
    >"$HEAVY_WORK/seasons.jsonl" 2>"$HEAVY_WORK/seasons.jsonl.err" \
    || { cat "$HEAVY_WORK/seasons.jsonl.err" >&2; cat "$HEAVY_WORK/seasons.jsonl" >&2; fail "the seasons driver failed"; }
  stop_editor
  cat "$HEAVY_WORK/seasons.jsonl" >>"$LOG"
  S_="$HEAVY_WORK/seasons.jsonl"

  assert_json "$S_" applied "d['items'] and d['glyph'] in d['items'][0]['text'] and d['name'] in d['items'][0]['text']" \
    "the seasons status bar item never showed the glyph and the window's name"
  assert_json "$S_" applied "not d['timedOut'] and d['hex']['titleBar'] == d['expected']" \
    "the title bar was never painted the window's colour (the overlay did not reach the workbench)"
  assert_json "$S_" applied "d['hex']['activityBar'] == d['expected'] and d['hex']['statusBar'] == d['expected']" \
    "the activity bar or the status bar kept the theme's colour"
  # The invariant of section 5.3, asserted against the editor rather than the code.
  assert_json "$S_" applied "d['hex']['ground'] and d['hex']['ground'] != d['expected'] and d['hex']['ground'] == d['theme']['ground']" \
    "the workbench ground took the season's colour - the overlay must never touch the surface code is read on"
  assert_json "$S_" applied "d['chrome']['documentTitle'] == d['glyph'] + ' ' + d['title']" \
    "the browser tab's title is not the glyph in front of the user's own window.title"
  log "SEASONS-OK (the window's colour on the title bar, activity bar and status bar but not the ground; the glyph in front of the user's title in the browser tab)"

  assert_json "$S_" removed "not d['timedOut'] and d['hex']['titleBar'] == d['theme']['titleBar'] and d['hex']['titleBar'] != d['expected']" \
    "the title bar kept the season's colour after the undo"
  assert_json "$S_" removed "d['hex']['activityBar'] == d['theme']['activityBar'] and d['hex']['statusBar'] == d['theme']['statusBar']" \
    "the activity bar or the status bar kept the season's colour after the undo"
  assert_json "$S_" removed "d['chrome']['documentTitle'] == d['title']" \
    "window.title was not put back to the value the user had set (the glyph is still there, or the title was deleted)"
  assert_json "$S_" removed "not d['items']" "the status bar item is still showing after the undo"
  log "UNDO-OK (the palette command put every colour back and restored the user's own window.title)"

  # The assertion the whole _saved design exists for: nothing left behind can
  # paint the chrome again.
  assert_json "$S_" persisted "d['hex']['titleBar'] == d['theme']['titleBar'] and d['hex']['activityBar'] == d['theme']['activityBar'] and d['hex']['statusBar'] == d['theme']['statusBar']" \
    "after a reload the chrome went back to the season's colour - something was left behind in the settings"
  assert_json "$S_" persisted "d['chrome']['documentTitle'] == d['title'] and not d['items']" \
    "after a reload the glyph or the status bar item came back"
  log "PERSIST-OK (a window reload finds nothing of ours left to reapply)"
  log "SEASONS-HALF-OK"
fi

# ---- 8. The quarkus half (RFC 0011 section 10) ---------------------------
if [[ "$ONLY" == "all" || "$ONLY" == "quarkus" ]]; then
  log "Quarkus half: java-quarkus with the Red Hat pair, then without it - the quarkus fixture, dev mode as a managed process"
  QUARKUS_VERSION="3.40.1"
  MICROPROFILE_VERSION="${MICROPROFILE_VERSION:-0.18.0}"
  VSCODE_QUARKUS_VERSION="${VSCODE_QUARKUS_VERSION:-1.24.2026082508}"
  JAVA_DEBUG_VERSION="${JAVA_DEBUG_VERSION:-0.59.0}"
  jdt_bundle
  for p in java-core java-quarkus; do
    (cd "$REPO/extensions/$p" && pnpm run package >>"$HEAVY_WORK/package.log" 2>&1) || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "packaging $p failed"; }
  done
  JAVA_CORE_VSIX="$REPO/extensions/java-core/java-core.vsix"
  QUARKUS_VSIX="$REPO/extensions/java-quarkus/java-quarkus.vsix"
  ovsx() { # ovsx <namespace> <name> <version>: a pinned VSIX from Open VSX, cached
    local f="$HEAVY_CACHE/$1.$2-$3.vsix"
    [[ -s "$f" ]] || { log "Downloading $1.$2 $3 from Open VSX"; fetch -o "$f" "https://open-vsx.org/api/$1/$2/$3/file/$1.$2-$3.vsix"; }
    printf '%s' "$f"
  }
  REDHAT_VSIX="$(ovsx redhat java "$REDHAT_JAVA_VERSION")"
  MP_VSIX="$(ovsx redhat vscode-microprofile "$MICROPROFILE_VERSION")"
  DEBUG_VSIX="$(ovsx vscjava vscode-java-debug "$JAVA_DEBUG_VERSION")"
  RHQ_VSIX="$(ovsx redhat vscode-quarkus "$VSCODE_QUARKUS_VERSION")"
  log "PACKAGE-OK (java-quarkus $(stat -c %s "$QUARKUS_VSIX") bytes; redhat.java $REDHAT_JAVA_VERSION, vscode-microprofile $MICROPROFILE_VERSION, vscode-java-debug $JAVA_DEBUG_VERSION, vscode-quarkus $VSCODE_QUARKUS_VERSION)"
  # Dev mode's first start resolves the platform from Central: warm ~/.m2 once
  # per Quarkus version, outside the editor, so the probe measures dev mode.
  QWARM="$HEAVY_CACHE/quarkus-warm-v2-$QUARKUS_VERSION"
  if [[ ! -e "$QWARM" ]]; then
    log "Warming ~/.m2 for Quarkus $QUARKUS_VERSION (mvn package on a copy of the fixture)"
    rm -rf "$HEAVY_WORK/quarkus-warm" && cp -r "$REPO/tests/heavy/fixtures/quarkus" "$HEAVY_WORK/quarkus-warm"
    mise exec java@temurin-21.0.11+10.0.LTS maven@3.9.16 -- mvn -B -q -f "$HEAVY_WORK/quarkus-warm/pom.xml" package -DskipTests >>"$HEAVY_WORK/package.log" 2>&1 \
      || { tail -30 "$HEAVY_WORK/package.log" >&2; fail "warming ~/.m2 for the quarkus fixture failed"; }
    # The catalogue reads the platform's descriptor from ~/.m2 (case 5), and
    # the Gradle fixture needs the plugin and the platform in ~/.gradle.
    mise exec java@temurin-21.0.11+10.0.LTS maven@3.9.16 -- mvn -B -q dependency:get -Dartifact="io.quarkus.platform:quarkus-bom-quarkus-platform-descriptor:$QUARKUS_VERSION:json:$QUARKUS_VERSION" >>"$HEAVY_WORK/package.log" 2>&1 \
      || { tail -30 "$HEAVY_WORK/package.log" >&2; fail "fetching the Quarkus platform descriptor failed"; }
    rm -rf "$HEAVY_WORK/quarkus-gradle-warm" && cp -r "$REPO/tests/heavy/fixtures/quarkus-gradle" "$HEAVY_WORK/quarkus-gradle-warm"
    (cd "$HEAVY_WORK/quarkus-gradle-warm" && mise exec java@temurin-21.0.11+10.0.LTS gradle@8.14.5 -- gradle --no-daemon -q quarkusBuild) >>"$HEAVY_WORK/package.log" 2>&1 \
      || { tail -30 "$HEAVY_WORK/package.log" >&2; fail "warming ~/.gradle for the quarkus-gradle fixture failed"; }
    touch "$QWARM"
  fi
  QENV_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v -E '/java|/jdk|/jvm' | paste -sd: -)"
  QSETTINGS='{ "workbench.startupEditor": "none", "java.server.launchMode": "Standard", "java.jdt.ls.vmargs": "-XX:+UseParallelGC -Xmx1G -Xms100m -Xlog:disable", "security.workspace.trust.enabled": false, "extensions.ignoreRecommendations": true, "git.openRepositoryInParentFolders": "never", "terminal.integrated.gpuAcceleration": "off", "batlehub.java.statusBar.items": { "quarkus.dev": true }, "redhat.telemetry.enabled": false }'
  quarkus_run() { # quarkus_run <label> <jsonl> <fixture> [--degraded 1 | --gradle 1]: one editor, one driver run
    local label="$1" out="$2" fixture="$3"; shift 3
    local QE="$HEAVY_WORK/editor-$label" QWS="$HEAVY_WORK/$label-ws"
    rm -rf "$QWS" && cp -r "$REPO/tests/heavy/fixtures/$fixture" "$QWS"
    EDITOR_FOLDER="$QWS"
    start_editor "$QE" "$QSETTINGS" JAVA_HOME= JDK_HOME= PATH="$QENV_PATH" JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=6"
    log "Editor ($label) at http://127.0.0.1:$EDITOR_PORT, folder $QWS"
    DUMP_ON_FAIL="$QE"; DUMP_JSONL="$out"
    node tests/heavy/quarkus.mjs --url "http://127.0.0.1:$EDITOR_PORT/?folder=$QWS" --shots "$HEAVY_WORK/shots" --cdp "$CDP_URL" --workspace "$QWS" "$@" \
      >"$out" 2>"$out.err" || { cat "$out.err" >&2; cat "$out" >&2; fail "the quarkus driver failed ($label)"; }
    stop_editor
    cat "$out" >>"$LOG"
  }
  # The Red Hat pair in dependency order: an extension's dependencies are installed before it.
  INSTALL_VSIX=("$REDHAT_VSIX" "$MP_VSIX" "$DEBUG_VSIX" "$RHQ_VSIX" "$JAVA_CORE_VSIX" "$QUARKUS_VSIX")
  quarkus_run quarkus "$HEAVY_WORK/quarkus.jsonl" quarkus
  Q_="$HEAVY_WORK/quarkus.jsonl"
  assert_json "$Q_" detect "'detected Quarkus 3.40.1 (maven, module quarkus-fixture)' in ' '.join(d['lines']) and 'wrote java.home = ' in ' '.join(d['lines'])" \
    "the satellite did not detect Quarkus 3.40.1, or did not bridge the MicroProfile server's JDK: $(field "$Q_" detect | cut -c1-900)"
  assert_json "$Q_" completion "not d['timedOut'] and any(\"Unrecognized property 'quarkus.http.nope'\" in r for r in d['problems']) and not any('quarkus.http.port' in r for r in d['problems']) and any(r.startswith('quarkus.http.') and ' = ' in r for r in d['rows'])" \
    "the MicroProfile server did not validate application.properties against the project's Quarkus keys: $(field "$Q_" completion | cut -c1-900)"
  log "QUARKUS-LS-OK (detected Quarkus 3.40.1 from the core's model; java.home — the MicroProfile server's JDK, ≥ 21 — written through the manifest for the newcomer; after the reload the server runs on it and knows the project's keys: quarkus.http.port accepted, quarkus.http.nope flagged in $(field "$Q_" completion | python3 -c 'import json,sys;print(json.load(sys.stdin)["ms"])') ms, quarkus.http. completed with $(field "$Q_" completion | python3 -c 'import json,sys;print(json.load(sys.stdin)["rows"][:2])') — RFC 0011 case 1)"
  assert_json "$Q_" dev "not d['timedOut'] and d['health']['status'] == 200 and d['started'] and d['inSum'] and ':8081' in d['status'] and 'running · pid' in d['tab'] and 'port 8081' in d['tab']" \
    "dev mode did not come up as a managed process, ready on /q/health/ready, in the sum, the status bar and the tab: $(field "$Q_" dev | cut -c1-1200)"
  log "QUARKUS-DEV-OK (Quarkus: Start dev mode → quarkus:dev through the core's managed process, 1024 MiB declared and in the sum, /q/health/ready UP on 8081 in $(field "$Q_" dev | python3 -c 'import json,sys;print(json.load(sys.stdin)["ms"])') ms, the status bar and the Quarkus tab say running — RFC 0011 case 2)"
  assert_json "$Q_" stop "any('already running (pid' in n and 'port 8081' in n for n in d['refused']) and d['portFree'] and any(l.startswith('stopping 1 (quarkus-dev) … stopped (') for l in d['console']) and ':8081' not in d['statusAfter'] and 'Dev mode: stopped' in d['tabAfter']" \
    "a second start was not refused, or Stop did not free 8081 and say so: $(field "$Q_" stop | cut -c1-1200)"
  assert_json "$Q_" debug "d['up'] and d['paused'] and any('paused on breakpoint' in r.lower() for r in d['stack']) and d['body'] == 'Hello from Quarkus' and d['portFree']" \
    "Debug dev mode did not stop on the breakpoint in GreetingResource.hello, or did not answer after Continue: $(field "$Q_" debug | cut -c1-900)"
  log "QUARKUS-DEBUG-OK (Quarkus: Debug dev mode → the same run step with debug: true, -Ddebug=5005 and the core's attach on localhost; GET /hello stopped in GreetingResource.hello, Continue answered 'Hello from Quarkus', Stop freed 8081 — RFC 0011 case 4)"
  assert_json "$Q_" extensions "d['added'] and 'quarkus-jackson' in d['tabAdded'] and d['removed'] and d['reimported'] and any('quarkus-jackson' in r for r in d['addRows'])" \
    "adding then removing quarkus-jackson from the catalogue did not change the POM, the tab and re-import each time: $(field "$Q_" extensions | cut -c1-900)"
  log "QUARKUS-EXT-OK (Add… lists the platform's catalogue from ~/.m2, quarkus:add-extension with the registry client off wrote quarkus-jackson into the POM, the core re-imported and the tab lists it; Remove… took it out again — RFC 0011 case 5)"
  log "QUARKUS-STOP-OK (a second start refused naming pid and port; Stop: q, then the group — 8081 free, the tab and the status bar say stopped — RFC 0011 case 3)"

  # Case 6: the satellite and the core alone.
  INSTALL_VSIX=("$JAVA_CORE_VSIX" "$QUARKUS_VSIX")
  quarkus_run quarkus-degraded "$HEAVY_WORK/quarkus-degraded.jsonl" quarkus --degraded 1
  QD_="$HEAVY_WORK/quarkus-degraded.jsonl"
  assert_json "$QD_" detect "any('redhat.vscode-quarkus, redhat.vscode-microprofile not installed' in n for n in d['notifications'])" \
    "without the Red Hat pair there was no warning naming both: $(field "$QD_" detect | cut -c1-900)"
  assert_json "$QD_" dev "not d['timedOut'] and d['health']['status'] == 200 and d['started']" \
    "without the Red Hat pair dev mode did not come up: $(field "$QD_" dev | cut -c1-900)"
  assert_json "$QD_" stop "d['portFree']" "without the Red Hat pair Stop did not free 8081"
  log "QUARKUS-DEGRADED-OK (no Red Hat pair: one warning naming both with Install; dev mode starts, is ready and stops unchanged — RFC 0011 case 6)"
  # Gradle: the kind's quarkusDev with the measured flag (decision 11), core and satellite only.
  quarkus_run quarkus-gradle "$HEAVY_WORK/quarkus-gradle.jsonl" quarkus-gradle --gradle 1
  QG_="$HEAVY_WORK/quarkus-gradle.jsonl"
  assert_json "$QG_" detect "'detected Quarkus 3.40.1 (gradle, module' in ' '.join(d['lines'])" \
    "the Gradle fixture was not detected as Quarkus 3.40.1 (gradle.properties): $(field "$QG_" detect | cut -c1-600)"
  assert_json "$QG_" dev "not d['timedOut'] and d['health']['status'] == 200 and d['started']" \
    "Gradle dev mode did not come up as a managed process: $(field "$QG_" dev | cut -c1-900)"
  assert_json "$QG_" stop "d['portFree']" "Gradle dev mode's Stop did not free 8081"
  log "QUARKUS-GRADLE-OK (the Gradle fixture: Quarkus 3.40.1 from gradle.properties, quarkusDev -Ddebug=false through the core's managed process, ready on /q/health/ready in $(field "$QG_" dev | python3 -c 'import json,sys;print(json.load(sys.stdin)["ms"])') ms, stopped — RFC 0011 decision 11)"
  log "QUARKUS-HALF-OK"
fi

# ---- 9. The spring half (RFC 0010 section 10) ----------------------------
if [[ "$ONLY" == "all" || "$ONLY" == "spring" ]]; then
  log "Spring half: java-spring with Spring Boot Tools, then without it - the spring-boot fixture"
  BOOT_VERSION="4.1.1"
  VMWARE_SPRING_VERSION="${VMWARE_SPRING_VERSION:-2.4.0}"
  VSCODE_MAVEN_VERSION="${VSCODE_MAVEN_VERSION:-0.45.3}"
  JAVA_DEBUG_VERSION="${JAVA_DEBUG_VERSION:-0.59.0}"
  jdt_bundle
  for p in java-core java-spring; do
    (cd "$REPO/extensions/$p" && pnpm run package >>"$HEAVY_WORK/package.log" 2>&1) || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "packaging $p failed"; }
  done
  JAVA_CORE_VSIX="$REPO/extensions/java-core/java-core.vsix"
  SPRING_VSIX="$REPO/extensions/java-spring/java-spring.vsix"
  ovsx() { # ovsx <namespace> <name> <version>: a pinned VSIX from Open VSX, cached
    local f="$HEAVY_CACHE/$1.$2-$3.vsix"
    [[ -s "$f" ]] || { log "Downloading $1.$2 $3 from Open VSX"; fetch -o "$f" "https://open-vsx.org/api/$1/$2/$3/file/$1.$2-$3.vsix"; }
    printf '%s' "$f"
  }
  REDHAT_VSIX="$(ovsx redhat java "$REDHAT_JAVA_VERSION")"
  MAVEN_EXT_VSIX="$(ovsx vscjava vscode-maven "$VSCODE_MAVEN_VERSION")"
  DEBUG_VSIX="$(ovsx vscjava vscode-java-debug "$JAVA_DEBUG_VERSION")"
  VMWARE_VSIX="$(ovsx vmware vscode-spring-boot "$VMWARE_SPRING_VERSION")"
  log "PACKAGE-OK (java-spring $(stat -c %s "$SPRING_VSIX") bytes; redhat.java $REDHAT_JAVA_VERSION, vscode-maven $VSCODE_MAVEN_VERSION, vscode-java-debug $JAVA_DEBUG_VERSION, vscode-spring-boot $VMWARE_SPRING_VERSION — the newest stable release, not a daily pre-release)"
  SWARM="$HEAVY_CACHE/spring-warm-$BOOT_VERSION"
  if [[ ! -e "$SWARM" ]]; then
    log "Warming ~/.m2 for Spring Boot $BOOT_VERSION (mvn package on a copy of the fixture)"
    rm -rf "$HEAVY_WORK/spring-warm" && cp -r "$REPO/tests/heavy/fixtures/spring-boot" "$HEAVY_WORK/spring-warm"
    mise exec java@temurin-21.0.11+10.0.LTS maven@3.9.16 -- mvn -B -q -f "$HEAVY_WORK/spring-warm/pom.xml" package -DskipTests >>"$HEAVY_WORK/package.log" 2>&1 \
      || { tail -30 "$HEAVY_WORK/package.log" >&2; fail "warming ~/.m2 for the spring-boot fixture failed"; }
    touch "$SWARM"
  fi
  SENV_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v -E '/java|/jdk|/jvm' | paste -sd: -)"
  SSETTINGS='{ "workbench.startupEditor": "none", "java.server.launchMode": "Standard", "java.jdt.ls.vmargs": "-XX:+UseParallelGC -Xmx1G -Xms100m -Xlog:disable", "security.workspace.trust.enabled": false, "extensions.ignoreRecommendations": true, "git.openRepositoryInParentFolders": "never", "terminal.integrated.gpuAcceleration": "off", "redhat.telemetry.enabled": false }'
  spring_run() { # spring_run <label> <jsonl> [--degraded 1]
    local label="$1" out="$2"; shift 2
    local SE="$HEAVY_WORK/editor-$label" SWS2="$HEAVY_WORK/$label-ws"
    rm -rf "$SWS2" && cp -r "$REPO/tests/heavy/fixtures/spring-boot" "$SWS2"
    EDITOR_FOLDER="$SWS2"
    start_editor "$SE" "$SSETTINGS" JAVA_HOME= JDK_HOME= PATH="$SENV_PATH" JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=6"
    log "Editor ($label) at http://127.0.0.1:$EDITOR_PORT, folder $SWS2"
    DUMP_ON_FAIL="$SE"; DUMP_JSONL="$out"
    node tests/heavy/spring.mjs --url "http://127.0.0.1:$EDITOR_PORT/?folder=$SWS2" --shots "$HEAVY_WORK/shots" --cdp "$CDP_URL" --workspace "$SWS2" "$@" \
      >"$out" 2>"$out.err" || { cat "$out.err" >&2; cat "$out" >&2; fail "the spring driver failed ($label)"; }
    stop_editor
    cat "$out" >>"$LOG"
  }
  # Dependencies first: vscode-spring-boot needs redhat.java and vscode-maven; running needs the debugger.
  INSTALL_VSIX=("$REDHAT_VSIX" "$MAVEN_EXT_VSIX" "$DEBUG_VSIX" "$VMWARE_VSIX" "$JAVA_CORE_VSIX" "$SPRING_VSIX")
  spring_run spring "$HEAVY_WORK/spring.jsonl"
  P_="$HEAVY_WORK/spring.jsonl"
  assert_json "$P_" detect "'detected Spring Boot 4.1.1 (maven, module spring-boot-fixture)' in ' '.join(d['lines']) and 'wrote spring-boot.ls.java.home = ' in ' '.join(d['lines'])" \
    "the satellite did not detect Spring Boot 4.1.1, or did not bridge Spring Tools' JDK: $(field "$P_" detect | cut -c1-900)"
  assert_json "$P_" hover "not d['timedOut']" "Spring Tools never documented server.port in application.yml: $(field "$P_" hover | cut -c1-600)"
  log "SPRING-LS-OK (detected Spring Boot 4.1.1 through the parent; spring-boot.ls.java.home — a JDK ≥ 21 — written through the manifest for the newcomer; after the reload Spring Tools documents server.port: '$(field "$P_" hover | python3 -c 'import json,sys;print(json.load(sys.stdin)["text"][:80])')' — RFC 0010 case 1)"
  assert_json "$P_" profiles "d['clicked'] and 'dev' in (d['settings'] or '') and 'activeProfiles' in (d['settings'] or '') and 'Maven profiles' in d['after'] and 'dev 8081' in d['after']" \
    "ticking dev in the Spring tab did not write batlehub.java.spring.activeProfiles, or the tab does not show both profile systems: $(field "$P_" profiles | cut -c1-900)"
  assert_json "$P_" template "not d['timedOut'] and '-Dspring.profiles.active=dev' in d['launch'] and '\"template\": \"spring-boot\"' in d['launch'] and 'com.acme.demo.DemoApplication' in d['launch']" \
    "the Spring Boot application template did not write the entry with the dev profile: $(field "$P_" template | cut -c1-900)"
  assert_json "$P_" run "not d['timedOut'] and d['health']['status'] == 200 and d['activeProfiles'] == ['dev'] and d['stopped']" \
    "the Spring Boot entry did not start on the dev port, or did not stop: $(field "$P_" run | cut -c1-900)"
  assert_json "$P_" devtools "'UP' in d['row1'] and d['restarted'] and d['hello'] == 'Hello after a restart' and d['rowRestarted'] and d['restartReason'] and d['stopFromTab'] and d['stopped']" \
    "a saved edit did not restart the app through devtools, the row did not show it, or the tab's Stop did not end it: $(field "$P_" devtools | cut -c1-900)"
  log "SPRING-DEVTOOLS-OK (the row for localhost:8081 (started by the editor); a saved HelloController restarted the context through devtools — /hello answered the new string, the row's uptime reset and says restarted 1×, the JVM's process.uptime did not; Restart disabled with its reason — Boot 4 has no restart endpoint; the tab's Stop ended it — RFC 0010 case 4)"
  assert_json "$P_" dashboard "d['up'] and 'UP' in d['row'] and d['rowAfterMs'] <= 15000 and d['stopDisabled'] and d['opened'] and d['appStopped'] and 0 <= d['rowGoneMs'] <= 15000" \
    "the dashboard did not see the spring-boot:run instance, open it, or drop it after Ctrl+C: $(field "$P_" dashboard | cut -c1-900)"
  log "SPRING-DASH-OK (spring-boot:run as a batlehub-java task: its row appeared $(field "$P_" dashboard | python3 -c 'import json,sys;print(json.load(sys.stdin)["rowAfterMs"])') ms after it answered, Stop disabled — started outside the editor —, Open showed localhost:8080 in the simple browser; Ctrl+C, and the row went $(field "$P_" dashboard | python3 -c 'import json,sys;print(json.load(sys.stdin)["rowGoneMs"])') ms later — RFC 0010 case 3)"
  assert_json "$P_" accept "not d['timedOut'] and any(l.startswith('step 1 ready (http http://localhost:8081/actuator/health in') for l in d['console']) and 'step 2 exited 0' in d['console'] and 'stopping 2 (node) … already done' in d['console'] and any(l.startswith('stopping 1 (spring-boot) … stopped (term)') for l in d['console']) and d['portFree']" \
    "the acceptance run did not go app ready on /actuator/health → client exited 0 → reverse stop: $(field "$P_" accept | cut -c1-1200)"
  log "SPRING-ACCEPT-OK (a batlehub-run: step 1 the spring-boot kind — spring-boot:run with the dev profile through the core's managed process, ready on /actuator/health —, step 2 a client that GETs /hello and exits 0, then stopping 2 already done, 1 stopped by SIGTERM: $(field "$P_" accept | python3 -c 'import json,sys;d=json.load(sys.stdin);print(next((l for l in d["console"] if l.startswith("stopping 1")), "")[:90])'); graceful shutdown in its terminal: $(field "$P_" accept | python3 -c 'import json,sys;print(json.load(sys.stdin)["graceful"])') — RFC 0010 case 6)"
  log "SPRING-RUN-OK (dev ticked in the Spring tab → batlehub.java.spring.activeProfiles; Java: New run configuration → Spring Boot application wrote mainClass com.acme.demo.DemoApplication with -Dspring.profiles.active=dev; F5: /actuator/health UP on 8081, the dev document's port, in $(field "$P_" run | python3 -c 'import json,sys;print(json.load(sys.stdin)["ms"])') ms, /actuator/env says activeProfiles [dev] — RFC 0010 case 2)"

  # Case 5: the satellite and the core alone.
  INSTALL_VSIX=("$JAVA_CORE_VSIX" "$SPRING_VSIX")
  spring_run spring-degraded "$HEAVY_WORK/spring-degraded.jsonl" --degraded 1
  PD_="$HEAVY_WORK/spring-degraded.jsonl"
  assert_json "$PD_" detect "any('need Spring Boot Tools (vmware.vscode-spring-boot)' in n for n in d['notifications']) and 'wrote spring-boot.ls.java.home' not in ' '.join(d['lines'])" \
    "without Spring Boot Tools there was no warning naming it, or the bridge wrote anyway: $(field "$PD_" detect | cut -c1-900)"
  assert_json "$PD_" profiles "d['clicked'] and 'dev' in (d['settings'] or '')" "without Spring Boot Tools the Spring tab's profiles did not work"
  assert_json "$PD_" template "not d['timedOut'] and '-Dspring.profiles.active=dev' in d['launch']" "without Spring Boot Tools the template did not work"
  log "SPRING-DEGRADED-OK (no Spring Boot Tools: one warning naming it, nothing bridged; the tab's profiles and the template work unchanged — RFC 0010 case 5)"
  log "SPRING-HALF-OK"
fi

# ---- 10. The sonar half (RFC 0016 phase 1) --------------------------------
if [[ "$ONLY" == "all" || "$ONLY" == "sonar" ]]; then
  log "Sonar half: SonarLint bridged into the Inspections view, then absent - the maven-multi fixture plus a TODO"
  SONARLINT_VERSION="${SONARLINT_VERSION:-5.9.0}"
  jdt_bundle
  (cd "$REPO/extensions/java-core" && pnpm run package >>"$HEAVY_WORK/package.log" 2>&1) || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "packaging java-core failed"; }
  JAVA_CORE_VSIX="$REPO/extensions/java-core/java-core.vsix"
  [[ "$(unzip -l "$JAVA_CORE_VSIX" | grep -c "jdt/batlehub-jdt-core.jar")" -gt 0 ]] || fail "java-core.vsix does not carry the JDT bundle"
  REDHAT_VSIX="$HEAVY_CACHE/redhat.java-$REDHAT_JAVA_VERSION.vsix"
  [[ -s "$REDHAT_VSIX" ]] || fetch -o "$REDHAT_VSIX" "https://open-vsx.org/api/redhat/java/$REDHAT_JAVA_VERSION/file/redhat.java-$REDHAT_JAVA_VERSION.vsix"
  # The linux-x64 build, as Open VSX serves a Che pod: it carries its own JRE (RFC 0016 decision 13).
  SONAR_VSIX="$HEAVY_CACHE/SonarSource.sonarlint-vscode-$SONARLINT_VERSION@linux-x64.vsix"
  [[ -s "$SONAR_VSIX" ]] || { log "Downloading SonarLint $SONARLINT_VERSION (linux-x64) from Open VSX"; fetch -o "$SONAR_VSIX" "https://open-vsx.org/api/SonarSource/sonarlint-vscode/linux-x64/$SONARLINT_VERSION/file/SonarSource.sonarlint-vscode-$SONARLINT_VERSION@linux-x64.vsix"; }
  log "PACKAGE-OK (java-core; redhat.java $REDHAT_JAVA_VERSION, SonarLint $SONARLINT_VERSION linux-x64)"
  OENV_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v -E '/java|/jdk|/jvm' | paste -sd: -)"
  OSETTINGS='{ "workbench.startupEditor": "none", "java.server.launchMode": "Standard", "java.jdt.ls.vmargs": "-XX:+UseParallelGC -Xmx1G -Xms100m -Xlog:disable", "security.workspace.trust.enabled": false, "extensions.ignoreRecommendations": true, "redhat.telemetry.enabled": false, "sonarlint.disableTelemetry": true }'
  sonar_run() { # sonar_run <label> <jsonl> [--absent 1]
    local label="$1" out="$2"; shift 2
    local OE="$HEAVY_WORK/editor-$label" OWS="$HEAVY_WORK/$label-ws"
    rm -rf "$OWS" && cp -r "$REPO/tests/heavy/fixtures/maven-multi" "$OWS"
    # One Sonar-only finding, in the copy: Greeter.java is held by two golden files.
    printf 'package com.acme.core;\n\npublic class Todo {\n    // TODO finish this\n    public int answer() {\n        return 42;\n    }\n}\n' >"$OWS/core/src/main/java/com/acme/core/Todo.java"
    EDITOR_FOLDER="$OWS"
    start_editor "$OE" "$OSETTINGS" JAVA_HOME= JDK_HOME= PATH="$OENV_PATH" JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=6"
    log "Editor ($label) at http://127.0.0.1:$EDITOR_PORT, folder $OWS"
    DUMP_ON_FAIL="$OE"; DUMP_JSONL="$out"
    node tests/heavy/sonar.mjs --url "http://127.0.0.1:$EDITOR_PORT/?folder=$OWS" --shots "$HEAVY_WORK/shots" --cdp "$CDP_URL" --workspace "$OWS" "$@" \
      >"$out" 2>"$out.err" || { cat "$out.err" >&2; cat "$out" >&2; fail "the sonar driver failed ($label)"; }
    stop_editor
    cat "$out" >>"$LOG"
  }
  INSTALL_VSIX=("$REDHAT_VSIX" "$JAVA_CORE_VSIX" "$SONAR_VSIX")
  sonar_run sonar "$HEAVY_WORK/sonar.jsonl"
  O_="$HEAVY_WORK/sonar.jsonl"
  assert_json "$O_" view "not d['timedOut'] and any(r.startswith('sonar/java:S1135') and 'via SonarLint $SONARLINT_VERSION' in r for r in d['rows']) and any(r.startswith('collections/sizeIsZero') for r in d['rows']) and not any('batlehub' in p and 'S1135' in p for p in d['problems'])" \
    "SonarLint's findings did not join the Inspections view beside the bundle's, or the core re-emitted one: $(field "$O_" view | cut -c1-1200)"
  log "SONAR-VIEW-OK (one view, two sources: the bundle's rules and sonar/java:S1135 via SonarLint $SONARLINT_VERSION — read from its diagnostics, nothing re-emitted, no Fix all on it — RFC 0016 case 2)"
  assert_json "$O_" resources "'SonarLint language server (estimated): 768 MiB' in d['tail']" \
    "SonarLint's language server is not in the resource sum as an estimate: $(field "$O_" resources | cut -c1-700)"
  log "SONAR-MEM-OK (the SonarLint language server counted in the container's sum: 768 MiB, estimated — the core does not start it, so it declares it — RFC 0016 case 4)"
  INSTALL_VSIX=("$REDHAT_VSIX" "$JAVA_CORE_VSIX")
  sonar_run sonar-absent "$HEAVY_WORK/sonar-absent.jsonl" --absent 1
  OA_="$HEAVY_WORK/sonar-absent.jsonl"
  assert_json "$OA_" view "not d['timedOut'] and any('SonarLint is not installed' in r for r in d['rows']) and 'SonarLint language server' not in ' '.join(d['rows'])" \
    "without SonarLint the view did not say where breadth comes from: $(field "$OA_" view | cut -c1-900)"
  assert_json "$OA_" resources "'SonarLint language server' not in d['tail']" "without SonarLint its server was still counted: $(field "$OA_" resources | cut -c1-600)"
  log "SONAR-ABSENT-OK (no SonarLint: one row, SonarLint is not installed — breadth comes from it, with Install; nothing counted — RFC 0016 case 3)"
  log "SONAR-HALF-OK"
fi

log "ALL-OK — screenshots in $HEAVY_WORK/shots, logs in $HEAVY_WORK"

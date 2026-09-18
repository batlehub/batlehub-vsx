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
#                chain on the completion shortcut, its cost and its Undo;
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
# HEAVY_ONLY=marketplace|broker|java|registry, REDHAT_JAVA_VERSION (1.56.0, decision 8).
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
NEED_HUB=1; [[ "$ONLY" == "java" ]] && NEED_HUB=0
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
  JDT_JAR="$REPO/extensions/java-core/jdt/batlehub-jdt-core.jar"
  [[ -s "$JDT_JAR" ]] || { log "Building the JDT bundle (task jdt:deps, jdt:build)"; (cd "$REPO" && task jdt:deps >>"$HEAVY_WORK/package.log" 2>&1 && task jdt:build >>"$HEAVY_WORK/package.log" 2>&1) || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "the JDT bundle build failed"; }; }
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
  log "PACKAGE-OK (java-core $(stat -c %s "$JAVA_CORE_VSIX") bytes with the bundle, java-groovy $(stat -c %s "$JAVA_GROOVY_VSIX") bytes, redhat.java $REDHAT_JAVA_VERSION)"
  J="$HEAVY_WORK/editor-java"
  JWS="$HEAVY_WORK/java-ws"
  rm -rf "$JWS" && cp -r "$REPO/tests/heavy/fixtures/maven-multi" "$JWS"
  # The Groovy files of the groovy fixture, beside the Maven build: the
  # server compiles by folder, Maven is irrelevant to it.
  mkdir -p "$JWS/src/main/groovy/com/acme" && cp "$REPO/tests/heavy/fixtures/groovy-project/src/main/groovy/com/acme/Hello.groovy" "$JWS/src/main/groovy/com/acme/" && cp "$REPO/tests/heavy/fixtures/groovy-project/Jenkinsfile" "$JWS/"
  # The newcomer's environment (§2 point 1): no JAVA_HOME, no JDK on PATH —
  # only a manager. `mise` stays reachable; its `java` shim answers nothing
  # without a global version, which is what a fresh Che workspace has.
  JAVA_ENV_PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v -E '/java|/jdk|/jvm' | paste -sd: -)"
  INSTALL_VSIX=("$REDHAT_VSIX" "$JAVA_CORE_VSIX" "$JAVA_GROOVY_VSIX")
  EDITOR_FOLDER="$JWS"
  T_START=$SECONDS
  # The suite lives inside the container's memory budget (§2 point 7 is not
  # theory: a 16 GiB tools container with rust-analyzer in it killed this
  # run twice): JDT.LS at 1 GiB, every other JVM the editor spawns (the
  # Groovy server) at 6% of the container through JAVA_TOOL_OPTIONS.
  start_editor "$J" '{ "workbench.startupEditor": "none", "java.server.launchMode": "Standard", "java.jdt.ls.vmargs": "-XX:+UseParallelGC -XX:GCTimeRatio=4 -XX:AdaptiveSizePolicyWeight=90 -Dsun.zip.disableMemoryMapping=true -Xmx1G -Xms100m -Xlog:disable", "batlehub.java.log.level": "debug", "security.workspace.trust.enabled": false, "extensions.ignoreRecommendations": true, "git.openRepositoryInParentFolders": "never", "terminal.integrated.gpuAcceleration": "off" }' \
    JAVA_HOME= JDK_HOME= PATH="$JAVA_ENV_PATH" JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=6"
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
  node tests/heavy/java.mjs --url "http://127.0.0.1:$EDITOR_PORT/?folder=$JWS" --shots "$HEAVY_WORK/shots" --cdp "$CDP_URL" \
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
  assert_json "$J_" explorer "any('JDK JavaSE-21' in r for r in d['rows']) and any(r.startswith('maven-multi') for r in d['rows'])" \
    "the Projects explorer does not show the JDK and the module: $(field "$J_" explorer | cut -c1-300)"
  log "EXPLORER-OK (folder → JDK → modules)"
  assert_json "$J_" tasks "any('maven compile' in r or 'maven package' in r for r in d['rows']) and d['ran']" \
    "Tasks: Run Task does not list the batlehub-java Maven goals, or 'maven compile' did not end in BUILD SUCCESS: $(field "$J_" tasks | cut -c1-400)"
  log "TASKS-OK (the batlehub-java provider's goals in the editor's own task picker; 'maven compile' ran to BUILD SUCCESS in the terminal with the resolved JDK)"
  assert_json "$J_" inspections "any('batlehub' in r for r in d['problems']) and d['fixedIsEmpty']" \
    "the bundle's inspections did not reach the Problems panel or Fix all did not rewrite size()==0: $(field "$J_" inspections | cut -c1-400)"
  log "INSPECTIONS-OK (batlehub diagnostics on Greeter.java; Fix all in file rewrote size() == 0 to isEmpty())"
  assert_json "$J_" generate "d['generated']" "Java: Getters and setters… did not write the accessors into Person.java: $(field "$J_" generate | cut -c1-300)"
  log "GENERATE-OK (the Generate menu wrote getters and setters through the bundle's delegate)"
  assert_json "$J_" groovy "d['registered'] and d['started'] and 'Groovy' in d['languageMode'] and d['statusItemHidden'] and d['statusItemShownAfterToggle']" \
    "the Groovy satellite did not register and start, or Hello.groovy did not open as Groovy: $(field "$J_" groovy | cut -c1-400)"
  log "GROOVY-OK (java-groovy registered through the contract, the server started on the core's JDK, Hello.groovy in Groovy mode; hover: '$(field "$J_" groovy | python3 -c 'import json,sys;print(json.load(sys.stdin)["hover"][:80])')'; its status bar item hidden by default and shown once batlehub.java.statusBar.items toggles it)"
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
  log "CHAIN-RANK $(field "$J_" chain | python3 -c 'import json,sys;d=json.load(sys.stdin);print("rank", d["chainRank"], "of", d.get("rankedCount"), "after typing con; the server sorts every chain last (sortText 999999979) —", d["rankedItems"][:4])')"
  assert_json "$J_" remove "any(c.startswith('Restore') for c in d['clicked']) and (d['settings'] is None or 'java.configuration.runtimes' not in d['settings'])" \
    "Remove BatleHub settings did not restore java.configuration.runtimes"
  log "REMOVE-OK (the manifest replayed: java.configuration.runtimes and java.jdt.ls.java.home restored, the dialog listed what it would do)"
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
# feature is a delta in the log rather than a feeling.
gates = {"statusBarMs": 10000, "detectionMs": 3000, "readyMs": 60000, "activationMs": 5000, "chainMs": 800}
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

log "ALL-OK — screenshots in $HEAVY_WORK/shots, logs in $HEAVY_WORK"

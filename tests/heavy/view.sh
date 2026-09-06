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
# HEAVY_ONLY=marketplace|broker.
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
fail() { log "FAIL: $*"; exit 1; }
fetch() { curl -fsSL --proto '=https' --proto-redir '=https' "$@"; }

PIDS=()
PRODUCT_JSON=""
PRODUCT_BACKUP=""
cleanup() {
  for p in "${PIDS[@]:-}"; do [[ -n "$p" ]] && { kill -- -"$p" 2>/dev/null || kill "$p" 2>/dev/null || true; }; done
  if [[ -n "$PRODUCT_BACKUP" && -f "$PRODUCT_BACKUP" ]]; then cp "$PRODUCT_BACKUP" "$PRODUCT_JSON"; fi
}
trap cleanup EXIT

[[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is required (the Postgres sidecar: postgresql://batlehub:changeme@127.0.0.1:5432/batlehub)"
command -v node >/dev/null || fail "node is required"
command -v python3 >/dev/null || fail "python3 is required"
curl -sf "$CDP_URL/json/version" >/dev/null || fail "no browser at $CDP_URL — Chrome is parked in the sidecar: run 'task browser:start' (CDP_URL points elsewhere)"
[[ -d "$REPO/extensions/batlehub-vsx/node_modules/puppeteer-core" ]] || fail "puppeteer-core is missing — run 'pnpm install' first"

# ── 0. The server and CLI binaries ───────────────────────────────────────
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

# ── 1. The extension package ─────────────────────────────────────────────
log "Packaging the extension"
(cd "$REPO/extensions/batlehub-vsx" && pnpm run package >"$HEAVY_WORK/package.log" 2>&1) \
  || { tail -20 "$HEAVY_WORK/package.log" >&2; fail "packaging failed"; }
VSIX="$REPO/extensions/batlehub-vsx/batlehub-vsx.vsix"
[[ -s "$VSIX" ]] || fail "no $VSIX"
EXT_VERSION="$(python3 -c 'import json;print(json.load(open("extensions/batlehub-vsx/package.json"))["version"])')"
log "PACKAGE-OK ($(stat -c %s "$VSIX") bytes, batlehub.batlehub-vsx $EXT_VERSION)"

# ── 2. The BatleHub of this run ──────────────────────────────────────────
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
start_editor() {
  # start_editor <data-dir> <settings-json> [ENV=VALUE …]
  local data="$1" settings="$2"; shift 2
  mkdir -p "$data/server/data/Machine" "$data/user" "$data/extensions"
  printf '%s\n' "$settings" >"$data/server/data/Machine/settings.json"
  local code=("$CODE_SERVER" --server-data-dir "$data/server" --user-data-dir "$data/user" --extensions-dir "$data/extensions")
  env -u VSCODE_IPC_HOOK_CLI "$@" "${code[@]}" --install-extension "$VSIX" >"$data/install.txt" 2>&1 \
    || { cat "$data/install.txt" >&2; fail "installing $VSIX into the editor failed"; }
  grep -qi "successfully installed" "$data/install.txt" || { cat "$data/install.txt" >&2; fail "the editor did not report the extension installed"; }
  if (exec 3<>"/dev/tcp/127.0.0.1/$EDITOR_PORT") 2>/dev/null; then fail "port $EDITOR_PORT is taken (HEAVY_EDITOR_PORT picks another)"; fi
  env -u VSCODE_IPC_HOOK_CLI "$@" setsid "${code[@]}" --host 127.0.0.1 --port "$EDITOR_PORT" --without-connection-token \
    --accept-server-license-terms >"$data/editor.log" 2>&1 &
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

log "ALL-OK — screenshots in $HEAVY_WORK/shots, logs in $HEAVY_WORK"

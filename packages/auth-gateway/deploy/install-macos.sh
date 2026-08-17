#!/usr/bin/env bash
#
# Register the two macOS launchd services for a dsh web deployment behind the
# passkey gateway: dsh web (127.0.0.1:3080) and the auth gateway (127.0.0.1:3090
# -> dsh). Idempotent — safe to re-run; it bootout/rebootstraps in place.
#
# It does NOT touch nginx or frpc (those are `brew services` and manage their
# own plists). Wire your public entry (nginx -> gateway:3090) separately.
#
# Every knob has a default matching the mac.tokencv.com deployment; override any
# by exporting it before running, e.g.:
#   DSH_GW_RP_ID=ds.example.com DSH_TRUSTED_HOST=ds.example.com ./install-macos.sh
#
set -euo pipefail

# ---- resolve paths (works wherever the repo is cloned) ----
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
GW_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"          # packages/auth-gateway
SERVER_JS="$GW_DIR/server.js"
[ -f "$SERVER_JS" ] || { echo "error: $SERVER_JS not found" >&2; exit 1; }

# ---- binaries (override with DSH_BIN / NODE_BIN) ----
DSH_BIN="${DSH_BIN:-$(command -v dsh || true)}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -x "$DSH_BIN" ]  || { echo "error: dsh not found on PATH (set DSH_BIN=...)"  >&2; exit 1; }
[ -x "$NODE_BIN" ] || { echo "error: node not found on PATH (set NODE_BIN=...)" >&2; exit 1; }

# ---- dsh web config ----
DSH_PROFILE="${DSH_PROFILE:-web}"
DSH_HOST="${DSH_HOST:-127.0.0.1}"
DSH_PORT="${DSH_PORT:-3080}"
DSH_TRUSTED_HOST="${DSH_TRUSTED_HOST:-mac.tokencv.com}"
DSH_WORKDIR="${DSH_WORKDIR:-$HOME}"

# ---- gateway config (server.js reads these from the environment) ----
DSH_GW_HOST="${DSH_GW_HOST:-127.0.0.1}"
DSH_GW_PORT="${DSH_GW_PORT:-3090}"
DSH_GW_TARGET="${DSH_GW_TARGET:-http://127.0.0.1:$DSH_PORT}"
DSH_GW_RP_ID="${DSH_GW_RP_ID:-mac.tokencv.com}"
DSH_GW_STATE_DIR="${DSH_GW_STATE_DIR:-$HOME/.dsh-gateway/state}"

# ---- launchd domain + labels ----
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
AGENTS="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs"
WEB_LABEL="com.tokencv.dsh-web"
GW_LABEL="com.tokencv.dsh-gateway"
WEB_PLIST="$AGENTS/$WEB_LABEL.plist"
GW_PLIST="$AGENTS/$GW_LABEL.plist"

PATH_ENV="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$AGENTS" "$LOG_DIR" "$DSH_GW_STATE_DIR"

# ---- ensure the gateway's own deps are installed (it is outside the pnpm workspace) ----
if [ ! -d "$GW_DIR/node_modules" ]; then
  echo "· installing gateway dependencies (npm ci)…"
  ( cd "$GW_DIR" && npm ci --omit=dev )
fi

# ---- plist writer: label, plist, workdir, logpath, env-KEY=VAL-lines, then argv ----
write_plist() {
  local label="$1" plist="$2" workdir="$3" logpath="$4" envpairs="$5"; shift 5
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0">'
    echo '<dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo '  <key>ProgramArguments</key>'
    echo '  <array>'
    for a in "$@"; do echo "    <string>$a</string>"; done
    echo '  </array>'
    echo "  <key>WorkingDirectory</key><string>$workdir</string>"
    echo '  <key>RunAtLoad</key><true/>'
    echo '  <key>KeepAlive</key><true/>'
    echo "  <key>StandardOutPath</key><string>$logpath</string>"
    echo "  <key>StandardErrorPath</key><string>$logpath</string>"
    echo '  <key>EnvironmentVariables</key>'
    echo '  <dict>'
    echo "    <key>PATH</key><string>$PATH_ENV</string>"
    echo "    <key>HOME</key><string>$HOME</string>"
    while IFS='=' read -r k v; do
      [ -n "$k" ] && echo "    <key>$k</key><string>$v</string>"
    done <<< "$envpairs"
    echo '  </dict>'
    echo '</dict>'
    echo '</plist>'
  } > "$plist"
}

# ---- (re)register one service ----
register() {
  local label="$1" plist="$2"
  # bootout first so a re-run reloads the new plist rather than erroring on a
  # duplicate; ignore the error when it was not loaded.
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  # bootout is asynchronous: bootstrapping before it finishes fails with
  # "5: Input/output error". Wait until the label is really gone.
  local i
  for i in $(seq 1 50); do
    launchctl print "$DOMAIN/$label" >/dev/null 2>&1 || break
    sleep 0.1
  done
  launchctl bootstrap "$DOMAIN" "$plist"
  launchctl enable "$DOMAIN/$label" 2>/dev/null || true
  launchctl kickstart -k "$DOMAIN/$label"
}

echo "· writing $WEB_PLIST"
write_plist "$WEB_LABEL" "$WEB_PLIST" "$DSH_WORKDIR" "$LOG_DIR/dsh-web.log" "" \
  "$DSH_BIN" --profile "$DSH_PROFILE" --host "$DSH_HOST" --port "$DSH_PORT" --trusted-host "$DSH_TRUSTED_HOST"

echo "· writing $GW_PLIST"
write_plist "$GW_LABEL" "$GW_PLIST" "$GW_DIR" "$LOG_DIR/dsh-gateway.log" \
"DSH_GW_HOST=$DSH_GW_HOST
DSH_GW_PORT=$DSH_GW_PORT
DSH_GW_TARGET=$DSH_GW_TARGET
DSH_GW_RP_ID=$DSH_GW_RP_ID
DSH_GW_STATE_DIR=$DSH_GW_STATE_DIR" \
  "$NODE_BIN" "$SERVER_JS"

echo "· registering dsh web"; register "$WEB_LABEL" "$WEB_PLIST"
echo "· registering gateway"; register "$GW_LABEL" "$GW_PLIST"

echo
echo "done. status:"
for label in "$WEB_LABEL" "$GW_LABEL"; do
  state="$(launchctl print "$DOMAIN/$label" 2>/dev/null | awk -F'= ' '/^[[:space:]]*state = /{print $2; exit}')"
  printf "  %-26s %s\n" "$label" "${state:-not registered}"
done
cat <<EOF

  dsh web : http://$DSH_HOST:$DSH_PORT   (profile=$DSH_PROFILE, trusted-host=$DSH_TRUSTED_HOST)
  gateway : http://$DSH_GW_HOST:$DSH_GW_PORT  ->  $DSH_GW_TARGET   (RP=$DSH_GW_RP_ID)
  logs    : $LOG_DIR/dsh-web.log , $LOG_DIR/dsh-gateway.log
  state   : $DSH_GW_STATE_DIR

  Point your public entry (nginx/frp) at the gateway ($DSH_GW_HOST:$DSH_GW_PORT), not dsh.
  Approve a passkey with:  dsh-approve list  /  dsh-approve approve <label>
EOF

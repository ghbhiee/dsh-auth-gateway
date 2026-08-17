#!/usr/bin/env bash
#
# Unregister the dsh web + gateway launchd services. Leaves the gateway state
# (registered passkeys, sessions) in place by default — pass --purge to also
# delete ~/.dsh-gateway/state. Does not touch nginx or frpc.
#
set -euo pipefail

UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
AGENTS="$HOME/Library/LaunchAgents"
STATE_DIR="${DSH_GW_STATE_DIR:-$HOME/.dsh-gateway/state}"

for label in com.tokencv.dsh-web com.tokencv.dsh-gateway; do
  echo "· stopping $label"
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  rm -f "$AGENTS/$label.plist"
done

if [ "${1:-}" = "--purge" ]; then
  echo "· purging state $STATE_DIR (passkeys + sessions)"
  rm -rf "$STATE_DIR"
else
  echo "· kept state $STATE_DIR (pass --purge to remove passkeys/sessions)"
fi
echo "done."

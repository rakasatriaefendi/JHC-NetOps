#!/usr/bin/env bash
set -euo pipefail

REL="${1:?usage: provision-traffic-capture.sh <release-dir>}"
BIN="$REL/agent/.venv/bin"

if [[ ! -x "$BIN/python" || ! -x "$BIN/network-monitor" ]]; then
  echo "agent venv is not ready: $BIN" >&2
  exit 1
fi

REAL_PY="$(readlink -f "$BIN/python")"
CAP_PY="$BIN/python-netraw"
ORIGINAL="$BIN/network-monitor-unprivileged"
WRAPPER="$BIN/network-monitor"

AGENT_USER="$(stat -c '%U' "$BIN/python")"
AGENT_GROUP="$(stat -c '%G' "$BIN/python")"

echo "Provisioning Traffic Live capability"
echo "release: $REL"
echo "python : $REAL_PY"

install -o root -g "$AGENT_GROUP" -m 0750 "$REAL_PY" "$CAP_PY"
setcap cap_net_raw+ep "$CAP_PY"

if [[ ! -e "$ORIGINAL" ]]; then
  cp "$WRAPPER" "$ORIGINAL"
fi

chown "$AGENT_USER:$AGENT_GROUP" "$ORIGINAL"
chmod 0755 "$ORIGINAL"

cat > "$WRAPPER" <<'SH'
#!/bin/sh

BIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "${1:-}" = "traffic-live" ]; then
  exec "$BIN_DIR/python-netraw" -m network_monitoring_agent.main "$@"
fi

exec "$BIN_DIR/network-monitor-unprivileged" "$@"
SH

chown "$AGENT_USER:$AGENT_GROUP" "$WRAPPER"
chmod 0755 "$WRAPPER"

getcap "$CAP_PY"
echo "Traffic capture provisioning complete."

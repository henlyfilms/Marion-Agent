#!/usr/bin/env bash
set -euo pipefail

# The relay reaches this listener over docker exec. No host port is published.
Xtigervnc :0 -geometry 1280x800 -depth 24 -localhost yes -SecurityTypes None -nolisten tcp &
vnc_pid=$!
cleanup() {
  kill "$vnc_pid" 2>/dev/null || true
  wait "$vnc_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
for _ in {1..50}; do
  if xdotool getdisplaygeometry >/dev/null 2>&1; then
    dbus-run-session -- startxfce4 &
    wait "$vnc_pid"
    exit
  fi
  sleep 0.2
done
echo "Desktop display failed to start" >&2
exit 1

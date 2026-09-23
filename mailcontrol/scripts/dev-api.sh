#!/usr/bin/env bash
# Starts/stops the built API and workers against the project-local demo PostgreSQL (development only).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .local/preview.env; set +a
unset DATABASE_URL
export PORT="${PORT:-5173}" MAILCONTROL_DATA_DIR="${MAILCONTROL_DATA_DIR:-$PWD/.local/data}"
mkdir -p .local/run
stop_pid() { if [ -f "$1" ]; then kill "$(cat "$1")" 2>/dev/null || true; rm -f "$1"; fi; }
case "${1:-start}" in
  start)
    stop_pid .local/run/api.pid
    setsid nohup node dist/server/main.js > .local/api.log 2>&1 < /dev/null &
    echo $! > .local/run/api.pid
    sleep 3; tail -n 3 .local/api.log ;;
  worker)
    name="${2:-1}"
    stop_pid ".local/run/worker-$name.pid"
    setsid nohup node dist/server/worker.js > ".local/worker-$name.log" 2>&1 < /dev/null &
    echo $! > ".local/run/worker-$name.pid"
    sleep 2; tail -n 2 ".local/worker-$name.log" ;;
  stop)
    for pid in .local/run/*.pid; do [ -f "$pid" ] && stop_pid "$pid"; done ;;
esac

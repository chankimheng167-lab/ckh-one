#!/usr/bin/env bash
# Starts or stops the built API for the desktop end-to-end run (CI, Linux).
# Uses DATABASE_URL, JWT_SECRET, CORS_ORIGINS, POS_LICENSE_PRIVATE_KEY and PORT from the environment.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
pidfile="${TMPDIR:-/tmp}/ckh-e2e-api.pid"
case "${1:-}" in
  start)
    nohup node "$root/apps/api/dist/main.js" >> "${TMPDIR:-/tmp}/ckh-e2e-api.log" 2>&1 &
    echo $! > "$pidfile"
    for _ in $(seq 1 60); do
      curl -sf "http://localhost:${PORT:-3001}/api/v1/health" > /dev/null && exit 0
      sleep 1
    done
    echo "API did not start"; tail -50 "${TMPDIR:-/tmp}/ckh-e2e-api.log"; exit 1 ;;
  stop)
    [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2> /dev/null || true
    for _ in $(seq 1 20); do curl -sf "http://localhost:${PORT:-3001}/api/v1/health" > /dev/null || exit 0; sleep 0.5; done
    echo "API did not stop"; exit 1 ;;
  *) echo "usage: api.sh start|stop"; exit 2 ;;
esac

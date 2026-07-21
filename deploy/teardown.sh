#!/usr/bin/env bash
# Stops everything deploy/run-ephemeral-demo.sh started: the tunnel process, the prod compose
# stack (containers + its network), and removes the per-run generated files. Keeps the
# postgres volume by default (pgdata_prod) so re-running the demo doesn't require reseeding —
# pass --wipe-data to also drop it.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f /tmp/cloudflared-demo.pid ]; then
  PID="$(cat /tmp/cloudflared-demo.pid)"
  if kill -0 "$PID" 2>/dev/null; then
    echo "stopping cloudflared tunnel (pid $PID)..."
    kill "$PID" 2>/dev/null || true
  fi
  rm -f /tmp/cloudflared-demo.pid /tmp/cloudflared-demo.log
fi

echo "stopping prod stack..."
if [ "${1:-}" = "--wipe-data" ]; then
  docker compose -f docker-compose.prod.yml --env-file .env.deploy down -v
else
  docker compose -f docker-compose.prod.yml --env-file .env.deploy down
fi

rm -f .env.deploy keycloak/realm-export.deploy.json

echo "done — nothing from the demo should still be running. Verify with:"
echo "  docker ps"
echo "  lsof -i:8000"

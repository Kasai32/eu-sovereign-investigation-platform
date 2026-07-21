#!/usr/bin/env bash
# One-off pilot-demo deployment (Phase 5 / PRD v1.1 B7): brings up the full stack behind a
# Cloudflare quick tunnel so it's reachable from the public internet, for exactly as long as
# this script's terminal session is open. See deploy/README.md for what this is (and isn't) a
# stand-in for, and deploy/teardown.sh to tear it all back down.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env.deploy"
COMPOSE_FILE="docker-compose.prod.yml"
export COMPOSE_FILE
CLOUDFLARED="${CLOUDFLARED_BIN:-cloudflared}"

if ! command -v "$CLOUDFLARED" >/dev/null 2>&1; then
  echo "cloudflared not found. Install it first (see deploy/README.md) or set CLOUDFLARED_BIN to its path." >&2
  exit 1
fi

# Fresh secrets every run: this is a one-off session, not a persistent environment, so there's
# no reason to keep a password around after teardown. Real credentials, gitignored, never in
# source control — 005_roles_and_rls.sql's dev placeholders are explicitly NOT used here.
echo "generating secrets into $ENV_FILE..."
cat > "$ENV_FILE" <<EOF
POSTGRES_SUPERUSER_PASSWORD=$(openssl rand -base64 24)
APP_USER_PASSWORD=$(openssl rand -base64 24)
KEYCLOAK_ADMIN_PASSWORD=$(openssl rand -base64 24)
EOF

echo "starting postgres..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d postgres

echo "waiting for postgres..."
until docker exec platform_postgres_prod pg_isready -U postgres -d platform >/dev/null 2>&1; do sleep 1; done

echo "applying migrations..."
APP_USER_PASSWORD="$(grep APP_USER_PASSWORD "$ENV_FILE" | cut -d= -f2-)" \
  POSTGRES_CONTAINER=platform_postgres_prod \
  COMPOSE_FILE="$COMPOSE_FILE" \
  bash db/scripts/migrate.sh

echo "seeding synthetic data..."
POSTGRES_CONTAINER=platform_postgres_prod bash db/scripts/seed.sh

echo "starting Cloudflare quick tunnel (this will log its assigned URL)..."
"$CLOUDFLARED" tunnel --url http://localhost:8000 --no-autoupdate > /tmp/cloudflared-demo.log 2>&1 &
CLOUDFLARED_PID=$!
echo "$CLOUDFLARED_PID" > /tmp/cloudflared-demo.pid

echo "waiting for tunnel URL..."
TUNNEL_URL=""
for _ in $(seq 1 30); do
  TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared-demo.log | head -1 || true)
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done
if [ -z "$TUNNEL_URL" ]; then
  echo "could not determine tunnel URL — check /tmp/cloudflared-demo.log" >&2
  exit 1
fi
echo "tunnel URL: $TUNNEL_URL"

KC_HOSTNAME="${TUNNEL_URL#https://}"
cat >> "$ENV_FILE" <<EOF
TUNNEL_URL=$TUNNEL_URL
KC_HOSTNAME=$KC_HOSTNAME
KEYCLOAK_ISSUER=$TUNNEL_URL/realms/platform
VITE_API_URL=$TUNNEL_URL/api
VITE_KEYCLOAK_URL=$TUNNEL_URL
EOF

echo "patching Keycloak realm export with the tunnel origin..."
python3 - "$TUNNEL_URL" <<'PYEOF'
import json, sys
tunnel_url = sys.argv[1]
with open("keycloak/realm-export.json") as f:
    realm = json.load(f)
for client in realm["clients"]:
    if client["clientId"] == "platform-api":
        client["redirectUris"] = [f"{tunnel_url}/*"]
        client["webOrigins"] = [tunnel_url]
with open("keycloak/realm-export.deploy.json", "w") as f:
    json.dump(realm, f, indent=2)
PYEOF

echo "building web image (bakes the tunnel URL into the static bundle)..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build web

echo "starting keycloak, api, web..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d keycloak api web

echo "waiting for the stack to come up..."
sleep 8
for _ in $(seq 1 30); do
  if curl -sf "$TUNNEL_URL/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done

echo ""
echo "=================================================================="
echo "Deployed. Reachable at: $TUNNEL_URL"
echo "Sign in with any seed user, e.g. sam.supervisor / devpassword123"
echo "(same seed users as local dev — see keycloak/realm-export.json)"
echo ""
echo "This is a temporary tunnel to your own machine, not a hosted cloud"
echo "instance — see deploy/README.md. Run deploy/teardown.sh when done;"
echo "nothing here is meant to keep running unattended."
echo "=================================================================="

#!/usr/bin/env bash
# Applies db/migrations/*.sql in order as the postgres superuser (bootstrap/DDL only).
# The application itself must NEVER connect this way — see 005_roles_and_rls.sql.
set -euo pipefail
cd "$(dirname "$0")/../.."

# Overridable so the same script works against a differently-named/composed stack (e.g. a
# one-off production-style deploy) without duplicating this logic — default behavior for the
# everyday dev stack is unchanged.
CONTAINER="${POSTGRES_CONTAINER:-platform_postgres}"
DB=platform
DBUSER=postgres

docker compose ${COMPOSE_FILE:+-f "$COMPOSE_FILE"} up -d postgres
echo "waiting for postgres..."
until docker exec "$CONTAINER" pg_isready -U "$DBUSER" -d "$DB" >/dev/null 2>&1; do sleep 1; done

# APP_USER_PASSWORD may come from a real .env in shared/production environments (see
# .env.example); falls back to the same local-dev placeholder 005 originally hardcoded.
APP_USER_PASSWORD="${APP_USER_PASSWORD:-app_user_local_dev_only}"

for f in db/migrations/*.sql; do
  echo "applying $f"
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -v app_user_password="$APP_USER_PASSWORD" -U "$DBUSER" -d "$DB" < "$f"
done

echo "migrations complete"

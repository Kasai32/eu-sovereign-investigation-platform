#!/usr/bin/env bash
# Applies db/migrations/*.sql in order as the postgres superuser (bootstrap/DDL only).
# The application itself must NEVER connect this way — see 005_roles_and_rls.sql.
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTAINER=platform_postgres
DB=platform
DBUSER=postgres

docker compose up -d postgres
echo "waiting for postgres..."
until docker exec "$CONTAINER" pg_isready -U "$DBUSER" -d "$DB" >/dev/null 2>&1; do sleep 1; done

for f in db/migrations/*.sql; do
  echo "applying $f"
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DBUSER" -d "$DB" < "$f"
done

echo "migrations complete"

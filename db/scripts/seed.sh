#!/usr/bin/env bash
# Loads synthetic seed data (db/seed/*.sql) as the postgres superuser. Seed data is fake by
# design — see db/seed/002_synthetic_entities.sql.
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTAINER=platform_postgres
DB=platform
DBUSER=postgres

for f in db/seed/*.sql; do
  echo "seeding $f"
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DBUSER" -d "$DB" < "$f"
done

echo "seed complete"

#!/usr/bin/env bash
# Generates synthetic objects/edges at scale (default: the blueprint's stated target of
# 1,000,000 objects / 5,000,000 edges) to validate query performance for real, rather than
# assuming the seed-scale dataset generalizes. Every generated row is tagged {"_lt": true} so
# db/scripts/loadtest-cleanup.sh can remove exactly this data afterward.
#
# Usage: db/scripts/loadtest-generate.sh [obj_count] [edge_count]
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTAINER=platform_postgres
DB=platform
DBUSER=postgres
OBJ_COUNT="${1:-1000000}"
EDGE_COUNT="${2:-5000000}"

docker compose up -d postgres
until docker exec "$CONTAINER" pg_isready -U "$DBUSER" -d "$DB" >/dev/null 2>&1; do sleep 1; done

echo "generating $OBJ_COUNT objects / $EDGE_COUNT edges..."
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DBUSER" -d "$DB" \
  -v obj_count="$OBJ_COUNT" -v edge_count="$EDGE_COUNT" -f - < db/loadtest/generate.sql

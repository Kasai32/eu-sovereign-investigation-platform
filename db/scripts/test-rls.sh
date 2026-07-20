#!/usr/bin/env bash
# Proves RLS by diffing REAL query results between a low-clearance and a high-clearance
# session, both connecting as the unprivileged app_user role. Per the build prompt: trust
# this test, not the policy SQL. If it reports identical results, RLS is bypassed.
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTAINER=platform_postgres
DB=platform
APPUSER=app_user
APPPASS=app_user_local_dev_only

QUERY="SELECT properties->>'name' AS name, classification FROM objects
       WHERE object_type_id = (SELECT id FROM object_types WHERE name='Person')
       ORDER BY name;"

run_as() {
  local clearance="$1"
  docker exec -i "$CONTAINER" env PGPASSWORD="$APPPASS" psql -U "$APPUSER" -d "$DB" -X -q -t -A -F',' <<SQL
SET app.current_user_id = '11111111-1111-1111-1111-111111111101';
SET app.actor_role = 'analyst';
SET app.current_clearance = '${clearance}';
${QUERY}
SQL
}

echo "== Low clearance (INTERNAL) =="
LOW=$(run_as INTERNAL)
echo "$LOW"

echo
echo "== High clearance (RESTRICTED) =="
HIGH=$(run_as RESTRICTED)
echo "$HIGH"

echo
if [ "$LOW" = "$HIGH" ]; then
  echo "FAIL: identical result sets for different clearances — RLS is bypassed or not filtering."
  exit 1
fi

if echo "$LOW" | grep -q "RESTRICTED"; then
  echo "FAIL: low-clearance session returned a RESTRICTED row."
  exit 1
fi

if ! echo "$HIGH" | grep -q "RESTRICTED"; then
  echo "FAIL: high-clearance session did not see any RESTRICTED row — seed data or policy problem."
  exit 1
fi

echo "PASS: low-clearance session excludes RESTRICTED rows that the high-clearance session sees."

echo
echo "== Sanity check: unset app.current_clearance must fail closed (no rows) =="
UNSET_RESULT=$(docker exec -i "$CONTAINER" env PGPASSWORD="$APPPASS" psql -U "$APPUSER" -d "$DB" -X -q -t -A <<SQL
SET app.actor_role = 'analyst';
${QUERY}
SQL
)
if [ -n "$UNSET_RESULT" ]; then
  echo "FAIL: unset clearance session returned rows (fail-open, not fail-closed): $UNSET_RESULT"
  exit 1
fi
echo "PASS: unset clearance session returns zero rows (fails closed)."

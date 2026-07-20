#!/usr/bin/env bash
# Writes real audit entries via write_audit_log(), confirms verify_audit_log() reports valid,
# then tampers a row directly (simulating a compromise that bypassed the app entirely) and
# confirms the chain verification actually detects it. Trigger-bypass requires disabling the
# immutability trigger as superuser first — proving the trigger alone isn't the only backstop,
# the hash chain is what catches tampering that gets past every other control.
set -euo pipefail
cd "$(dirname "$0")/../.."

CONTAINER=platform_postgres
DB=platform
APPUSER=app_user
APPPASS=app_user_local_dev_only

echo "== Writing audit entries as app_user =="
docker exec -i "$CONTAINER" env PGPASSWORD="$APPPASS" psql -v ON_ERROR_STOP=1 -U "$APPUSER" -d "$DB" -X -q <<'SQL'
SET app.current_user_id = '11111111-1111-1111-1111-111111111101';
SELECT write_audit_log(
  '11111111-1111-1111-1111-111111111101', 'case.read', 'case', 'b0000000-0000-4000-8000-000000000001',
  'Reviewing structuring alert per assignment', '{}'::jsonb);
SELECT write_audit_log(
  '11111111-1111-1111-1111-111111111101', 'object.read', 'object', 'a0000000-0000-4000-8000-000000000021',
  'Investigating counterparties on flagged account', '{}'::jsonb);
SET app.current_user_id = '11111111-1111-1111-1111-111111111103';
SELECT write_audit_log(
  '11111111-1111-1111-1111-111111111103', 'search', NULL, NULL,
  'Sweeping for related entities before SAR filing', '{"query":"Northwind Fiduciary"}'::jsonb);
SQL

echo
echo "== Confirming a mismatched session actor is rejected (spoofing attempt) =="
set +e
SPOOF=$(docker exec -i "$CONTAINER" env PGPASSWORD="$APPPASS" psql -U "$APPUSER" -d "$DB" -X -q -t -A 2>&1 <<'SQL'
SET app.current_user_id = '11111111-1111-1111-1111-111111111101';
SELECT write_audit_log(
  '11111111-1111-1111-1111-111111111104', 'object.read', 'object', 'a0000000-0000-4000-8000-000000000021',
  'attempting to attribute this to the admin instead of myself', '{}'::jsonb);
SQL
)
set -e
if echo "$SPOOF" | grep -qi "does not match session actor"; then
  echo "PASS: mismatched p_user_id vs session actor rejected."
else
  echo "FAIL: spoofed user_id was not rejected: $SPOOF"
  exit 1
fi

echo
echo "== Confirming app_user cannot INSERT/UPDATE/DELETE audit_log directly =="
set +e
DIRECT_INSERT=$(docker exec -i "$CONTAINER" env PGPASSWORD="$APPPASS" psql -U "$APPUSER" -d "$DB" -X -q -t -A 2>&1 <<'SQL'
INSERT INTO audit_log (user_id, action, purpose, occurred_at, prev_hash, row_hash)
VALUES ('11111111-1111-1111-1111-111111111101', 'forged', 'n/a', now(), 'x', 'y');
SQL
)
set -e
if echo "$DIRECT_INSERT" | grep -qi "permission denied"; then
  echo "PASS: direct INSERT on audit_log rejected (no grant to app_user)."
else
  echo "FAIL: direct INSERT on audit_log was not rejected: $DIRECT_INSERT"
  exit 1
fi

echo
echo "== Verifying chain (expect valid) as compliance role =="
VALID_BEFORE=$(docker exec -i "$CONTAINER" env PGPASSWORD="$APPPASS" psql -U "$APPUSER" -d "$DB" -X -q -t -A -F',' <<'SQL'
SET app.actor_role = 'compliance';
SELECT * FROM verify_audit_log();
SQL
)
echo "$VALID_BEFORE"
if [[ "$VALID_BEFORE" != t,* ]]; then
  echo "FAIL: chain reported invalid before any tampering."
  exit 1
fi
echo "PASS: chain verifies as valid before tampering."

echo
echo "== Simulating a bypassed-trigger tamper on the first row's purpose, as superuser =="
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB" -X -q <<'SQL'
ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_no_update;
UPDATE audit_log SET purpose = 'TAMPERED PURPOSE' WHERE seq = (SELECT min(seq) FROM audit_log);
ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_no_update;
SQL

echo
echo "== Verifying chain again (expect invalid, first_broken_seq = the tampered row) =="
VALID_AFTER=$(docker exec -i "$CONTAINER" env PGPASSWORD="$APPPASS" psql -U "$APPUSER" -d "$DB" -X -q -t -A -F',' <<'SQL'
SET app.actor_role = 'compliance';
SELECT * FROM verify_audit_log();
SQL
)
echo "$VALID_AFTER"
if [[ "$VALID_AFTER" == f,* ]]; then
  echo "PASS: tamper detected, chain reports invalid from the tampered row forward."
else
  echo "FAIL: tampering was not detected."
  exit 1
fi

echo
echo "== Confirming analyst role (not compliance/admin) cannot read audit_log at all =="
ANALYST_READ=$(docker exec -i "$CONTAINER" env PGPASSWORD="$APPPASS" psql -U "$APPUSER" -d "$DB" -X -q -t -A <<'SQL'
SET app.actor_role = 'analyst';
SELECT count(*) FROM audit_log;
SQL
)
if [ "$ANALYST_READ" = "0" ]; then
  echo "PASS: analyst session sees zero audit_log rows."
else
  echo "FAIL: analyst session read $ANALYST_READ audit_log rows."
  exit 1
fi

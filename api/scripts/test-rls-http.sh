#!/usr/bin/env bash
# Proves RLS holds through the full HTTP stack (Keycloak auth -> Fastify -> Postgres RLS), not
# just at the database layer. Logs in as real, differently-privileged Keycloak users and diffs
# real API responses. Requires: docker compose services up, migrations+seed applied, and the
# API running (see README "Running Phase 1").
set -euo pipefail

KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
API_URL="${API_URL:-http://localhost:4000}"
FAILURES=0

fail() {
  echo "FAIL: $1"
  FAILURES=$((FAILURES + 1))
}

pass() {
  echo "PASS: $1"
}

token_for() {
  curl -s -X POST "$KEYCLOAK_URL/realms/platform/protocol/openid-connect/token" \
    -d "grant_type=password" -d "client_id=platform-api" \
    -d "username=$1" -d "password=devpassword123" \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])"
}

echo "== Acquiring tokens =="
ALICE=$(token_for alice.analyst)     # analyst, INTERNAL
SAM=$(token_for sam.supervisor)      # supervisor, SENSITIVE, assigned to the seed case
CARA=$(token_for cara.compliance)    # compliance, RESTRICTED, created the seed case

echo
echo "== /objects: low vs high clearance, same endpoint, real diff =="
ALICE_OBJECTS=$(curl -s "$API_URL/objects" -H "Authorization: Bearer $ALICE")
CARA_OBJECTS=$(curl -s "$API_URL/objects" -H "Authorization: Bearer $CARA")

ALICE_CLASSES=$(echo "$ALICE_OBJECTS" | python3 -c "import sys,json;print(','.join(sorted(set(o['classification'] for o in json.load(sys.stdin)['objects']))))")
CARA_CLASSES=$(echo "$CARA_OBJECTS" | python3 -c "import sys,json;print(','.join(sorted(set(o['classification'] for o in json.load(sys.stdin)['objects']))))")
echo "alice (INTERNAL) sees classifications: $ALICE_CLASSES"
echo "cara (RESTRICTED) sees classifications: $CARA_CLASSES"

if [[ "$ALICE_CLASSES" == *"RESTRICTED"* || "$ALICE_CLASSES" == *"SENSITIVE"* ]]; then
  fail "analyst (INTERNAL) saw a SENSITIVE/RESTRICTED object"
else
  pass "analyst (INTERNAL) sees only PUBLIC/INTERNAL objects"
fi

if [[ "$CARA_CLASSES" == *"RESTRICTED"* ]]; then
  pass "compliance (RESTRICTED) sees RESTRICTED objects the analyst does not"
else
  fail "compliance (RESTRICTED) did not see any RESTRICTED object — check seed data or policy"
fi

if [ "$ALICE_OBJECTS" = "$CARA_OBJECTS" ]; then
  fail "identical /objects response for different clearances — RLS not filtering through the API"
else
  pass "analyst and compliance get different /objects responses"
fi

echo
echo "== /audit: role gate at the route AND the database =="
ALICE_AUDIT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/audit?purpose=test" -H "Authorization: Bearer $ALICE")
CARA_AUDIT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/audit?purpose=test" -H "Authorization: Bearer $CARA")
[ "$ALICE_AUDIT_CODE" = "403" ] && pass "analyst blocked from /audit (403)" || fail "analyst got $ALICE_AUDIT_CODE from /audit, expected 403"
[ "$CARA_AUDIT_CODE" = "200" ] && pass "compliance allowed on /audit (200)" || fail "compliance got $CARA_AUDIT_CODE from /audit, expected 200"

echo
echo "== Case access: classification gates access even for a pinned case member =="
# Alice is a case_member of the seed case (SENSITIVE) but her clearance is only INTERNAL —
# membership alone must not override the classification check.
ALICE_CASE_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "$API_URL/cases/b0000000-0000-4000-8000-000000000001?purpose=test" -H "Authorization: Bearer $ALICE")
[ "$ALICE_CASE_CODE" = "404" ] && pass "under-cleared case member cannot open a SENSITIVE case (404)" \
  || fail "under-cleared case member got $ALICE_CASE_CODE opening a SENSITIVE case, expected 404"

# Sam is assigned to the case and holds SENSITIVE clearance — should succeed.
SAM_CASE_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  "$API_URL/cases/b0000000-0000-4000-8000-000000000001?purpose=test" -H "Authorization: Bearer $SAM")
[ "$SAM_CASE_CODE" = "200" ] && pass "assigned supervisor with sufficient clearance opens the case (200)" \
  || fail "assigned supervisor got $SAM_CASE_CODE opening the case, expected 200"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "$FAILURES CHECK(S) FAILED"
  exit 1
fi

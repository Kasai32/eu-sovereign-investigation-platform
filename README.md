# EU-Sovereign Investigation Platform

AML/financial-crime investigation platform (alert-to-case workflow) for EU-regulated
compliance/fraud teams. See the three planning documents this repo implements against: the
build prompt (architecture/security requirements), the market strategy, and the execution
blueprint (screen-by-screen v1 scope).

**Intended use (stated per the build prompt's gate, before any code was written):** domain is
AML/financial-crime investigation; data flowing through it is synthetic and clearly fake until
a design-partner DPA exists; expected scale is small teams (~5–20 analysts) per tenant. This
scoping is why RLS and audit logging were built in Phase 0, before ingestion or UI — not
deferred.

## What's here

Phase 0 only: ontology schema, RLS enforced via a dedicated non-superuser `app_user` role,
hash-chained audit log, synthetic AML seed data, and two verification scripts that prove (not
assert) the security properties hold.

```
db/
  migrations/   001-005, applied in order, DDL-only (run as postgres superuser)
  seed/         synthetic fin-crime entities/edges/case (SYNTHETIC DATA ONLY)
  scripts/
    migrate.sh          apply all migrations
    seed.sh             load synthetic seed data
    test-rls.sh          proves RLS with real low- vs high-clearance query diffs
    test-audit-chain.sh proves the hash chain detects tampering
```

## Running it

```bash
./db/scripts/migrate.sh
./db/scripts/seed.sh
./db/scripts/test-rls.sh
./db/scripts/test-audit-chain.sh
```

Local Postgres runs via `docker-compose.yml`. **Local dev credentials in the migration files
(`app_user_local_dev_only`, `postgres_local_dev_only`) are placeholders — rotate and manage via
secrets in any shared or production environment; never commit real credentials.**

## Connecting

The app must connect as `app_user` (`app_user_local_dev_only` locally), never as `postgres`.
Connecting as the superuser/table-owner silently bypasses every RLS policy — proven directly in
this repo's history (see the self-review) rather than just asserted.

Per request, the API layer must set three session variables before running any query:

```sql
SET LOCAL app.current_user_id = '<uuid>';
SET LOCAL app.actor_role = 'analyst' | 'supervisor' | 'compliance' | 'admin';
SET LOCAL app.current_clearance = 'PUBLIC' | 'INTERNAL' | 'SENSITIVE' | 'RESTRICTED';
```

Unset variables fail closed (zero rows), not open — verified in `test-rls.sh`.

## Phase 1: API layer

Fastify (TypeScript) API in `api/`, with real Keycloak auth — not a demo shim. Keycloak proves
identity (who you are); `app_users` (managed via the future S7 admin screen) is the source of
truth for authorization (role, clearance) — the two are deliberately kept separate. Every read
and write goes through `withRequestContext()`, which sets the RLS session variables per request
and never bypasses them.

```
api/
  src/
    db.ts            pg pool as app_user + withRequestContext() (SET LOCAL via set_config, no
                      string interpolation)
    auth.ts           Keycloak JWT verify + app_users lookup
    audit.ts           writeAudit() wrapper around write_audit_log()
    routes/
      objects.ts        S3/S4 — search + entity detail
      graph.ts           server-side k-hop expansion (recursive CTE, capped)
      cases.ts            S1/S2 — queue, workspace, notes, pin, status (with evidence snapshot
                          on close)
      audit.ts           S7 — compliance/admin-only audit log + chain verification
  scripts/
    test-rls-http.sh    proves RLS through the full HTTP stack with real Keycloak tokens
keycloak/
  realm-export.json    platform realm: 4 roles, 1 public client, 4 seed users matching
                        app_users (password: devpassword123, local dev only)
```

### Running Phase 1

```bash
docker compose up -d          # postgres + keycloak
./db/scripts/migrate.sh
./db/scripts/seed.sh
cd api && npm install
PORT=4000 npm run dev         # 3001 may already be taken by something else on your machine
./scripts/test-rls-http.sh    # from api/, once the server above is running
```

Every route requires a `purpose` param on sensitive access (entity detail, case detail, case
writes, audit log) — see `PHASE1_REVIEW.md` for where it's required vs. defaulted, and why.

## Status

Phase 0 (schema + RLS + audit chain + synthetic seed) and Phase 1 (API layer + real Keycloak
auth) are done and verified — see `PHASE0_REVIEW.md` and `PHASE1_REVIEW.md`. Next: Phase 2 — the
actual UI screens (S1 case queue, S2 case workspace with the graph canvas, S3/S4 search).

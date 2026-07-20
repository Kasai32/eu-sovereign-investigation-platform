# EU-Sovereign Investigation Platform — Phase 0

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

## Status

Phase 0 of the blueprint's build sequence (repo, CI groundwork, schema + RLS + audit chain,
synthetic seed). Next: Phase 1 — API layer (real auth, object/search/graph/case endpoints,
RLS + chain-verification tests wired into CI). See `PHASE0_REVIEW.md` for the self-review.

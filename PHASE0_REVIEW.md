# Phase 0 self-review

Scope built: ontology schema, `app_user` role + RLS (proven, not asserted), hash-chained
audit log (proven, not asserted), synthetic AML seed data. Everything below was actually run
against a real Postgres instance, not inferred from reading the SQL.

## What was verified, and how

- **RLS boundary.** `db/scripts/test-rls.sh` runs the identical query as the same DB role
  (`app_user`) with `app.current_clearance` set to `INTERNAL` vs `RESTRICTED`, and diffs the
  actual rows returned. Low clearance never sees the RESTRICTED row; high clearance does; an
  unset clearance session returns zero rows (fail-closed). Separately confirmed that connecting
  as the `postgres` superuser returns all 16 objects regardless of any clearance setting —
  the exact bypass the build prompt warns about, reproduced on purpose so the risk is concrete
  rather than theoretical.
- **Audit hash chain.** `db/scripts/test-audit-chain.sh` writes real entries through
  `write_audit_log()`, confirms `app_user` cannot `INSERT`/`UPDATE`/`DELETE` the table
  directly, confirms a spoofed `user_id` (mismatched against the session actor) is rejected,
  verifies the chain as valid, then disables the immutability trigger as superuser, tampers one
  row's `purpose` field, and confirms `verify_audit_log()` catches it and reports the first
  broken `seq`. Also confirmed an `analyst`-role session reads zero rows from `audit_log`.

## What's fragile

- **Session-variable trust boundary.** Every RLS policy and the audit spoof-check depend on the
  API layer correctly setting `app.current_user_id` / `app.actor_role` / `app.current_clearance`
  via `SET LOCAL` inside the request's transaction. If Phase 1 uses a connection pooler in a mode
  that doesn't guarantee one transaction per logical request (e.g. pgbouncer transaction pooling
  misconfigured, or a query issued outside the expected transaction boundary), session state
  could leak or reset unexpectedly. This needs an explicit integration test in Phase 1, not just
  trust that `SET LOCAL` behaves as documented.
- **Property-level classification is coarser than the build prompt's aspiration.** Each `objects`
  row has one classification for the whole `properties` JSONB blob; true per-property filtering
  only exists in `object_property_meta`, which is a separate provenance table, not a mechanism
  that redacts individual keys out of `objects.properties` itself. A RESTRICTED-classified single
  property on an otherwise-INTERNAL object currently means the whole object should probably be
  classified RESTRICTED, or the sensitive value should live only in `object_property_meta` and be
  omitted from `objects.properties`. This wasn't decided in code — it needs an explicit API-layer
  convention before ingestion is built, or provenance and object classification will drift apart.
- **No JSON Schema enforcement yet.** `object_types.property_schema` is stored but nothing
  validates `objects.properties` against it on write. The build prompt scopes this as an API-layer
  concern, which is correct sequencing, but it means Phase 0's schema currently accepts any JSONB
  shape — flagging so it isn't mistaken for already-enforced.
- **`case_notes` has no immutability guarantee.** Unlike `audit_log`, notes can be updated/deleted
  by anything with table grants (currently just `app_user`, so only via the API). Fine for an MVP
  where the API never issues note UPDATE/DELETE, but there's no DB-level backstop if that
  assumption breaks. A real analyst reviewer would ask "can a note be edited after the fact
  without a trace" — right now the honest answer is "only the audit_log would show it, the note
  row itself wouldn't."
- **`resolution_queue` doesn't inherit the classification of its two candidate objects** — it's
  visible to any authenticated analyst role regardless of whether the underlying entities are
  RESTRICTED. Noted inline in the migration; low risk at this scale but worth fixing before
  ingestion introduces higher-classification candidates into the queue.
- **Local dev credentials are plaintext in committed SQL** (`app_user_local_dev_only`,
  `postgres_local_dev_only`). Correct for a throwaway local Docker instance, explicitly called
  out in the README as not-for-production. Phase 1 needs real secrets management before any
  shared or hosted environment.

## What a real analyst/compliance reviewer would push on

- "Show me the RLS test running against my own account, not just against seed users" — reasonable
  ask once real users exist; today it's fully synthetic.
- "What happens to `resolution_queue` entries when a merge is undone?" — the schema supports
  reversal (`canonical_of` is just a pointer, no data destroyed), but no unmerge workflow exists
  yet; that's a Phase 3/4 (S6) build item, not a schema gap.
- "Why is `case_notes` append-only 'by convention' instead of enforced like `audit_log`?" — fair
  challenge; deferred deliberately to keep Phase 0 scoped, named here rather than silently skipped.

## Deferred, and why

Everything past schema/RLS/audit/seed — API layer, auth, UI, ingestion, entity resolution UI,
graph/case/export screens — is Phase 1+ per the blueprint's explicit build order ("access control
before ingestion, deliberately"). No shortcuts were taken *within* Phase 0's scope; the shortcuts
above are scope boundaries, not corners cut inside the boundary.

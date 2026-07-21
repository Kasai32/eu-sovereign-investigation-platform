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

## Phase 2: frontend (S3 search, S4 entity detail, S1 case queue)

React + Vite + TanStack Router/Query + Tailwind in `web/`. Real browser login uses
Authorization Code + PKCE against Keycloak — not the password-grant shortcut the backend test
scripts use. Verified in an actual browser (not just typecheck) as two different real users;
see `PHASE2_REVIEW.md`.

```
web/
  src/
    lib/
      pkce.ts           code_verifier/code_challenge generation (Web Crypto, no dependency)
      auth.ts            PKCE login/callback/refresh/logout against Keycloak
      AuthContext.tsx     React context: tokens, silent refresh, decoded display claims
      api.ts              typed fetch client (objects/cases), auto-attaches a valid access token
    router.tsx           root layout + all routes/screens (Search, Object detail, Cases)
```

### Running Phase 2

```bash
docker compose up -d          # postgres + keycloak
./db/scripts/migrate.sh
./db/scripts/seed.sh
cd api && npm install && PORT=4000 npm run dev
cd ../web && npm install && npm run dev   # http://localhost:3000
```

Sign in as any seed user (e.g. `sam.supervisor` / `devpassword123`) at the Keycloak login page
you're redirected to. Entity detail requires typing a reason for viewing first — that's not
decorative, the API 400s without it and the audit log records exactly what you typed.

## Phase 3: case workspace (S2)

The blueprint's own "60% of build effort" screen. Click any case title in the queue to open it.
Three panes: case file (entities/notes/activity, left), Cytoscape.js graph canvas (center,
force-directed layout, click to select/expand, path-finding between two nodes), entity/edge
inspector (right, with add/remove-from-case). Selecting anything in one pane highlights it in
the other two — proven with a real integration test, not just wired up, per the build prompt's
explicit instruction. See `PHASE3_REVIEW.md`, including a genuine concurrency bug in the audit
hash chain found and fixed during this phase's verification (migration 008).

```
web/src/
  CaseWorkspacePage.tsx      route wrapper (useParams) + CaseWorkspace (the actual 3-pane UI,
                              kept separate so it's testable without a router)
  CaseWorkspacePage.test.tsx  cross-pane linked-selection integration test (Vitest + RTL)
  components/GraphCanvas.tsx  Cytoscape wrapper: props -> cy instance sync via effects
api/src/routes/
  cases.ts   + GET /cases/:id/graph, DELETE /cases/:id/entities/:objectId
  graph.ts   + GET /graph/path (server-side shortest path, recursive CTE)
```

### Running Phase 3

Same as Phase 2 (`docker compose up -d`, migrate, seed, run `api` then `web`), plus:

```bash
cd web && npm test   # linked-selection integration test
```

## Status

Phase 0 (schema + RLS + audit chain + synthetic seed), Phase 1 (API + real Keycloak auth),
Phase 2 (S1/S3/S4 frontend), and Phase 3 (S2 case workspace) are done and verified — see
`PHASE0_REVIEW.md` through `PHASE3_REVIEW.md`. Next: Phase 4 — S5 ingestion (CSV upload +
column mapping) and S6 (entity-resolution review queue), per the blueprint's build order.

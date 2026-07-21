# EU-Sovereign Investigation Platform

[![GitHub repo](https://img.shields.io/badge/GitHub-Kasai32%2Feu--sovereign--investigation--platform-blue?logo=github)](https://github.com/Kasai32/eu-sovereign-investigation-platform)

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

The foundation, shipped in Phase 0 and unchanged in substance since: ontology schema, RLS
enforced via a dedicated non-superuser `app_user` role, hash-chained audit log, synthetic AML
seed data, and verification scripts that prove (not assert) the security properties hold.
Everything built on top of it — the full API, frontend, and all seven v1 screens — is in the
phase sections below; see "Beyond Phase 6" for what's happened since the v1 build closed out.

```
db/
  migrations/   all files, applied in order, DDL-only (run as postgres superuser)
  seed/         synthetic fin-crime entities/edges/case (SYNTHETIC DATA ONLY)
  loadtest/     synthetic data generator + benchmark queries for validating performance at the
                blueprint's stated scale target (1M objects/5M edges) — see "Beyond Phase 6" below
  scripts/
    migrate.sh              apply all migrations
    seed.sh                 load synthetic seed data
    test-rls.sh              proves RLS with real low- vs high-clearance query diffs
    test-audit-chain.sh     proves the hash chain detects tampering
    loadtest-generate.sh    generate synthetic data at scale (default 1M objects/5M edges)
    loadtest-cleanup.sh     remove everything loadtest-generate.sh created
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
      graph.ts           server-side k-hop expansion (recursive CTE, per-node fan-out capped)
                          + shortest-path (app-level BFS — see "Beyond Phase 6" below)
      cases/              S1/S2 — queue, workspace, notes, pin, status (with evidence snapshot
                          on close); split into queue.ts/workspace.ts/lifecycle.ts + shared.ts,
                          composed by index.ts — see "Beyond Phase 6" below
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
      api/                typed fetch client, auto-attaches a valid access token; one file per
                          domain (objects/cases/graph/ingestion/resolutionQueue/admin/audit)
                          composed into one flat useApiClient() by index.ts — see "Beyond
                          Phase 6" below
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
  cases/     + GET /cases/:id/graph, DELETE /cases/:id/entities/:objectId
  graph.ts   + GET /graph/path (server-side shortest path; originally a recursive CTE, later
             rewritten as an app-level BFS — see "Beyond Phase 6" below)
```

### Running Phase 3

Same as Phase 2 (`docker compose up -d`, migrate, seed, run `api` then `web`), plus:

```bash
cd web && npm test   # linked-selection integration test
```

## Phase 4: intake + entity resolution (S5, S6)

CSV ingestion with column-mapping templates, run tracking, and quarantine (`/intake`, upload
restricted to supervisor/compliance/admin; source/template management to admin), and a
keyboard-driven entity-resolution review queue (`/resolution-queue`, open to any analyst).
Ingestion both inserts new objects **and** runs fuzzy entity resolution against existing ones in
the same pass: exact/near-exact matches auto-merge (reversible via `canonical_of`), ambiguous
matches queue for human review, invalid rows quarantine — never auto-merging an ambiguous match,
per the build prompt. Verified with a CSV that exercises all four outcomes at once, via curl and
then again through a real file-upload + real keyboard shortcut in the browser. See
`PHASE4_REVIEW.md`, including real gaps named rather than glossed over (retention days is
configurable but not enforced; no intra-batch duplicate detection).

```
api/src/
  objectValidation.ts        minimal schema validator (closes a Phase 0-flagged gap: schemas
                              were stored but never enforced)
  routes/objectTypes.ts       GET /object-types (also closes a Phase 2 gap: the search screen's
                              type filter was hardcoded, now fetched)
  routes/ingestion.ts         sources, mapping templates, CSV upload + entity resolution
  routes/resolutionQueue.ts   S6: list pending pairs, decide, undo
web/src/
  IntakePage.tsx              S5
  ResolutionQueuePage.tsx     S6
```

### Running Phase 4

Same as before. Sign in as `adam.admin` to create sources/templates, or `sam.supervisor` to
upload against ones that already exist. Any seed user can review the resolution queue.

## Phase 5: S7 — admin, audit, and case export

User administration (`/admin/users`, admin only), the audit log viewer (`/audit`,
compliance/admin only, with a live chain-verification badge and filters), and case export — the
blueprint's "headline feature" — as a printable HTML report (browser print-to-PDF) plus a
Markdown download, reachable from a case workspace's "Export report" link. Verified live,
including changing a real user's clearance via the UI and confirming it took effect on their
very next request without re-login.

This phase also upgraded `evidence_snapshot` (frozen on case close since Phase 1, never actually
read until now) to embed full object/edge property values, not just IDs — verified by editing a
frozen entity's live property and confirming the closed case's report still showed the old
value. Redaction on export is automatic: for open cases it's inherited from the same RLS-scoped
connection as everything else; for closed cases (reading frozen JSON rather than live rows) it's
applied explicitly against the viewer's clearance, since RLS filters rows, not values inside a
jsonb column — see `PHASE5_REVIEW.md` for why that distinction matters.

Also fixed a real bug found while testing: the audit log's filter inputs lost keystrokes after
the first character (an `isLoading` early-return was unmounting the inputs on every filter
keystroke). Every other screen with a loading gate was checked for the same pattern; none of the
others share it, since they only gate loading after a one-time submission, not live typing.

```
api/src/routes/
  admin.ts       GET/PATCH /admin/users, admin-only, audited
  audit.ts       + date-range/resource-type filters, user display names
  cases/         + GET /cases/:id/report (evidence-snapshot-aware), status-close snapshot now
                 embeds full object/edge data, not just IDs
web/src/
  AdminUsersPage.tsx   S7 user administration
  AuditLogPage.tsx     S7 audit log viewer
  CaseReportPage.tsx   S7 case export (print-to-PDF + Markdown)
```

### Running Phase 5

Same as before. Sign in as `adam.admin` for the Users and Audit screens (nav links only appear
for compliance/admin roles). Export a report from any case workspace's "Export report" link.

## Phase 6: hardening

Rate limiting (`@fastify/rate-limit`, 300 req/min global default, `/health` exempted; the two
most expensive routes were later given tighter per-route limits — see "Beyond Phase 6" below),
security headers (`@fastify/helmet`), a request body-size cap set safely above the multipart upload
limit, and a CORS origin allowlist that reads a comma-separated list from config instead of one
hardcoded default. Also: Postgres/Keycloak admin passwords and `app_user`'s password are now
configurable via `.env` (copy `.env.example`) instead of hardcoded-only — verified with an
actual password rotation over a real TCP connection (the same code path the API's `pg` driver
uses; `docker exec psql` would have given a false pass, since the Postgres image trusts local
Unix-socket connections regardless of password — see `PHASE6_REVIEW.md`).

`npm audit` is clean on both `api/` and `web/`. The full regression suite (`test-rls.sh`,
`test-audit-chain.sh`, `test-rls-http.sh`, the Vitest suite, both typechecks) was re-run after
every change in this phase.

`SECURITY_GAP_ASSESSMENT.md` is a code-level pass against ISO/IEC 27001:2022 Annex A — not a
certification audit, but an honest baseline naming what's covered, what's partial, and what's a
real gap, each with a rough priority. Two of its named gaps (CI automation, splitting the
Keycloak client's browser and test-script grant types) were closed afterward — see "Beyond
Phase 6" below; the document itself is left as originally written rather than edited after the
fact, since it's meant to reflect what a point-in-time assessment actually found.

## Beyond Phase 6: external review, load testing, and follow-through

Phase 6 closed out the blueprint's originally-scoped v1 build. Since then, an external code
review (not a self-review, unlike Phases 0–6) and a load test against the blueprint's own stated
scale target (1M objects/5M edges — never actually tested until now) found and fixed several
real issues, each verified live against real data rather than by inspection. Full detail —
including what was tried and rejected along the way — is in `DECISIONS.md` #30–#43; this is the
short version:

- **`resolution_queue` RLS gap closed**: it didn't inherit the classification of the two
  candidate objects it referenced (self-flagged since `PHASE0_REVIEW.md`); an under-cleared
  reviewer could "merge" a RESTRICTED pair and have it silently no-op while the audit log
  reported success. Fixed at both the RLS and application layers.
- **`/graph/expand` given a per-node fan-out cap**, not just a depth cap, after confirming a hub
  entity could otherwise force a combinatorially large intermediate result before the final
  row limit applied.
- **Ingestion/search trigram matching fixed to actually use its own index**: the prior queries
  used a bare `similarity()` call, which Postgres can never accelerate via the GIN trigram index
  regardless of query shape — confirmed via `EXPLAIN`, not assumed.
- **Admin route hardened**: `purpose` is now required (was defaulted), and the audit entry now
  records previous values, not just new ones.
- **Closed/archived cases can no longer be edited** (notes, pin/unpin) — the evidence snapshot
  froze the *report*, but nothing had stopped the live case record itself from changing after.
- **Load-tested at 1M objects/5M edges** (`db/loadtest/`) — the first time this codebase's
  performance was checked against the blueprint's actual stated target rather than assumed from
  seed-scale data. This found a real bug, not just confirmed correctness:
- **`/graph/path` rewritten as an app-level BFS.** The original recursive-CTE shortest-path query
  (built in Phase 3, already flagged there as needing "a proper algorithm... before a denser
  graph would make this expensive") timed out past 30s at 5M edges. A fan-out cap — the fix that
  worked for `/graph/expand` — doesn't help here, confirmed by testing it directly: path search
  tracks a full path array per candidate, so growth is exponential in fan-out^hops regardless of
  the cap. The rewrite tracks only visited node IDs, bounded by an edge-examination budget; it
  has an accepted, documented completeness limit (very distant pairs in a dense graph can report
  "not found within budget" rather than a wrong answer or a hang) that a true bidirectional BFS
  would close — named as a future improvement, not built.
- **Ingestion chunked into per-500-row transactions with checkpointing**, replacing the original
  single-transaction design (named as a scale risk since `PHASE4_REVIEW.md`). Proven necessary,
  not theoretical: the old version took 82s for 20,000 rows over real HTTP, and killing the
  server mid-run lost every row silently, with no record a run had even been attempted.
- **Ingestion made resumable** (`POST /ingestion/runs/:id/resume`): a crashed or failed run can
  be safely continued by re-uploading the same file — a SHA-256 file-hash check plus a
  session-scoped advisory lock make this safe against a wrong file or a concurrent double-resume.
  Verified by actually crashing a real run mid-flight and resuming it.
- **`cases.ts` and `web/lib/api.ts` split into per-domain modules** (`api/src/routes/cases/`,
  `web/src/lib/api/`), both previously named as split candidates but deliberately deferred until
  the risk could be paid off with real verification. Zero behavior change — every route/call site
  is identical; only where the code lives changed.
- **CI pipeline stood up** (`.github/workflows/ci.yml`), running the exact same sequence a
  developer runs locally rather than a parallel CI-only setup.
- **Rate limiting tuned per-route** on the two most expensive endpoints (ingestion, report
  export), instead of relying on the single global default alone.
- **Keycloak client split**: the browser client (`platform-api`) no longer allows the
  password-grant flow the backend test scripts used; a separate `platform-test` client handles
  that now. Closes the item `SECURITY_GAP_ASSESSMENT.md` named as top-priority.
- **Ingestion processing moved off the request/response cycle**: chunking (above) made a large
  run crash-safe, but a real 20,000-row upload still held one HTTP request open for its full
  82s. `POST /ingestion/runs`/`resume` now return as soon as the run is created, processing
  continues in the background, and the intake UI polls for status. Verified against a real
  20k-row run: the request returned in ~70ms, and concurrent requests stayed fast (2-20ms)
  throughout processing instead of contending for a starved pool.
- **XLSX ingestion**: the blueprint's disclosed CSV/XLSX scope cut is closed — a shared
  `parseIngestionFile()` entry point turns either format into the same row shape, so mapping,
  validation, entity resolution, quarantine, and resume never branch on file format. Verified
  against a real `.xlsx` file, including crashing a 3,000-row run mid-flight and resuming it
  with zero duplicates, same as CSV. Uses `exceljs`, not the npm-published `xlsx` package —
  the latter carries two unfixed advisories with no fix in the npm ecosystem at all.
- **Retention enforcement**: `retention_days` was stored per source since Phase 5 but never
  applied. A scheduled sweep now anonymizes (never deletes — `app_user` has no `DELETE` grant
  on ontology tables at all, by original design) objects/edges whose source's window has
  elapsed, skipping anything still pinned to an open case. Verified live: restarted the server
  with a fresh expired object in place and confirmed the scheduled sweep anonymized it
  automatically within seconds, no manual trigger involved.
- **Shared, validated request/response schema for `GET /cases/:id`** (`shared/schemas/
  caseDetail.ts`, see `shared/README.md`): the first route migrated off the frontend's bare
  `request<T>()` type-assertion pattern, onto a Zod schema both `api` and `web` validate
  against. Writing it surfaced a real pre-existing drift (a hand-written type claimed a field —
  `entity_count` — this response never actually returns) and two bugs in the schema itself,
  caught on the first real request rather than in review. Verified: a deliberately renamed
  field failed `web`'s typecheck and the live API request with a `500`, on the same real
  request; reverted after confirming both.
- **Deployment, interim**: `deploy/` runs the full stack in Docker behind a Cloudflare tunnel —
  see `deploy/README.md` for exactly what this is (and isn't) a stand-in for while the real EU
  host (Hetzner) waits on budget. Verified against a real, publicly-reachable instance: signed
  in as a seed user through the full PKCE flow, ran a complete alert→case→document→close cycle,
  then fully tore the deployment back down. Surfaced and fixed three real bugs along the way
  (`DECISIONS.md` #50) — including one where a Compose project-naming mistake briefly recreated
  the running dev containers, caught immediately and confirmed zero data loss before continuing.

An "AI Project Improvements & Persistent Memory System" proposal (multi-agent decision
personas, a knowledge-graph world model, confidence/scenario engines, an autonomous
self-modifying workflow) was evaluated and declined — its own stated mission doesn't match this
project's actual one, and its core premise runs against this codebase's real, human-accountable
audit design. `DECISIONS.md` itself is the one piece of that proposal judged worth keeping,
stripped of the framing around it (`DECISIONS.md` #40).

## Status

Phases 0–6 (schema/RLS/audit chain, API + Keycloak auth, S1/S3/S4 frontend, S2 case workspace,
S5/S6 intake + entity resolution, S7 admin/audit/export, hardening) are done and verified — see
`PHASE0_REVIEW.md` through `PHASE6_REVIEW.md` and `SECURITY_GAP_ASSESSMENT.md`. This closes out
the blueprint's originally-scoped v1 screen list plus the strategy document's pre-pilot
hardening checklist. Since then, see "Beyond Phase 6" above for an external review's fixes, a
load test at the blueprint's stated scale target, and follow-through on three of the gap
assessment's named items (CI, per-route rate limiting, the Keycloak client split).

`DECISIONS.md` is the running architecture decision record — why each real design choice was
made, what alternatives were rejected and why, and which earlier decisions were later superseded
(e.g. the original synchronous single-transaction ingestion, later replaced by chunking +
resumability; the original recursive-CTE shortest path, later replaced by an app-level BFS).
Check it before re-litigating something already decided or reversing a decision without knowing
why it was made.

What's left before a design-partner pilot: DPIA/records-of-processing tooling, a
backend-for-frontend to move browser tokens out of `sessionStorage` into an httpOnly cookie
(`DECISIONS.md` #11), backups + a verified restore drill, and the real EU cloud host itself —
`deploy/` is a budget-interim stand-in (personal machine + Cloudflare tunnel, one-off session
only), not that. `docs/PLAN.md` phases the rest; only one of many routes has a shared schema so
far (`shared/README.md` has the pattern for migrating the rest incrementally).

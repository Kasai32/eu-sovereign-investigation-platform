# Decisions

Architecture Decision Record. One entry per real decision actually made during this project's
build — not aspirational, not templated. Pulled from `PHASE0_REVIEW.md` through
`PHASE6_REVIEW.md`, `ARCHITECTURE_AUDIT.md`, and this session's work; every entry links back to
where it's documented in more depth. Superseded decisions are marked, not deleted — the point of
this file is to stop a future session from re-litigating something already decided, or silently
undoing a decision without knowing why it was made.

New entries go at the bottom. Format: Choice / Reason / Alternatives considered / Source.

---

## Phase 0 — schema, RLS, audit

### #1 — Row-Level Security is the access-control enforcement layer, not application code
**Choice:** Every classified table has `FORCE ROW LEVEL SECURITY`; policies compare the row's
`classification` column against `current_setting('app.current_clearance')`. The API connects as
a dedicated non-superuser `app_user` role — never the migration superuser.
**Reason:** App-layer filtering (a `WHERE classification <= ?` a developer must remember to add
to every query) fails silently the first time someone forgets it. RLS fails closed by
construction — an unset clearance session returns zero rows, not all rows.
**Alternatives considered:** App-layer authorization checks per route. Rejected: no single point
of failure to audit: correctness depends on every future route author remembering to add the
check.
**Source:** `PHASE0_REVIEW.md`, `db/scripts/test-rls.sh`

### #2 — Four-tier classification as a first-class column, not a bolt-on label
**Choice:** `PUBLIC`/`INTERNAL`/`SENSITIVE`/`RESTRICTED` as an enum column on every classified
table, ordered so `classification <= clearance` is a plain comparison.
**Reason:** Needed to be RLS-native (see #1) — a separate classification table joined at query
time would mean every policy needs a join, and joins inside RLS policies are a common source of
the recursion bugs later found in #9.
**Source:** `PHASE0_REVIEW.md`

### #3 — Hash-chained, append-only audit log
**Choice:** `audit_log` rows are immutable (trigger-enforced), each row's hash includes the
previous row's hash, and `verify_audit_log()` walks the chain to detect tampering.
**Reason:** A compliance product's audit trail needs to answer "was this tampered with," not
just "does a row for this action exist." An append-only table without chaining can be edited by
anyone with table-level access and leave no trace.
**Source:** `PHASE0_REVIEW.md`

### #4 — Session RLS variables set via `set_config()`, never string interpolation
**Choice:** `withRequestContext()` sets `app.current_user_id`/`app.actor_role`/
`app.current_clearance` via parameterized `set_config()` calls inside `SET LOCAL`'s transaction
scope, once per request.
**Reason:** String-interpolating session variables into `SET` statements is a SQL-injection
vector for a value (JWT claims) that's attacker-influenced.
**Source:** `PHASE0_REVIEW.md`, `api/src/db.ts`

---

## Phase 1 — API, auth

### #5 — AuthN and AuthZ deliberately split
**Choice:** Keycloak proves identity only. `app_users` (role, clearance, `is_active`) is the
sole source of authorization data, looked up fresh from Postgres on every request — never
trusted from JWT claims or cached.
**Reason:** Deactivating a user or changing their clearance takes effect on their very next
request, not at token expiry. A compromised or misconfigured Keycloak realm can prove identity
but can't grant access `app_users` doesn't also grant.
**Alternatives considered:** Encode role/clearance as JWT claims, read directly from the token.
**Rejected because:** stale-until-expiry authorization is a real risk for a product whose whole
job is access control; verified live in `PHASE5_REVIEW.md` by rotating a user's clearance and
confirming their very next request reflected it, no new login required.
**Source:** `PHASE1_REVIEW.md`, `ARCHITECTURE_AUDIT.md` §1

### #6 — 404, not 403, for classification-blocked resources
**Choice:** A case (or object) a session isn't cleared to see returns 404, identical to one that
doesn't exist.
**Reason:** A 403 confirms the resource exists; 404 doesn't. Don't let an unauthorized session
learn anything from the fact of a resource's existence.
**Source:** `PHASE1_REVIEW.md`

### #7 — Purpose-of-use required for sensitive reads, defaulted for list/browse
**Choice:** Entity detail, case detail, case writes, and the audit log itself reject a missing
`purpose`. `GET /objects`/`GET /cases` (list views) default one instead of blocking.
**Reason:** Requiring a written justification for every paginated list view would make the
product unusable without adding real audit value — the meaningful moment to capture intent is
opening a specific record, not scrolling a list.
**Source:** `PHASE1_REVIEW.md`

### #8 — `case_visible()` SECURITY DEFINER function to break RLS policy recursion
**Choice:** `cases_select`'s policy and every case-child table's policy call one
`SECURITY DEFINER`, `STABLE` function instead of querying each other directly via `EXISTS`.
**Reason:** `cases_select` referencing `case_members` in an `EXISTS`, with `case_members_select`
referencing `cases` back, is a genuine cycle — Postgres rejects it outright
(`42P17 infinite recursion`). Found live, not by reading the SQL.
**Source:** `PHASE1_REVIEW.md`, `db/migrations/006_fix_case_rls_recursion.sql`

### #9 — Generate id client-side + separate `SELECT`, not `INSERT ... RETURNING`, on tables whose SELECT policy calls a self-referencing function
**Choice:** Case/note creation generates the UUID in application code, inserts without
`RETURNING`, then reads the row back with a separate `SELECT` in the same transaction.
**Reason:** `case_visible()` (#8) is `STABLE`, so its snapshot is fixed at statement start and
can't see a row the same `INSERT` is still creating — Postgres's `RETURNING` visibility re-check
fails even though `WITH CHECK` already passed. A new statement gets a snapshot that includes
what the prior statement just committed within the transaction.
**Source:** `PHASE1_REVIEW.md`

---

## Phase 2 — frontend, PKCE

### #10 — Real Authorization Code + PKCE for the browser; password-grant kept only for backend test scripts
**Choice:** The browser uses PKCE against Keycloak. `test-rls-http.sh`/`test-audit-chain.sh`
keep using Resource Owner Password Credentials (ROPC) against the same Keycloak client.
**Reason:** PKCE is the correct browser flow (no client secret exposed). ROPC is the only
practical way to acquire a token from a bare shell script with no browser involved.
**Status:** the one-client-for-both-grant-types setup was later named as a real gap, not fixed
— see #23.
**Source:** `PHASE2_REVIEW.md`

### #11 — Tokens in `sessionStorage`, not an httpOnly cookie
**Choice:** Access/refresh tokens live in browser `sessionStorage`.
**Reason:** No backend-for-frontend exists to set httpOnly cookies at this phase.
**Status:** open gap, explicitly flagged as the single biggest frontend security exposure (XSS)
at the time it was made; not revisited since.
**Source:** `PHASE2_REVIEW.md`, `web/src/lib/auth.ts`

---

## Phase 3 — case workspace, graph

### #12 — `pg_advisory_xact_lock()` serializing `write_audit_log()`'s read-then-insert
**Choice:** `write_audit_log()` takes an advisory lock at the top of the function, held for the
duration of "read the last row's hash, then insert."
**Reason:** Two concurrent writers (a multi-pane UI firing parallel requests on every case open
is enough to trigger this) could both read the same "last" hash and both insert a valid-looking
row on top of it — forking the chain. No constraint prevented it before the lock. Verified with
60 genuinely concurrent writes from 4 parallel sessions after the fix.
**Source:** `PHASE3_REVIEW.md`, `db/migrations/008_audit_log_chain_lock.sql`

### #13 — Node position pinning is client-side only, not persisted server-side
**Choice:** Graph canvas node pinning survives the session but not a page reload; no
`case_graph_layout` table was built.
**Reason:** Persisting would need real schema for what was already the single biggest scope item
in that phase. Deliberately deferred rather than expanding scope mid-build.
**Source:** `PHASE3_REVIEW.md`

### #14 — Shortest-path as a bounded brute-force recursive CTE (original version)
**Choice:** `/graph/path` explored simple paths up to 6 hops via a single recursive CTE tracking
a full path array per candidate.
**Reason:** Simplest correct implementation; fine at the dataset's scale at the time (a few
dozen objects/edges).
**Status:** **Superseded by #36.** A 1M-object/5M-edge load test found this design fundamentally
doesn't scale — candidate-path count grows combinatorially with fan-out^hops when every path is
tracked separately, not just visited nodes. Named as a known limitation at the time it was
built ("needing a real algorithm... before a denser production graph would make this
expensive") — the prediction held.
**Source:** `PHASE3_REVIEW.md`

---

## Phase 4 — ingestion, entity resolution

### #15 — Ingestion runs synchronously inside the HTTP request (original version)
**Choice:** `POST /ingestion/runs` parsed, validated, and inserted every row within one HTTP
request/response cycle, one row at a time.
**Reason:** Simplest correct implementation for the phase's demonstration-scale CSVs (a few
rows, well under a second).
**Status:** **Superseded by #37 and #38.** Named as a real scale risk from the moment it was
built ("a real production-sized CSV would need to move this to a background job"). Confirmed
with real data later: 82s for 20,000 rows in one transaction, and killing the server mid-run
lost every row silently with no record the run was attempted.
**Source:** `PHASE4_REVIEW.md`, `ARCHITECTURE_AUDIT.md` §2 (named as the top critical problem area)

### #16 — Mapping templates target exactly one object type
**Choice:** A column-mapping template maps a CSV to rows of one `object_type`; no
edge-producing templates (e.g. a transactions file creating `transacted_with` edges) exist.
**Reason:** v1 scope boundary matching the blueprint's screen-by-screen spec.
**Status:** open gap, named as a near-term follow-up, not built since.
**Source:** `PHASE4_REVIEW.md`

### #17 — Entity resolution compares only against existing canonical objects, not intra-batch
**Choice:** Fuzzy matching during ingestion checks a new row against already-existing objects of
the same type. Two duplicate rows within the same upload are not compared against each other.
**Reason:** Simplest correct implementation of the "against the existing master list" half of
duplicate detection; the intra-batch half is a separate, unbuilt feature.
**Status:** open gap.
**Source:** `PHASE4_REVIEW.md`

---

## Phase 5 (S7) — admin, audit UI, export

### #18 — Evidence snapshot embeds full property values, not just object/edge IDs
**Choice:** Closing a case freezes the actual `properties`/`classification` values of every
pinned object and edge into `cases.evidence_snapshot`, not just their IDs.
**Reason:** ID-only freezing (the original Phase 1 design) stops a merge/delete from breaking
the reference but does nothing to stop a later property edit from silently changing what a
"frozen" report displays — exactly the failure mode the snapshot exists to prevent. Named as a
gap in `PHASE1_REVIEW.md`; fixed when this phase built the snapshot's first real consumer rather
than shipping a report that only half-delivers on "frozen."
**Alternatives considered:** making objects immutable once referenced by a closed case's
snapshot.
**Rejected because:** freezing a copy is simpler and doesn't constrain every other part of the
system that writes to `objects`.
**Source:** `PHASE1_REVIEW.md`, `PHASE5_REVIEW.md`

### #19 — PDF export via the browser's native print dialog, not a server-side Playwright pipeline
**Choice:** The case report PDF is "print this HTML page," not a headless-browser render
service.
**Reason:** Satisfies "the same HTML renders the in-app report and the PDF" without adding a
server dependency, for a v1 where a human is always the one exporting (no scheduled/automated
report generation exists).
**Status:** would need revisiting if automated/scheduled report generation becomes a real
requirement.
**Source:** `PHASE5_REVIEW.md`

### #20 — Redaction of frozen snapshots applied in application code, not RLS
**Choice:** For a closed case's report, classification-based redaction of the embedded
`evidence_snapshot` JSON is done by filtering in TypeScript against the viewer's clearance.
**Reason:** Postgres RLS filters rows, not values inside a `jsonb` column — there's no way to
get free redaction from the RLS-scoped connection once data is embedded in JSON rather than live
table rows. Every other endpoint in the codebase gets redaction for free from RLS; this one
genuinely can't.
**Source:** `PHASE5_REVIEW.md`, `api/src/routes/cases/lifecycle.ts`

---

## Phase 6 — hardening

### #21 — Rate limiting: single global default, not tuned per route
**Choice:** 300 req/min, one bucket, applied globally (`/health` exempted).
**Reason:** No real traffic exists yet to tune per-route limits against; a global default is
better than no limit.
**Status:** **Closed by #41.**
**Source:** `PHASE6_REVIEW.md`

### #22 — Verify security-relevant behavior over the same connection path the app actually uses
**Choice (methodology, not code):** Password rotation was verified via a real TCP `pg` connection
(the same driver path the API uses), not `docker exec psql`.
**Reason:** `docker exec psql` without `-h` uses the container's Unix socket, which the official
Postgres image trusts unconditionally regardless of `pg_hba.conf`'s password requirements for
TCP — testing that way would have "passed" whether or not rotation actually worked. Same
category of lesson as the superuser-vs-`app_user` RLS bypass (#1) and the concurrent-HTTP audit
race (#12): the tool used to verify something can silently change what's actually being tested.
**Source:** `PHASE6_REVIEW.md`

### #23 — Keycloak client keeps both PKCE and ROPC grant types (not split)
**Choice:** Did not split the one Keycloak client from #10 into a browser-only PKCE client and a
separate test/CI client during the hardening pass.
**Reason:** Splitting would break `test-rls-http.sh`/`test-audit-chain.sh` without also standing
up a second client and updating those scripts — felt like the wrong trade to make silently
inside a hardening pass.
**Status:** **Closed by #42.** Was named explicitly as the top-priority remaining item in
`SECURITY_GAP_ASSESSMENT.md`.
**Source:** `PHASE6_REVIEW.md`

### #24 — No CI pipeline stood up
**Choice:** All regression tests (`test-rls.sh`, `test-audit-chain.sh`, `test-rls-http.sh`,
Vitest, both typechecks) remain manual/local-only.
**Reason:** No shared repo/CI environment existed yet to build a pipeline in.
**Status:** **Closed by #43.**
**Source:** `PHASE6_REVIEW.md`

---

## Architecture audit — cleanup pass

### #25 — Shared parameterized `ClauseBuilder`, replacing four hand-rolled WHERE/SET builders
**Choice:** One reviewed implementation (`api/src/lib/clauseBuilder.ts`) used by `objects.ts`,
`cases.ts`, `audit.ts`, `admin.ts`, replacing four independent ~10–15 line copies.
**Reason:** Each copy could silently drift — e.g. one file's `if (value)` treating `false`/`0`
as absent while another's `if (value !== undefined)` doesn't. Verified the trickiest edge cases
live (`isActive: false` on the admin PATCH endpoint; both empty- and matching-result audit
date-range filters) rather than assuming the consolidation preserved every branch.
**Source:** `ARCHITECTURE_AUDIT.md` §4

### #26 — `usePurposeGate` shared hook, replacing three copy-pasted purpose-of-use forms
**Choice:** One hook (`web/src/lib/usePurposeGate.tsx`) used by `ObjectDetailPage`,
`CaseWorkspacePage`, `CaseReportPage`.
**Reason:** ~25 lines of duplicated state+JSX per call site, only title/placeholder text
differing. Each call site's exact original text was preserved via a parameter, not silently
normalized — including preserving the one real inconsistency (`ObjectDetailPage`'s form wasn't
horizontally centered like the other two) rather than "fixing" it as an uninvited side effect.
**Source:** `ARCHITECTURE_AUDIT.md` §4

### #27 — `router.tsx` split into per-screen files
**Choice:** `router.tsx` (496 lines, containing full page components) reduced to 65 lines of
pure route-tree wiring; every screen moved to its own file.
**Reason:** Every screen built from Phase 3 onward already followed one-file-per-screen; the
early screens hadn't been migrated, so a newcomer had to know project history to know which
convention applied where.
**Source:** `ARCHITECTURE_AUDIT.md` §4

### #28 — Rejected: a shared `authed()` wrapper for the repeated `if (!request.ctx)` check
**Choice:** Did not build a wrapper to collapse the 401-check + `withRequestContext` boilerplate
repeated 27 times across route files.
**Reason it looked worth doing:** 27 repetitions of the same two lines.
**Rejected because:** (1) `authenticate()` runs as a Fastify `onRequest` hook that replies
401/403 itself when auth fails — the route handler never runs in that case, so `request.ctx` is
guaranteed non-null wherever the check appears. It's TypeScript narrowing, not a meaningful
repeated computation; wrapping it adds indirection over a single `if`. (2) Several handlers
(most clearly `ingestion.ts`'s multipart parsing) deliberately validate *before* opening a
transaction, so a bad request never touches the connection pool. A generic wrapper that opens
the transaction first would hold a pooled connection during exactly the kind of long-running
pre-validation work the audit was elsewhere trying to get *out* of transactions — the opposite
of that pass's own conclusions.
**Source:** `ARCHITECTURE_AUDIT.md` §3

### #29 — `cases.ts` and `api.ts` named as split candidates, not split in that pass
**Choice:** Flagged both files as large/growing but did not split them during the architecture
audit.
**Reason:** Splitting a working file with no compile-time boundary between the pieces is exactly
the kind of change that's easy to get subtly wrong under a "don't change behavior" constraint —
especially `api.ts`, where splitting the flat method object into namespaces would be a real call
site change across every screen, not a pure refactor.
**Status:** **Superseded by #39** — done later, once the risk could be paid off with real
verification (real HTTP smoke tests + a live browser walkthrough as two different users) rather
than rushed inside an audit pass.
**Source:** `ARCHITECTURE_AUDIT.md` §2, §5

---

## This session — external-review-driven fixes and load testing

### #30 — `resolution_queue` RLS extended to inherit both candidate objects' classification
**Choice:** `resolution_queue_select`/`_update` policies now check that both `object_a`/
`object_b` are within the session's clearance, not just that the session has an analyst-tier
role. The app-layer `decide` handler also now checks `rowCount` on the merge `UPDATE` and fails
the whole operation (not just silently no-ops) if RLS blocks it.
**Reason:** The gap was self-documented in migration 005's own comment since Phase 0 (#1's
`case_visible()`-style oversight, but for `resolution_queue`) and confirmed exploitable: an
under-cleared reviewer could see and "merge" a RESTRICTED-classification pair, and the merge
would silently affect zero rows while the audit log and UI both reported success.
**Source:** `db/migrations/011_resolution_queue_classification_rls.sql`, `api/src/routes/resolutionQueue.ts`

### #31 — `/graph/expand` recursive CTE gets a per-node fan-out cap, not just a depth cap
**Choice:** Added `MAX_FANOUT_PER_NODE` (50), applied via a `LATERAL ... LIMIT` join inside the
recursive term, capping how many edges are followed out of any single node per hop.
**Reason:** The only prior limits were hop depth and a final row `LIMIT` applied *after* the
full expansion materialized. A hub entity (a shared address linked to thousands of accounts — a
realistic fraud-ring pattern, not a hypothetical) could force Postgres to build a combinatorially
large intermediate result before that final limit ever applied. Verified at 1M objects/5M edges:
worst case (a 49,754-degree hub node) went from a DoS risk to 30ms.
**Source:** `api/src/routes/graph.ts`

### #32 — Trigram matching switched to the `%` operator, not a bare `similarity()` call
**Choice:** Ingestion's entity-resolution match query and the object search endpoint both filter
with `(properties->>'name') % $value` (with `pg_trgm.similarity_threshold` set explicitly),
instead of `similarity(...) > threshold` in a plain `WHERE`/`ORDER BY`.
**Reason:** Postgres can only use `idx_objects_name_trgm` (a GIN index) via the `%`/`<->`
operators — a bare `similarity()` call, however it's used, can never be index-accelerated. The
prior version scored every row of the object type on every ingested row regardless of the index
that existed specifically to prevent that. Verified via `EXPLAIN`: confirmed the index is
genuinely unreachable with the old query shape, and reachable with the new one.
**Source:** `api/src/routes/ingestion.ts`, `api/src/routes/objects.ts`

### #33 — Admin route: purpose required (not defaulted), previous values logged
**Choice:** `PATCH /admin/users/:id` now requires an explicit `purpose` and logs both
`previous` and `updated` role/clearance/active-state in the audit entry.
**Reason:** Every other sensitive-access route defaults or requires purpose consistently (#7);
this one silently defaulted it, and granting RESTRICTED clearance is at least as sensitive as
reading a RESTRICTED object. The audit log also only recorded new values, not what changed from
— weakening "who changed what" reconstructability for the single most security-sensitive write
path in the app.
**Source:** `api/src/routes/admin.ts`

### #34 — Case notes/pin/unpin blocked once a case is `closed`/`archived`
**Choice:** Added a `LOCKED_STATUSES` guard (409 response) to the note, pin, and unpin
endpoints.
**Reason:** The evidence snapshot (#18) freezes the *report*, but nothing stopped the live case
record itself from being edited after "closing" — an auditor reading the case detail view could
see edits the frozen report never reflects. Left as an explicit "should this be allowed"
question rather than an accidental gap; the answer chosen was no.
**Source:** `api/src/routes/cases/workspace.ts`

### #35 — Load-tested at 1M objects / 5M edges instead of assuming scale-correctness
**Choice:** Built `db/loadtest/` (a synthetic data generator with a deliberately skewed
degree distribution to produce real hub nodes, plus a benchmark script) and ran the actual query
shapes from `graph.ts`/`objects.ts`/`ingestion.ts` against it.
**Reason:** Nothing in the project's history had verified performance at the blueprint's stated
target scale — every prior verification was against seed-scale data (a few dozen objects). "Measure,
don't assume" is the standing methodology (#22); this was the first time it was applied to raw
scale rather than correctness.
**Source:** `db/loadtest/generate.sql`, `db/loadtest/bench.sql`

### #36 — `/graph/path` rewritten as an app-level BFS, superseding #14
**Choice:** Replaced the single recursive-CTE shortest-path query with a hop-by-hop loop in
`graph.ts` that tracks only visited node IDs (not full path arrays), bounded by
`MAX_PATH_EDGES_EXAMINED` (150,000).
**Reason:** The load test (#35) proved #14's prediction correct: the CTE timed out past 30s at
6 hops on the 5M-edge graph. A fan-out cap (the fix that worked for #31) doesn't help here —
tested directly and confirmed — because path search tracks the *entire path array* per
candidate, so growth is exponential in fan-out^hops regardless of the cap, whereas node-visit
tracking only grows linearly with edges actually examined.
**Alternatives considered:** lowering `MAX_PATH_HOPS` to keep the CTE fast; a lower per-node
fan-out cap on the CTE.
**Rejected because:** both reduce correctness (missing real paths or silently capping the
feature's advertised reach) without fixing the underlying complexity class.
**Status:** **Superseded by #44.** The unidirectional version had a known, accepted completeness
limit — a fixed edge budget meant genuinely distant pairs in a very densely connected graph
could report "not found within budget" (honest, not wrong) rather than timing out. A true
bidirectional BFS was named as the fix; it was built in the next session and closed the gap.
**Source:** `api/src/routes/graph.ts`

### #37 — Ingestion chunked into per-500-row transactions with checkpointing, superseding #15
**Choice:** `POST /ingestion/runs` now processes rows in `CHUNK_SIZE` (500)-row transactions
instead of one transaction for the whole file, with `ingestion_runs`' progress counters updated
once per chunk in the same transaction as the rows they count.
**Reason:** #15's prediction confirmed with real data: a 20,000-row run in one transaction took
82s over real HTTP, and killing the server 20s in lost every row silently — even the
`ingestion_runs` tracking row itself never committed, so there was no record a run had been
attempted.
**Status:** chunking alone doesn't give crash recovery — see #38.
**Source:** `api/src/routes/ingestion.ts`

### #38 — Ingestion resumability: SHA-256 file-hash + advisory lock guarding a resume endpoint
**Choice:** Added `POST /ingestion/runs/:id/resume`. Resumes from
`records_ingested + records_quarantined` (always exactly how many rows are durably committed).
Guards: `file_hash` (new column) plus `records_total` must match the re-uploaded file; a
session-scoped Postgres advisory lock keyed by run id, held for the whole request, makes a
second concurrent attempt at the same run fail fast (409) instead of racing.
**Reason:** #37 made partial progress durable but didn't make it safe to *continue* — naively
re-POSTing the same file to `/ingestion/runs` would reprocess every row from scratch and
duplicate whatever was already ingested. Verified end to end: crashed a real 15,000-row run at
1,500 rows, resumed with the same file, confirmed exactly 15,000 total objects with zero
duplicates; confirmed a different/wrong file is rejected; confirmed two concurrent resume
attempts produce exactly one 200 and one 409.
**Source:** `db/migrations/012_ingestion_resume.sql`, `api/src/routes/ingestion.ts`

### #39 — `cases.ts` and `api.ts` split into per-domain modules, superseding #29
**Choice:** `api/src/routes/cases.ts` → `cases/{queue,workspace,lifecycle}.ts` + `shared.ts` +
`index.ts` composing the same plugin. `web/src/lib/api.ts` → `api/{types,client}.ts` + one file
per domain (objects, cases, graph, ingestion, resolutionQueue, admin, audit), composed via
spread into the identical flat object `useApiClient()` returned before.
**Reason:** Both files had grown to the size #29 predicted would eventually justify the split.
Kept the frontend split additive (same flat method names, no namespacing) specifically to avoid
the "real API surface change for every call site" risk #29 named as the reason not to do this
inside an audit pass.
**Verification:** backend smoke-tested every route group over real HTTP with a real Keycloak
token; frontend verified in an actual browser as two different real users (compliance and
admin, real PKCE login) — every screen loaded real data with zero console errors, and the audit
trail from the backend verification pass showed up correctly in the Audit screen itself,
confirming both halves interoperate end to end.
**Source:** `api/src/routes/cases/`, `web/src/lib/api/`

### #40 — Rejected: the "AI Project Improvements & Persistent Memory System" proposal
**Choice:** Declined to adopt a proposed framework (living knowledge-graph world model,
multi-agent decision-making personas, confidence/scenario engines, autonomous self-modifying
workflow) wholesale. Adopted only a lightweight decision log — this file.
**Reason:** The proposal's own example text states a mission ("Build the world's best AI-powered
Crisis Decision Platform") that isn't this project's actual mission (an AML/financial-crime
investigation tool for human compliance teams, per `README.md`, written before any code). Its
core premise — autonomous AI agents making and recording their own decisions — runs directly
against this codebase's actual, deliberately-chosen architecture: every sensitive action
requires a real human's `purpose`, tied to a real `user_id`, in an audit log designed around
human accountability (#3, #7). Most of the proposed system (world model, confidence engine,
scenario engine, multi-agent personas) describes a different product category, not an upgrade
path for this one.
**Alternatives considered:** adopting the full framework; adopting nothing.
**Rejected/accepted because:** the decision-log and session-handoff ideas are genuinely useful
practices independent of the AI-agent framing around them — this file is that piece, deliberately
kept separate from the rest of the proposal.
**Source:** this session

---

## This session — closing open items from #10/#11/#16/#17/#21/#23/#24/#36

### #41 — Per-route rate limiting on the two expensive endpoints, closing #21
**Choice:** `POST /ingestion/runs`, `POST /ingestion/runs/:id/resume` (10/min), and
`GET /cases/:id/report` (20/min) now override the 300/min global default via Fastify's
per-route `config.rateLimit`.
**Reason:** Both hold a pooled connection through multiple sequential/chunked queries per
request, unlike a cheap `/search` call — exactly the routes #21 named as needing tighter limits
once a real prioritization pass happened.
**Verified:** live response headers confirmed `x-ratelimit-limit: 300` on `/objects`,
`20` on the report endpoint, `10` on both ingestion endpoints.
**Source:** `api/src/routes/ingestion.ts`, `api/src/routes/cases/lifecycle.ts`

### #42 — Split the Keycloak client into a browser-only PKCE client and a test-only ROPC client, closing #10/#23
**Choice:** `platform-api` (the real browser client) now has `directAccessGrantsEnabled: false` —
PKCE/Authorization Code only. A new `platform-test` client (`standardFlowEnabled: false`,
`directAccessGrantsEnabled: true`) is used exclusively by `api/scripts/test-rls-http.sh`.
**Reason:** Named as the top-priority remaining item in `SECURITY_GAP_ASSESSMENT.md` since
Phase 6 — a public client that both a real browser and a bare backend script can obtain tokens
from is a wider credential-acquisition surface than the browser flow alone needs.
**Verified live**, not just by editing the realm export: `grant_type=password` against
`platform-api` now returns `unauthorized_client` / "Client not allowed for direct access
grants"; the same request against `platform-test` succeeds; a full real PKCE browser login
(Sam Supervisor, real Keycloak redirect, real callback) against `platform-api` still works
end to end with zero console errors; `test-rls-http.sh` re-run against the split clients still
passes every check.
**Source:** `keycloak/realm-export.json`, `api/scripts/test-rls-http.sh`

### #43 — GitHub Actions CI pipeline, closing #24
**Choice:** `.github/workflows/ci.yml` runs the exact same sequence a developer runs locally per
`README.md` — `docker compose up`, `migrate.sh`, `seed.sh`, both typechecks, Vitest,
`test-rls.sh`, `test-audit-chain.sh`, start the API server, `test-rls-http.sh` — rather than a
parallel CI-specific setup that could drift from what's actually documented.
**Reason:** Named as "mechanical, not risky" since the scripts already existed and already
worked; the only reason it wasn't done earlier was no shared repo/CI environment existed to
build it in.
**Verified:** ran the entire sequence locally against a genuinely fresh environment first
(`docker compose down -v`, full recreate) rather than trusting the YAML would work — every step
passed, including a fresh 12-migration apply that the existing local dev DB (already migrated)
couldn't have exercised.
**Source:** `.github/workflows/ci.yml`

---

## Next session — closing more open items (#11, #16, #17, #36)

### #44 — `/graph/path` rewritten as bidirectional BFS, closing #36
**Choice:** Replaced the unidirectional BFS (#36) with two BFS trees — one rooted at `from`,
one at `to` — expanded one full level at a time in **strict alternation**, stopping the instant
a node discovered by one side is already known to the other.
**Reason:** Unidirectional BFS fixed the CTE's timeout but had a real completeness gap: the last
hop before reaching a distant target in a small-world graph is often as expensive as every
previous hop combined, since frontier size grows near-exponentially per hop. Searching from both
ends means each side only needs to reach about half the total hop distance — exponentially
cheaper than one side covering the whole distance.
**Alternatives considered:** the more common "always expand whichever frontier is smaller"
heuristic instead of strict alternation.
**Rejected because:** strict alternation gives a shortest-path guarantee for free (both sides'
completed-level counts never differ by more than one, so the first meeting point found is
provably shortest); a size-based heuristic would need extra bookkeeping to keep that same
guarantee, and getting that bookkeeping subtly wrong is exactly the kind of bug this whole
`/graph/path` history (#14 → #36 → #44) has already been burned by twice.
**Verified** against the same 1M-object/5M-edge graph #36 was measured on, not just unit-tested
in isolation: 10/10 random pairs found within the same edge budget that only found 1/10 under
unidirectional search; worst-case latency dropped (551ms vs 1.34s) despite finding far more
paths; the specific case that defeated a fan-out cap on the unidirectional version — starting
from a 50,031-degree hub node — now succeeds in ~1.3s instead of failing outright, since the hub
only has to expand from one side while the other side's much smaller frontier does the rest.
Also verified: the known 2-hop seed-data path from `PHASE3_REVIEW.md` still resolves correctly,
a directly-connected pair reports exactly `hops: 1` (not an off-by-one from the meeting-point
logic), and the trivial `from === to` case still short-circuits correctly.
**Source:** `api/src/routes/graph.ts`

### #45 — Edge-mapping ingestion templates, closing #16
**Choice:** A new `edge_mapping_templates` table and `POST/GET /ingestion/edge-templates`
alongside the existing object-mapping templates. An edge template never creates objects — each
row must match an already-existing source and target object (by a configured property) via its
own template, or the row quarantines. `POST /ingestion/runs` now accepts `edgeTemplateId` as an
alternative to `templateId` (exactly one required); `ingestion_runs` gained a nullable
`edge_template_id` column with a check constraint enforcing exactly one of the two is set.
**Reason:** Named since `PHASE4_REVIEW.md`: "there's no way to ingest a CSV that creates edges
(e.g., a transactions file mapping to `transacted_with` relationships between two existing
accounts)... the seed data itself models transactions as edges." This was the one ingestion gap
that was a missing capability, not a tuning/scale problem like the others closed so far.
**Design note:** deliberately no auto-merge/entity-resolution equivalent for edge rows — there's
nothing to merge when the row either matches an edge endpoint or it doesn't. Reuses the exact
same chunking/checkpointing/resume infrastructure (#37/#38) as object ingestion, since the
`records_ingested + records_quarantined` resume math doesn't care what kind of row was counted.
**Verified** against real accounts in the seed data: a 3-row CSV (two valid transactions, one
referencing a nonexistent account) produced exactly 2 edges with correctly mapped properties and
classification, and 1 quarantined row with a precise "no matching target object" error. Also
crashed a real 3,000-row edge-ingestion run at 1,000 rows and resumed it with the same file:
completed at exactly 3,000 total edges, confirmed zero duplicates by direct count.
**Source:** `db/migrations/013_edge_mapping_templates.sql`, `api/src/routes/ingestion.ts`

### #46 — Ingestion processing moved off the request/response cycle (PRD v1.1 B6)

**Choice:** `POST /ingestion/runs` (both create paths) and `POST /ingestion/runs/:id/resume` now
return `202` with the freshly created/resumed run (status `running`, counters at their starting
values) as soon as the run row exists, instead of awaiting `runIngestionChunks`/
`runEdgeIngestionChunks` to completion first. The actual chunk processing — unchanged from
#37/#38 — runs after the response is sent; its outcome (including marking the run `failed`) is
handled entirely inside that detached execution, since nothing is listening on an HTTP response
by the time it finishes. `web/src/IntakePage.tsx`'s runs list now polls every 2s while any run is
`pending`/`running`, since the upload response itself no longer carries final counts.

**Reason:** #37 made a large run resumable and crash-safe, but never addressed the PRD's actual
complaint: a real 20,000-row run still held one HTTP request (and, transitively, the client's
connection) open for however long the whole file took — 82s in #37's own measurement, worse for
a partner-sized 50k-row file. Chunking already released the *processing* connection between
chunks; the request/response lifecycle was the one piece still coupled to total run duration.

**Design note:** the per-run advisory lock (#38) had to be split into an explicit
acquire/release (`tryAcquireRunLock`) rather than the previous single `withRunLock(id, fn)`
helper that acquired, ran, and released as one unit. A real concurrent second attempt at the same
run must still get an immediate `409` — verified behavior worth keeping — which requires
learning synchronously whether the lock was won, before deciding to hand off the rest to the
background.

**Verified** against a real 20,000-row upload over HTTP: the request returned in ~70ms (`202`,
`records_ingested: 0`) instead of blocking; concurrent `GET /ingestion/runs` and `GET /objects`
calls issued while that run was actively processing completed in 2-20ms throughout, confirming
the connection pool wasn't starved; a second, independent run started and ran to `completed`
while the first was still mid-flight; the web UI reflected both runs' progress live via polling
with no manual refresh, matching what a browser session would actually observe during a pilot.
**Source:** `api/src/routes/ingestion.ts`, `web/src/IntakePage.tsx`

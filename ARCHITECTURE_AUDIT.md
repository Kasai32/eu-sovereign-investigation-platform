# Architecture audit — a fresh read of the codebase

Written as a senior engineer's onboarding pass: reverse-engineer the system from the code
itself (not from the phase-review changelogs), map the real data flow, name the actual problems
with file:line evidence, then fix the highest-value ones without changing behavior. Every claim
below was checked against the running code, not inferred from commit messages.

## 1. Architecture, reverse-engineered

Three tiers: a React SPA, a Fastify REST API, and Postgres (with RLS as the actual enforcement
layer) plus Keycloak for identity.

```
Browser (React + TanStack Router/Query)
  │  fetch() with Authorization: Bearer <Keycloak JWT>
  ▼
Fastify API (api/src/index.ts)
  │  helmet → cors → rate-limit → multipart
  │  onRequest hook: authenticate() (api/src/auth.ts)
  │    1. verify JWT against Keycloak's JWKS
  │    2. look up role/clearance fresh from app_users by email  ← NOT from the token
  │    3. attach request.ctx = { userId, actorRole, clearance }
  ▼
Route handler
  │  withRequestContext(ctx, fn)  (api/src/db.ts)
  │    BEGIN
  │    SELECT set_config('app.current_user_id', ...), set_config('app.actor_role', ...),
  │           set_config('app.current_clearance', ...)
  │    fn(client)   ← the route's actual query/queries run here
  │    COMMIT (or ROLLBACK on throw)
  ▼
Postgres, RLS-enforced
  │  Every classified table has FORCE ROW LEVEL SECURITY. Policies compare the row's own
  │  `classification` column against current_setting('app.current_clearance'). The app
  │  connects as a dedicated `app_user` role — never the migration superuser — which is the
  │  one fact the whole security model depends on (see PHASE0_REVIEW.md).
  ▼
JSON response → TanStack Query cache → render
```

**The two architectural decisions that actually matter, both deliberate and both hold up:**

1. **RLS is the enforcement layer, not app code.** Route-level role checks
   (`if (request.ctx.actorRole !== "admin")`) exist too, but they're defense-in-depth — proven
   by `db/scripts/test-rls.sh`, which diffs real query results between sessions rather than
   reading policy SQL.
2. **AuthN and AuthZ are split.** Keycloak proves identity; `app_users` (not the JWT) is the
   source of truth for role/clearance, re-read on every request. This means deactivating a user
   takes effect on their next request, not at token expiry — verified live in `PHASE5_REVIEW.md`
   by actually rotating a user's clearance and watching it take effect without a new login.

Everything below is either a genuine problem in that architecture or duplication that grew
around it as the screen count went from 0 to 11 across six build phases.

## 2. Problems found (grounded, with evidence)

### Bad architecture decisions

**Long-held pooled connections combined with sequential N+1 queries, against a pool of 10.**
`withRequestContext()` (`api/src/db.ts:40`) checks out one connection from a 10-connection pool
for the *entire* duration of the handler function — every query the handler runs, sequentially,
holds that same connection. This is fine for a handler that runs 2-3 queries. It's a real risk
for `POST /ingestion/runs`, which (before today) ran a nested loop issuing one query per
property per row with no batching — a 1,000-row CSV with 5 mapped columns held one pooled
connection for roughly 6,000 sequential awaited round trips. Under concurrent load, one large
upload could starve the other 9 connections for the entire duration of that request. **Fixed
this session** (see §4) by batching the per-property inserts; the deeper fix (moving ingestion
off the request/response cycle entirely, onto a background job) is named as follow-up work, not
attempted here — it changes the API contract (the client would poll a job status instead of
getting a synchronous response), which is out of scope for "improve quality without changing
functionality."

### Duplicate logic

- **Four independent hand-rolled WHERE/SET clause builders**, same `conditions: string[]` /
  `params: unknown[]` / `.push()` / `.join()` pattern, in `objects.ts`, `cases.ts`, `audit.ts`,
  and `admin.ts` (the SET-clause variant). Real risk: each copy could silently drift — e.g. one
  file's `if (value)` treats `false`/`0` as absent while another's `if (value !== undefined)`
  doesn't, which is exactly the kind of bug that only shows up for a boolean or zero value nobody
  tested. **Fixed this session** — see §4.
- **The purpose-of-use gate** (state + ~25 lines of form JSX) was copy-pasted three times
  (`ObjectDetailPage`, `CaseWorkspacePage`, `CaseReportPage`) with only the title/placeholder
  text differing. **Fixed this session** — see §4.
- **The `if (!request.ctx) return reply.code(401)...` line appears 27 times** across 8 route
  files. Looked like the obvious next duplication to extract — investigated instead of
  reflexively abstracting it, and concluded it *shouldn't* be extracted (see §3, "a refactor
  considered and rejected").

### Performance bottlenecks

- `api/src/routes/ingestion.ts` (pre-fix): O(rows × mapped-columns) sequential DB round trips.
  **Fixed.**
- `api/src/routes/resolutionQueue.ts` (pre-fix): up to 3 queries per pending pair, up to 300
  round trips for a full 100-pair queue page. **Fixed.**
- `web/src/components/GraphCanvas.tsx`: re-runs the full `cose` force-directed layout on *any*
  node/edge addition, including an expansion that adds one node to an already-arranged graph —
  recomputes positions for nodes the analyst may have manually dragged. Already named in
  `PHASE3_REVIEW.md`; still present. Not fixed this session — the correct fix (only lay out
  newly-added nodes, pin existing ones) is a real behavior change to the graph's visual settling
  behavior, which crosses the "don't change functionality" line for what's meant to be a
  pure-refactor pass.

### Scalability risks

- Ingestion runs synchronously inside the HTTP request. Request timeout and event-loop
  contention both scale linearly with file size — there's no queue, no chunking, no progress
  polling. Named in `PHASE4_REVIEW.md`, not addressed (see the "long-held connections" note
  above for why not this session).
- A single global rate-limit bucket (300/min, added in Phase 6) doesn't distinguish cheap routes
  (`/search`) from expensive ones (`/ingestion/runs`, `/cases/:id/report`). Untuned because there's
  no real traffic yet to tune against — named in `PHASE6_REVIEW.md`.
- `object_property_meta` grows without bound (one row per property per ingested object, forever)
  with no partitioning or archival strategy. Fine at synthetic-dataset scale; a real deployment
  ingesting real volumes would need this addressed before it becomes a problem, not after.

### Maintainability issues

- **`router.tsx` was 496 lines** containing 4 full page components (`RootLayout`, `SearchPage`,
  `ObjectDetailPage`, `CasesPage`) plus all route-tree wiring, while every other screen built
  from Phase 3 onward got its own file. A newcomer had to already know the codebase's history to
  know which convention applied where. **Fixed this session** — see §4.
- **`web/src/lib/api.ts` (369 lines) hand-duplicates ~24 response-shape types** as parallel
  TypeScript interfaces that have no compile-time link to the actual SQL `SELECT` column lists
  in the route files. Renaming a column in `cases.ts`'s query wouldn't fail the build; it would
  silently produce `undefined` at runtime, caught only by a human reading a screen. Not fixed
  this session — the correct fix (generating types from the schema, or a shared type-checking
  layer like tRPC/Zod schemas at the API boundary) is a real architectural addition, not a
  refactor of what exists.
- `api/src/routes/cases.ts` is the largest route file (445 lines / 8 endpoints), mixing case
  CRUD, notes, entity pinning, status transitions, and report generation. Functionally coherent
  (it's all "things you do to a case") but a candidate for splitting once it grows further.
  Named, not split — splitting a working file with no compile-time boundary between the pieces
  is exactly the kind of change that's easy to get subtly wrong under a "don't change behavior"
  constraint, so it's flagged rather than force-fit into this pass.

## 3. A refactor considered and rejected

Before touching anything, the plan included a shared `authed()` wrapper to collapse
`if (!request.ctx) return reply.code(401)...` plus the `withRequestContext(request.ctx, async
(client) => {...})` boilerplate into one call, since it's repeated 27 times.

Two things killed it on inspection:

1. **It's not actually duplication worth collapsing.** `authenticate()` (`api/src/auth.ts`) is
   registered as an `onRequest` hook. When it replies 401/403 itself, Fastify's lifecycle never
   calls the route handler at all — so `request.ctx` is guaranteed non-null in every handler
   that actually runs. The one-line check is TypeScript narrowing plus a fail-safe, not a
   meaningful repeated computation. Wrapping it doesn't reduce complexity; it adds a layer of
   indirection over a single `if`.
2. **Collapsing the transaction-open timing would be a real behavior change.** Several handlers
   (most clearly `ingestion.ts`'s multipart file parsing) deliberately do work — parsing the
   upload, validating the body — *before* opening a transaction, so a bad request fails without
   ever touching the connection pool. A generic wrapper that opens the transaction first and
   validates inside it would hold a pooled connection open during exactly the kind of
   long-running, pre-validation work this audit is elsewhere trying to get *out* of the
   transaction (see the ingestion N+1 fix). That's the opposite of the fix this document
   recommends elsewhere — building the wrapper would have quietly worked against the rest of
   the audit's own conclusions.

Recorded here because "don't abstract this" is itself a decision worth being able to trace back
to a reason, the same way "do abstract this" would be.

## 4. What was actually fixed this session (verified, not just described)

All four changes below were typechecked, and the full regression suite
(`db/scripts/test-rls.sh`, `db/scripts/test-audit-chain.sh`,
`api/scripts/test-rls-http.sh`, the Vitest suite, both typechecks) was re-run clean after each
one. Two of them were also verified against real data through the actual HTTP/browser path, not
just the test suite — see the inline notes.

| Fix | Files | Before → after |
|---|---|---|
| Shared parameterized clause builder | `api/src/lib/clauseBuilder.ts` (new, 57 lines), applied in `objects.ts`, `cases.ts`, `audit.ts`, `admin.ts` | 4 independent ~10-15 line hand-rolled builders → 1 shared, reviewed implementation. Verified the trickiest edge cases live: `isActive: false` on the admin PATCH endpoint (must not be treated as "absent" — confirmed it isn't), and the audit log's `from`/`to` date-range filters (confirmed both an empty-result and a matching-result case). |
| Batched `object_property_meta` inserts | `api/src/routes/ingestion.ts` | O(rows × columns) sequential inserts → O(rows) — one multi-row `INSERT` per ingested object instead of one `INSERT` per property. Re-ran the exact 4-row CSV from `PHASE4_REVIEW.md`'s original verification (one auto-merge, one queued ambiguous match, one quarantine, one clean insert) and got byte-identical counts and per-object property rows to the pre-fix behavior. |
| Batched resolution-queue enrichment | `api/src/routes/resolutionQueue.ts` | Up to 3 queries per pending pair → 2 queries total for the whole page, regardless of pair count. The neighbor query is a `UNION ALL` from both edge directions so two candidates directly connected to each other still each see the other as a neighbor, matching the old per-object query's behavior exactly. Verified against a real ambiguous-match pair (Jordan Vance / Jordan Vence from the seed data) — identical `neighborsA`/`neighborsB` output to the pre-fix version, confirmed via the live `/resolution-queue` response. |
| `usePurposeGate` hook | `web/src/lib/usePurposeGate.tsx` (new, 55 lines), applied in `ObjectDetailPage.tsx`, `CaseWorkspacePage.tsx`, `CaseReportPage.tsx` | 3 × ~25 lines of duplicated state+JSX → 1 hook. Each call site's exact original title/placeholder/description text (and the one real inconsistency — `ObjectDetailPage`'s form wasn't horizontally centered like the other two) was preserved via a `containerClassName` parameter, not silently normalized. Verified live in the browser: the existing `CaseWorkspacePage.test.tsx` integration test (which exercises this exact flow via `findByPlaceholderText`) passes unmodified, and `ObjectDetailPage`'s gate was checked directly in a browser — identical layout, identical submit behavior. |
| Split `router.tsx` into per-screen files | `router.tsx`: 496 → 65 lines. New: `Layout.tsx`, `AuthCallbackPage.tsx`, `SearchPage.tsx`, `ObjectDetailPage.tsx`, `CasesPage.tsx` | Every screen now lives in its own file, matching the convention every screen built from Phase 3 onward already followed. `router.tsx` is now pure route-tree wiring — a newcomer can read it top to bottom as a table of contents. Verified live: Search, Cases, and the full case workspace (graph, notes, "Export report" link) all re-checked in a real browser session post-split, identical to pre-split screenshots. |

## 5. Clean architecture breakdown (target state, partially realized above)

```
api/src/
  index.ts                 composition root: plugins, route registration, listen
  auth.ts                  authenticate() — AuthN only
  db.ts                    pool + withRequestContext() — the one place transactions/RLS
                            session vars get set
  audit.ts                 writeAudit() — the one write path to audit_log
  objectValidation.ts      schema validation for ingested/written object properties
  lib/
    clauseBuilder.ts        ✅ shared WHERE/SET builder (done this session)
    [future] jobQueue.ts    background processing for ingestion — not built, named as the
                            correct next step once request-cycle-bound ingestion becomes a
                            real problem rather than a theoretical one
  routes/
    *.ts                    one file per resource, each importing withRequestContext +
                            clauseBuilder + writeAudit rather than reimplementing any of them

web/src/
  main.tsx                 composition root: providers + RouterProvider
  router.tsx                ✅ pure route-tree wiring (done this session)
  Layout.tsx, *Page.tsx      ✅ one file per screen (done this session)
  lib/
    api.ts                  fetch client — candidate for splitting into per-domain modules
                            (objects.ts, cases.ts, ingestion.ts, admin.ts client namespaces)
                            once it grows past its current ~30 methods; not done, since
                            splitting a working flat object into namespaces is a real API
                            surface change for every call site, not a pure refactor
    usePurposeGate.tsx        ✅ shared hook (done this session)
    auth.ts, AuthContext.tsx, pkce.ts   OIDC/PKCE, unchanged — already well-factored
  components/
    GraphCanvas.tsx, ClassificationBadge.tsx   shared UI primitives, unchanged
```

## 6. Critical problem areas, ranked

1. **Ingestion's request-cycle-bound processing model** (§2, scalability risks). The batching
   fix in this pass reduces query *count* but doesn't change the fact that a large file still
   ties up one HTTP request and one pooled connection for the whole upload. This is the one
   finding in this document that needs a real design decision (background job + polling
   endpoint), not a mechanical refactor — flagged as the top item for the next phase of work,
   not attempted here.
2. **`api.ts` type/query drift** (§2, maintainability). No compile-time link between the
   frontend's hand-written response types and the backend's actual `SELECT` lists. Low
   probability per change, real cost when it happens (silent `undefined`, not a build failure).
3. **GraphCanvas's full-relayout-on-any-change behavior** (§2, performance). Only matters once
   cases have graphs large enough to notice, but the fix touches the graph's felt interaction
   quality, so it deserves a deliberate design pass (with an analyst's actual usage in mind),
   not a drive-by fix.

## 7. Refactoring strategy for what's left

- **Ingestion**: introduce a job queue (pg-boss is the lowest-friction choice — it's just
  Postgres tables, no new infrastructure to run) and change `POST /ingestion/runs` to return
  `202 Accepted` with a run ID immediately, with the existing `GET /ingestion/runs` polling for
  status. This is an API contract change, needs sign-off before starting.
- **`api.ts`**: either (a) generate TypeScript types from the Postgres schema (e.g.
  `kanel`/`pg-to-ts`) so a column rename fails the build, or (b) introduce a schema-validation
  layer (Zod) at the route boundary that both validates responses server-side and exports
  matching types client-side. (b) is more work but also closes the `objectValidation.ts` gap
  named in `PHASE4_REVIEW.md` (minimal validation, no format checks) as the same change.
- **`GraphCanvas`**: track which node IDs are "new since last layout" and pass only those to a
  targeted layout call (Cytoscape supports laying out a subset while leaving the rest fixed),
  rather than re-running `cose` over the whole graph. Needs a quick check with a real analyst
  workflow before shipping — "does re-layout on expand feel expected or jarring" is a product
  question as much as a performance one.

## 8. What this audit deliberately did not touch

Database schema, RLS policies, the audit hash chain, Keycloak configuration, and all
observable API/UI behavior are unchanged — every fix above is a refactor in the strict sense
(same inputs produce the same outputs, verified against real data and the existing test suite,
not just typechecked). Anything that would have changed an API response shape, a UI layout
beyond preserving an existing inconsistency, or a query's result set was named as a
recommendation instead of executed silently inside a "just cleanup" pass.

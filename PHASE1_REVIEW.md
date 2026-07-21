# Phase 1 self-review

Scope built: Fastify API with real Keycloak authentication, `objects`/`graph`/`cases`/`audit`
routes, all RLS-scoped through `withRequestContext()`. Verified live against a running Keycloak
+ Postgres stack via `api/scripts/test-rls-http.sh` — real password-grant logins as four
differently-privileged seed users, real HTTP responses diffed, not inferred from route code.

## Two real bugs found and fixed while verifying (not by inspection)

- **RLS policy infinite recursion.** `cases_select` referenced `case_members` in an `EXISTS`
  subquery, and `case_members_select` referenced `cases` back — Postgres rejected this outright
  (`42P17 infinite recursion detected in policy for relation "cases"`) the moment a real request
  tried to open a case. Found by actually calling `GET /cases/:id`, not by reading the SQL.
  Fixed in `db/migrations/006_fix_case_rls_recursion.sql` with a `SECURITY DEFINER` helper
  function (`case_visible()`) that both `cases` and every case-child table's policies call
  instead of querying each other directly, breaking the cycle.
- **`INSERT ... RETURNING` against a self-referencing RLS function.** After fixing the
  recursion, case creation and note creation still failed with "new row violates row-level
  security policy" — but only when using `RETURNING`, not on a plain `INSERT`. Root cause:
  `case_visible()` is `STABLE`, so its snapshot is fixed at statement start and can't see a row
  the same `INSERT` statement is still in the middle of creating; Postgres's RETURNING
  visibility re-check then fails even though the `WITH CHECK` already passed. `UPDATE ...
  RETURNING` doesn't hit this (the row already existed before the statement began). Fixed by
  generating the id client-side, inserting without `RETURNING`, then reading the row back with
  a separate `SELECT` in the same transaction — a new statement gets a snapshot that includes
  what the prior statement just committed within the transaction. This is a genuine, easy-to-hit
  interaction between RLS and self-referencing policy functions; worth remembering before
  writing any future `INSERT ... RETURNING` against a table whose SELECT policy calls a
  function that re-queries that same table.

Neither of these would have been caught by reading the migration files or route code — both
only surfaced by actually running requests through the real stack, which is exactly why the
build prompt insists on "verify, don't just claim."

## Design choices worth flagging

- **AuthN/AuthZ split.** Keycloak proves identity; `app_users` (role, clearance, `is_active`) is
  the sole source of authorization data, looked up fresh on every request rather than trusted
  from JWT claims. This means deactivating a user via the (not-yet-built) S7 admin screen takes
  effect on their very next request, without waiting for token expiry or a Keycloak sync. It
  also means a compromised or misconfigured Keycloak realm can prove identity but can't grant
  access the `app_users` table doesn't also grant — a deliberate second gate, not just belt-and-
  suspenders.
- **Membership does not override classification.** Confirmed live: Alice (analyst, `INTERNAL`
  clearance) is a `case_members` row on the seed case, which is classified `SENSITIVE` — she
  still gets a 404 opening it. This is intentional (`cases_select`'s policy `AND`s classification
  with membership, doesn't `OR` them) and is exercised on purpose in
  `api/scripts/test-rls-http.sh`, not an accident of the seed data. Worth surfacing to a real
  reviewer: it means assigning an analyst to a case above their clearance silently locks them
  out of it rather than erroring at assignment time — a real product needs to either block that
  assignment up front or surface it clearly in the UI, which doesn't exist yet.
- **404, not 403, for classification-blocked cases.** Deliberate: a 403 on `/cases/:id`
  confirms the case exists; 404 doesn't. Consistent with not letting an unauthorized user learn
  anything from the fact of a resource's existence.
- **Purpose-of-use is required, not defaulted, for meaningful access moments** — entity detail,
  case detail, case writes, and the audit log itself all reject a missing `purpose`. List/browse
  endpoints (`GET /objects`, `GET /cases`) default it instead of blocking, since requiring a
  written justification for every paginated list view would make the product unusable without
  adding real audit value. This is a judgment call, not settled by the build prompt's text —
  flagging it explicitly rather than letting it look like an oversight.
- **Fastify was bumped from ^4 to ^5** during `npm install`, since the 4.x line had an open
  high-severity advisory (`GHSA-jx2c-rxcm-jvmq`, Content-Type validation bypass) with no non-
  breaking fix. Taken now, while the route surface is three files, rather than later.

## What's fragile

- **The evidence snapshot on case close is object/edge IDs only**, not a copy of their property
  values at that moment. If an object's properties are edited after the case closes, the
  snapshot's IDs still resolve to the *current* (changed) property values, not what the analyst
  actually saw. The build prompt's intent ("closing freezes... so later data changes don't
  silently rewrite a finalized report's basis") is only half met — id-level freezing stops a
  merge/delete from breaking the reference, but doesn't stop a property edit from changing what
  those IDs display. Needs a real decision before this matters: snapshot full property values,
  or make objects effectively immutable once referenced by a closed case's snapshot.
- **No automated test for the two bugs above** — they were caught and fixed manually via
  `curl`/`psql` during this session, but `test-rls-http.sh` doesn't specifically exercise case
  creation or note creation. A regression here (e.g., someone reintroducing `RETURNING` on an
  affected table) wouldn't be caught by the current test suite.
- **`case_visible()` duplicates `cases_select`'s classification+membership logic** inline; if
  that logic changes, both the function and any place still using it directly need updating
  together. Low risk right now since `cases_select` itself now just calls the function, but
  worth remembering if `cases_update`/`cases_insert` ever need the same membership-aware logic
  (currently they only check classification, not membership, which is arguably correct — anyone
  cleared for the classification can create a case, only visibility of *existing* cases needs
  the membership check).
- **Keycloak realm uses Resource Owner Password Credentials (direct access grants)** for local
  dev/testing convenience — there's no frontend yet, so this is the only practical way to
  acquire a token for testing. Production needs Authorization Code + PKCE from the real frontend
  once Phase 2 builds it; the realm config should have `directAccessGrantsEnabled` turned off for
  the client at that point, or split into a dev-only client and a real browser client.
- **No rate limiting, no request size limits, no CORS policy configured yet** on the Fastify app
  — fine for a solo-developer localhost API, not fine to carry into any shared environment.

## Deferred, and why

Ingestion (S5), entity-resolution review UI (S6), admin/audit UI (S7 frontend — the `/audit`
*route* exists, no screen consumes it yet), and all actual UI screens are Phase 2+ per the
blueprint's build order. Nothing was skipped inside Phase 1's own scope; everything above is
either a genuine bug (now fixed) or a named, deliberate boundary.

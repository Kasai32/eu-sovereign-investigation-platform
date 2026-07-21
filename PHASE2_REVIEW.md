# Phase 2 self-review

Scope built: React frontend (`web/`) covering S3 (search), S4 (entity detail), S1 (case queue),
per the blueprint's own Phase 2 split — S2's full graph workspace stays Phase 3. Verified in an
actual browser via `claude-in-chrome`, not just `npm run typecheck` — logged in as two different
real users (Sam/supervisor, Alice/analyst), exercised search, entity detail with the purpose-of-
use gate, case creation, sign-out/sign-in, and confirmed the RLS boundary is visible correctly
in the rendered UI, not just in raw JSON.

## What was verified live

- **PKCE flow end to end**: sign-in redirects to Keycloak with a real `code_challenge`/
  `code_challenge_method=S256` (screenshotted, not assumed), login succeeds, callback exchanges
  the code, lands back on `/search` authenticated.
- **RLS visible in the actual UI**: Sam (supervisor, `SENSITIVE`) sees `SENSITIVE`/`INTERNAL`/
  `PUBLIC` objects; Alice (analyst, `INTERNAL`) sees only `INTERNAL`/`PUBLIC` — same search
  screen, different real sessions, different rendered rows.
  Also: Alice's case queue shows "No cases" — correctly excluding the `SENSITIVE` seed case she's
  a `case_members` row on but isn't cleared to see (browser-level confirmation of the
  membership-does-not-override-classification behavior documented in `PHASE1_REVIEW.md`).
- **Purpose-of-use gate**: opening an entity's detail page shows a required "reason for viewing"
  form before any data loads; submitting it actually reaches the audit log — confirmed by
  querying `/audit` afterward and finding the exact typed purpose text attached to the right
  user and object.
- **Case creation**: `POST /cases` from the UI, list re-fetches via React Query invalidation,
  new case appears with correct default status/priority/classification.
- **Real SSO logout**: signing out redirects to Keycloak's actual logout confirmation page and
  back, not just a client-side token clear.

## An operational hiccup worth recording

Mid-session, the local dev audit log carried a broken hash chain — but this was the *expected*
leftover of Phase 0's `test-audit-chain.sh` deliberately tampering a row to prove
`verify_audit_log()` catches tampering, not a new bug. It surfaced when checking `/audit` after
the browser walkthrough. Reset by dropping the `pgdata` Docker volume and re-running
`migrate.sh` + `seed.sh` (Keycloak untouched, so the browser session survived the reset —
useful confirmation that Postgres state and Keycloak session state are properly decoupled).
Worth a `db/scripts/reset.sh` convenience wrapper before this trips someone up again; not built
yet.

## Design choices worth flagging

- **Real Authorization Code + PKCE for the browser**, not the password-grant shortcut used in
  `test-rls-http.sh`/`test-audit-chain.sh`. Those two remain intentionally ROPC-based since
  they're backend test scripts with no browser involved — the realm's
  `directAccessGrantsEnabled: true` stays on for that reason. A real deployment should split
  this into a browser-only client (PKCE, no ROPC) and a separate CI/test-only client, rather
  than one client doing both.
- **Tokens live in `sessionStorage`**, not an httpOnly cookie. Deliberate tradeoff for this
  phase (no backend-for-frontend exists to set httpOnly cookies), explicitly flagged as an XSS
  exposure in `web/src/lib/auth.ts`'s own comments. A pre-production hardening pass should
  revisit this — it's the single biggest frontend security gap right now.
- **Object display names fall back to raw UUIDs** for types without a `name` property (Account,
  Location, Device, Alert) — visible directly in the Sam-logged-in screenshot ("Account
  a0000000-...-000000000021" instead of something like "...4821 · Meridian Bank NV"). Not a
  security issue, but a real analyst would immediately flag search results that look like that.
  Needs a per-object-type display-label convention before this is usable, not just cosmetic
  polish.
- **No case detail/workspace route exists yet** (S2, Phase 3) — case titles in the queue are
  plain text, not links, so there was nothing to click through to. This is a deliberate scope
  boundary, not an oversight; flagged here so it doesn't look like a missing feature slipped
  through.

## What's fragile

- **No loading/error boundary beyond per-query `isLoading`/`error` checks** — a network failure
  or unexpected API shape shows a plain text message inline, no retry affordance, no global
  error boundary. Fine for three simple screens, will need real handling once S2's graph canvas
  (Cytoscape) and S5/S6 (ingestion, resolution queue) add more failure surface area.
- **`useApiClient()` rebuilds its method object on every `getValidAccessToken` identity
  change** — harmless today (three simple screens), but worth remembering if this grows: every
  consumer re-renders when the token refreshes, not just the ones mid-request.
- **The search screen's "type" filter list is hardcoded** in `router.tsx`
  (`OBJECT_TYPES`) rather than fetched from `GET /object_types` (no such endpoint exists yet).
  Adding a new object type via the (not-yet-built) admin screen wouldn't show up in search
  filters without also touching this frontend constant — contradicts the ontology's own
  "object types are data, not code" principle. Worth fixing before Phase 2's S5 (ingestion)
  makes new object types a routine occurrence rather than a schema-migration event.
- **No CORS allowlist beyond a single hardcoded origin** (`http://localhost:3000`) — correct for
  solo local dev, needs real per-environment config before any shared deployment.

## Deferred, and why

S2 (case workspace + graph canvas), S5 (ingestion), S6 (entity-resolution review UI), and S7's
actual admin/audit screens (the `/audit` API route exists, unused by any UI yet) are Phase 3+
per the blueprint's own build order. Nothing was skipped inside Phase 2's declared scope.

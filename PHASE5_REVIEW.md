# Phase 5 (S7) self-review

Scope built: admin user management (role/clearance/active-status editing), the audit log
viewer (filterable, with a live chain-verification badge), and case export — the blueprint's
"headline feature" — as a printable HTML report plus a Markdown download. All three verified
live in the browser as a real admin user, not just via curl.

## What was verified live

- **Admin clearance edit takes effect immediately**: changed Alice's clearance from `INTERNAL`
  to `SENSITIVE` via the Users screen, then re-authenticated as Alice with her *existing*
  password and confirmed her very next `/objects` call returned `SENSITIVE` rows — proving the
  Phase 1 design promise (authorization is re-derived from `app_users` every request, never
  cached in the token) actually holds days later, not just in the design doc. Reverted
  afterward to keep seed state clean.
- **Audit log**: real entries with joined display names, a working action/resource/date filter,
  and a genuine "Chain verified" badge reflecting the actual state of the hash chain at view
  time.
- **Evidence-snapshot-aware report, proven to actually freeze data**: created a case, pinned an
  entity, closed it (`nationality: BE` at that moment), directly edited the live object's
  `nationality` to `FR`, then re-fetched the report — the closed case's report still showed
  `BE`. This is the first time `evidence_snapshot` (built in Phase 1, never consumed until now)
  has actually been exercised end to end.
- **Redaction**: the report explicitly states the viewer's clearance and that entities above it
  are omitted; verified this isn't just a UI claim by tracing the code path — for closed cases
  the redaction is applied in application code against the embedded snapshot JSON, since
  Postgres RLS filters rows, not values inside a jsonb column (documented inline in
  `cases.ts` — a real distinction from every other endpoint in this codebase, which gets
  redaction for free from the RLS-scoped connection).

## A real bug found and fixed during verification

Typing into the audit log's action filter dropped every character after the first. Root cause:
`if (isLoading) return <Loading/>` sat above the filter `<input>` elements, and every keystroke
changed the React Query key (a live per-character filter), which set `isLoading` true for that
newly-uncached key — unmounting the *entire form*, including the input the user was mid-keystroke
in. Fixed by confining the loading/error states to the results table, keeping the filter inputs
permanently mounted. Checked every other screen for the same pattern (`CaseReportPage`,
`CaseWorkspacePage`, `AdminUsersPage`, `ResolutionQueuePage`, `ObjectDetailPage`): all of them
gate `isLoading` *after* a one-time purpose/status submission, not live per-keystroke input, so
none of them share this failure mode. This one was only reachable by actually typing into the
field at realistic speed — exactly the kind of bug that survives `npm run typecheck` and even a
slow manual click-through, and was only caught because the browser-automation "typing" behaved
like a real fast typist would.

## Design choices worth flagging

- **The evidence snapshot upgrade (object/edge property values embedded, not just IDs) was a
  mid-flight design correction**, not originally scoped for this phase. `PHASE3_REVIEW.md` had
  already named the gap ("snapshot's IDs still resolve to the current property values"); since
  this phase built the first real consumer of the snapshot, fixing it here — rather than
  shipping a report that only partially delivers on "frozen" — was the more honest choice.
  Provenance (`object_property_meta`) is still read live at report time even for closed cases;
  that log is append-only in practice, so this is a smaller, named remaining gap, not the same
  class of bug.
- **PDF export uses the browser's native print dialog against the same HTML**, not a
  server-side Playwright pipeline (the stack decision notes mention Playwright as the intended
  mechanism). This still satisfies "same HTML renders the in-app report and the PDF" — arguably
  more literally than a separate server process would — without adding a headless-browser
  server dependency this session. A server-side pipeline would matter once automated/scheduled
  report generation (no human in a browser) is a real requirement; today it isn't.
- **No graph snapshot image in the report**, despite the blueprint listing one. Cytoscape.js
  supports `cy.png()` for exactly this, but the report is generated from a fresh page load with
  no live graph instance, not from the case workspace where the graph is already rendered.
  Wiring this would mean either capturing the image client-side from the workspace before
  navigating to the report, or rendering a throwaway graph server-side — both are real scope,
  correctly deferred rather than faked.

## What's fragile

- **Admin actions have no confirmation step in the UI** — changing a user's role or clearance
  takes effect on the first click of the dropdown, no "are you sure." Given `admin.user.update`
  is fully audited (who, what changed, when), this is a defensible MVP tradeoff, but a
  production admin panel for a security product would likely want at least a confirm step for
  role escalation specifically.
- **The audit log's action/resource-type filters are exact-match, not partial/fuzzy** — typing
  "case" won't match "case.read"; the user has to know or copy the exact action string. Adequate
  for a compliance officer who already knows what they're looking for from an incident report,
  weaker for open-ended exploration. A `ILIKE`-based partial match would be a low-effort
  improvement.
- **`toMarkdown()` and the HTML report are two independent renderers of the same `CaseReport`
  data** — they're kept in sync by hand, not generated from one shared template. A future
  property added to the report payload could easily land in one and be forgotten in the other.

## Deferred, and why

Scheduled/automated report generation, a confirmation UX for privileged admin actions, and
partial-match audit filtering are all reasonable v1.5 items, not indefinitely deferred — named
here so they don't quietly disappear. This closes out the blueprint's originally-scoped v1
screen list (S1–S7); what's left before a design-partner pilot is hardening (ISO 27001 gap
assessment, real secrets management, rate limiting, CORS/config-per-environment) per the
strategy document's own phasing, not new product surface.

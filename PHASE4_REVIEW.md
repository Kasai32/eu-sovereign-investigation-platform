# Phase 4 self-review

Scope built: S5 (CSV intake with column-mapping templates, run tracking, quarantine, CSV export
of errors) and S6 (entity-resolution review queue with keyboard-driven merge/not-a-match/skip,
reversible via undo). Verified with a real CSV exercising all four ingestion outcomes at once
(new object, exact-match auto-merge, ambiguous queued match, quarantined invalid row) via curl,
then again through the actual browser UI with a real file-input upload — not a curl shortcut —
and a real keyboard-driven merge decision, confirmed against the database afterward both times.

## What was verified live

- **All four ingestion outcomes in one run**: a 4-row CSV against the seed data produced
  exactly 1 new object (Marcus Webb, no match), 1 auto-merge (an exact-name "Jordan Vance" row,
  similarity 1.0 ≥ 0.92, `canonical_of` set automatically), 1 queued ambiguous match ("Jordan
  Vence" vs. seeded "Jordan Vance", similarity 0.625 — inside the band, correctly *not*
  auto-merged), and 1 quarantined row (blank required `name`, caught by the schema validator
  that closes the gap flagged in `PHASE0_REVIEW.md`).
- **Browser upload**: selected source/template from real dropdowns, attached a real file via
  the file input (not a scripted multipart POST), submitted, and watched the run appear in the
  list with live counts — confirms the actual `<input type="file">` + `FormData` +
  `@fastify/multipart` path works end to end, not just the API in isolation.
- **Resolution queue, keyboard-driven**: pressed `m` on the focused pair in the browser: side-
  by-side comparison correctly highlighted the differing fields (name, id_number) and left
  matching ones (dob, nationality) unhighlighted; the existing entity's real neighborhood
  (`employed_by`, `owns_account`, `shared_device`) rendered against the new entity's genuinely
  empty one; after the keypress the item vanished from the pending list, and a direct DB query
  confirmed `canonical_of` was actually set — not just a UI-only state change.
- **Access control**: alice (analyst) gets 403 creating a source, 403 running ingestion, and
  200 viewing the resolution queue — matching the intended posture (ingestion is a
  supervisor+/admin action; reviewing candidate matches is open to any analyst, since that's
  who blueprint's S6 describes as doing this work "at a sitting").

## Design choices worth flagging

- **Ingestion runs synchronously inside the HTTP request**, one row at a time, each doing
  several sequential round-trips (insert object, insert property_meta per property, similarity
  query). Fine at this dataset's scale (a handful of rows completes in well under a second);
  a real production-sized CSV (thousands of rows) would need to move this to a background job
  with progress polling rather than holding the HTTP connection open the whole time. Named here
  rather than silently accepted as the final design.
- **No intra-batch duplicate detection.** Entity resolution only compares each new row against
  *already-existing* canonical objects, not against other rows in the *same* upload. Two rows
  in one CSV that are duplicates of each other will both be inserted as separate objects and
  neither will flag the other. Real ingestion pipelines usually need both; only the
  against-the-existing-master-list half is built.
- **Mapping templates target exactly one object type** — there's no way to ingest a CSV that
  creates edges (e.g., a transactions file mapping to `transacted_with` relationships between
  two existing accounts). The seed data models transactions as edges; a real deployment would
  need edge-mapping templates as a near-term follow-up, not indefinitely deferred.
- **`retention_days` on `ingestion_sources` is stored but not enforced.** Nothing purges data
  after that many days — the build prompt's "retention/deletion policy per source" is only
  half-built: the policy is configurable, the deletion isn't scheduled. This is a real gap for
  a compliance-facing product, not a cosmetic one.
- **Schema validation is intentionally minimal** (`objectValidation.ts`): required-field
  presence and a string-type check. No date-format validation (a malformed `dob` like
  "not-a-date" would currently pass), no enum/pattern constraints. Matches the object types'
  own schemas, which are equally minimal — both would need to grow together.

## What's fragile

- **The AUTO_MERGE_THRESHOLD (0.92) and AMBIGUOUS_FLOOR (0.55) constants are untuned
  placeholders**, chosen to make the demonstration CSV land in the right buckets, not derived
  from any real precision/recall analysis. A real deployment needs this tuned against actual
  duplicate-detection outcomes before trusting the auto-merge tier with real customer data.
- **Fuzzy matching only has a trigram index for the `name` property specifically**
  (`idx_objects_name_trgm` from Phase 0). A template with a different `match_property` (e.g.
  matching Accounts on `account_number`) falls back to a sequential scan per ingested row —
  correct, but slower at real data volumes.
- **`ingestion_run_errors` has no per-row classification** — quarantined rows can contain raw
  values as sensitive as anything that would have become a classified object, but visibility is
  gated only by role (supervisor/compliance/admin), not by a classification comparison like
  `objects`/`edges` get. Consistent with the coarser-than-aspirational property-level gap
  already named in `PHASE0_REVIEW.md`, not a new kind of gap.

## Deferred, and why

XLSX upload (blueprint says "CSV/XLSX"; only CSV built — a disclosed scope cut, not silently
dropped) and live connectors (explicitly out of v1 per the blueprint's "deliberate v1
constraint"). S7's admin/audit screens and the AI assistant layer remain later phases per the
blueprint's own sequencing.

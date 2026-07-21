# Phase 3 self-review

Scope built: S2, the case workspace — the blueprint's own "60% of build effort" screen. Three
panes (case file, Cytoscape graph canvas, entity/edge inspector) with cross-pane linked
selection, server-side k-hop expansion, server-side shortest-path, pin/hide, and add/remove
entity from the inspector. Verified three ways: a real Vitest/Testing-Library integration test
for linked selection, live browser walkthrough via `claude-in-chrome`, and (unplanned but
important) a live concurrency stress test after catching a real bug mid-verification.

## A real, previously-undetected bug, found through actual concurrent usage

`CaseWorkspacePage` fires `GET /cases/:id` and `GET /cases/:id/graph` in parallel on load (two
independent `useQuery` calls — reasonable, not a mistake). Opening the seed case in the browser
and then checking `/audit` afterward showed the hash chain broken at a seq that had nothing to
do with any deliberate tampering. Investigation showed two audit rows inserted 107 microseconds
apart shared the exact same `prev_hash` — `write_audit_log()`'s "read the last row's hash, then
insert" was not atomic against a second concurrent writer doing the same read before the first
committed. Both transactions read the same "last" hash, both computed a valid-looking row on
top of it, both inserted successfully (no constraint prevented it) — forking the chain.

Fixed in `db/migrations/008_audit_log_chain_lock.sql` with `pg_advisory_xact_lock()` taken at
the top of `write_audit_log()`, serializing all concurrent callers for the duration of the
read-then-insert. Verified the fix directly, not just by reasoning about it: reset to a clean
chain, fired 60 genuinely concurrent writes from 4 parallel `psql` sessions, and confirmed
`verify_audit_log()` reports valid with all 60 rows present. This is the kind of bug that would
never show up in sequential testing (every prior test script in this repo wrote audit entries
one at a time) — it only exists under real concurrent load, which is exactly what a multi-pane
UI making parallel requests produces on literally every case open. Worth remembering: any future
addition to this schema that reads "the last X" before writing needs the same scrutiny.

## What was verified live

- **Linked selection integration test** (`CaseWorkspacePage.test.tsx`): renders the real
  `CaseWorkspace` component tree with mocks only at the two genuine boundaries (the API client
  and the `cytoscape` library, which needs a real canvas jsdom can't provide). Clicking an
  entity in the case-file pane is asserted to (1) update the inspector pane's rendered content,
  (2) visually mark the same entity selected in the case-file list, and (3) call
  `cy.getElementById('obj-1').select()` on the mocked graph instance — proving the selection
  genuinely reaches the graph pane's imperative Cytoscape sync, not just React state.
- **Browser walkthrough**: opened the seed case as Sam (supervisor), saw the force-directed
  graph render with correct classification-colored nodes and labeled edges; clicked a node and
  watched the inspector populate and the case-file entry highlight simultaneously; ran
  server-side path-finding from Jordan Vance to the Alert (correctly found and highlighted the
  2-hop path through account ...4821, correctly excluded the unrelated nodes); removed and
  re-added an entity via the inspector, watching the entity count and case-file list update each
  time; added a note and watched it appear attributed to the right user.
- **Concurrency fix**, as above.

## Design choices worth flagging

- **Node position pinning is client-side only**, not persisted server-side per case. The
  blueprint's S2 spec asks for "manual pinning that persists per case" — this implementation
  locks a node's position against the force-directed layout during the current session (real,
  functional) but forgets it on reload. Persisting would need a `case_graph_layout` table and
  save/load wiring; deliberately deferred rather than adding schema for a v1 screen that's
  already the single biggest scope item this session.
- **Shortest-path is a bounded brute-force recursive CTE** (explores simple paths up to 6 hops),
  not a proper early-exit bidirectional BFS. Fine at this dataset's scale (confirmed via curl
  and the browser), explicitly flagged in the route's own code comment as needing a real
  algorithm or a graph DB (the build prompt's own v2 escape hatch) before a denser production
  graph would make this expensive.
- **Grouping/clustering/community detection was not built.** The full build prompt mentions it
  under general Gotham-class features, but the blueprint's own S2 spec (the authoritative v1
  scope) doesn't list it — treated as out of scope by the same logic that put map/timeline/AI
  layer in v2.
- **The rendering-budget warning banner exists but is untested at scale** — this dataset never
  gets near 2,000 nodes, so the banner's logic is straightforward but unexercised. Worth a
  synthetic stress-seed (a few thousand fake objects/edges) before trusting it in front of a
  real analyst.

## What's fragile

- **`GraphCanvas`'s data-sync effect diffs by full node/edge id-set equality each render** — for
  a case with a large pinned-entity set plus several expansions, every merge triggers a fresh
  `cose` layout run (`animate: false`, so at least it's not visually janky, but it does
  recompute positions for nodes the analyst may have manually arranged). A production version
  would want to only lay out newly-added nodes, keeping existing ones fixed unless explicitly
  re-laid-out.
- **Path-finding and expand both merge results into local component state that's never
  reconciled with the server on reload** — refreshing the page loses any expansion/path history
  beyond the case's originally-pinned entities. Consistent with position-pinning not persisting;
  same underlying gap (no server-side "investigation graph state" for a case beyond its pinned
  entity list).
- **The `case_entities` DELETE policy (`case_entities_delete`, migration 007) has no audit-log
  equivalent check for who's allowed to unpin** — any case member with sufficient clearance can
  remove any other member's pinned entity. Matches the existing pin/note permissions model
  (no per-action role gating beyond case visibility), but worth naming since "remove" is more
  destructive than "add."

## Deferred, and why

S5 (ingestion), S6 (entity-resolution review UI), S7's frontend (admin/audit screens — the API
routes exist, unused by UI), map, timeline, and the AI layer remain Phase 4+/v2 per the
blueprint's explicit sequencing. Server-side layout persistence and true shortest-path
algorithms are named above as real gaps within S2 itself, not silently dropped.

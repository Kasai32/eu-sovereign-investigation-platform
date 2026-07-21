import type { FastifyBaseLogger } from "fastify";
import { withRequestContext, type RequestContext } from "./db.js";
import { writeAudit } from "./audit.js";

// Real identity, not a bare UUID: audit entries and any app_users listing resolve "who did
// this" to a visible, inspectable account (db/migrations/014_retention_enforcement.sql),
// distinguishable from any analyst by name/email rather than a magic constant.
export const RETENTION_SYSTEM_CTX: RequestContext = {
  userId: "00000000-0000-0000-0000-000000000001",
  actorRole: "admin",
  clearance: "RESTRICTED",
};

const BATCH_SIZE = 500;
const ANONYMIZED_MARKER_KEY = "_retention_anonymized_at";

// Batched like ingestion's chunking (#37): one short transaction per batch instead of one
// giant sweep, so a slow/large sweep doesn't hold a single transaction (and its row locks)
// open for its full duration.
async function anonymizeObjectsBatch(): Promise<number> {
  return withRequestContext(RETENTION_SYSTEM_CTX, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `WITH contributing_sources AS (
         SELECT object_id, array_agg(DISTINCT source) AS sources, max(ingested_at) AS last_ingested_at
         FROM object_property_meta
         GROUP BY object_id
       ),
       retention_eligible AS (
         -- Only objects whose properties came from exactly one source are candidates: an
         -- object enriched from two sources with different retention policies has no single
         -- unambiguous window, so it's conservatively left alone rather than guessed at.
         SELECT cs.object_id
         FROM contributing_sources cs
         JOIN ingestion_sources s ON s.name = cs.sources[1]
         WHERE array_length(cs.sources, 1) = 1
           AND s.retention_days IS NOT NULL
           AND cs.last_ingested_at < now() - (s.retention_days || ' days')::interval
       )
       SELECT re.object_id AS id
       FROM retention_eligible re
       JOIN objects o ON o.id = re.object_id
       WHERE NOT (o.properties ? '${ANONYMIZED_MARKER_KEY}')
         -- An object still pinned to a live investigation keeps real data regardless of the
         -- retention clock — the active-case purpose overrides the data-minimization deadline.
         AND NOT EXISTS (
           SELECT 1 FROM case_entities ce JOIN cases c ON c.id = ce.case_id
           WHERE ce.object_id = o.id AND c.status IN ('open', 'under_review')
         )
         AND NOT EXISTS (
           SELECT 1 FROM case_documents cd JOIN cases c ON c.id = cd.case_id
           WHERE cd.object_id = o.id AND c.status IN ('open', 'under_review')
         )
       LIMIT ${BATCH_SIZE}`,
    );
    if (rows.length === 0) return 0;

    const ids = rows.map((r) => r.id);
    // Clears the property values (the actual PII) but keeps the row, its id, its edges, and
    // any case linkage intact — 005 grants app_user no DELETE on objects at all ("merges use
    // canonical_of; cases close, they don't disappear"), and this sweep doesn't get an
    // exception to that. object_property_meta is left as-is: which property keys existed,
    // sourced from where, until when, is provenance metadata worth keeping even after the
    // values themselves are gone.
    await client.query(
      `UPDATE objects SET properties = jsonb_build_object('${ANONYMIZED_MARKER_KEY}', now()::text) WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return ids.length;
  });
}

async function anonymizeEdgesBatch(): Promise<number> {
  return withRequestContext(RETENTION_SYSTEM_CTX, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT e.id
       FROM edges e
       JOIN ingestion_sources s ON s.name = e.source
       WHERE s.retention_days IS NOT NULL
         AND e.created_at < now() - (s.retention_days || ' days')::interval
         AND NOT (e.properties ? '${ANONYMIZED_MARKER_KEY}')
       LIMIT ${BATCH_SIZE}`,
    );
    if (rows.length === 0) return 0;

    const ids = rows.map((r) => r.id);
    await client.query(
      `UPDATE edges SET properties = jsonb_build_object('${ANONYMIZED_MARKER_KEY}', now()::text) WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return ids.length;
  });
}

export async function runRetentionSweep(
  triggeredBy: string = RETENTION_SYSTEM_CTX.userId,
  purpose: string = "scheduled data retention enforcement",
): Promise<{ runId: string; objectsAnonymized: number; edgesAnonymized: number }> {
  const runId = await withRequestContext(RETENTION_SYSTEM_CTX, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO retention_enforcement_runs (triggered_by) VALUES ($1) RETURNING id`,
      [triggeredBy],
    );
    return rows[0].id;
  });

  let objectsAnonymized = 0;
  let edgesAnonymized = 0;
  let batch: number;
  do {
    batch = await anonymizeObjectsBatch();
    objectsAnonymized += batch;
  } while (batch === BATCH_SIZE);
  do {
    batch = await anonymizeEdgesBatch();
    edgesAnonymized += batch;
  } while (batch === BATCH_SIZE);

  await withRequestContext(RETENTION_SYSTEM_CTX, async (client) => {
    await client.query(
      `UPDATE retention_enforcement_runs SET completed_at = now(), objects_anonymized = $1, edges_anonymized = $2 WHERE id = $3`,
      [objectsAnonymized, edgesAnonymized, runId],
    );
    // Always attributed to the system actor, matching the session write_audit_log checks
    // against (the anonymizing UPDATEs above ran as this same identity, at RESTRICTED
    // clearance, regardless of who asked for an out-of-schedule run) — the actual triggering
    // human, when there is one, is recorded in details instead of as the row's own actor.
    await writeAudit(client, {
      userId: RETENTION_SYSTEM_CTX.userId,
      action: "retention.enforcement.run",
      resourceType: "retention_enforcement_run",
      resourceId: runId,
      purpose,
      details: { objectsAnonymized, edgesAnonymized, triggeredBy },
    });
  });

  return { runId, objectsAnonymized, edgesAnonymized };
}

// In-process scheduler, consistent with this codebase's existing "no new infrastructure"
// stance (no Redis/cron container — see the background-processing pattern ingestion's async
// pipeline uses). Runs once shortly after boot, then on a fixed interval — every 24h by
// default, since a fresh deploy shouldn't wait a full day for its first sweep.
const DEFAULT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function scheduleRetentionSweep(log: FastifyBaseLogger): void {
  const intervalMs = Number(process.env.RETENTION_SWEEP_INTERVAL_MS ?? DEFAULT_SWEEP_INTERVAL_MS);

  const run = () => {
    runRetentionSweep().catch((err) => log.error({ err }, "scheduled retention sweep failed"));
  };

  setTimeout(run, 5_000); // let the server finish booting before the first sweep
  setInterval(run, intervalMs);
}

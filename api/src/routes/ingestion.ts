import { createHash, randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { parse } from "csv-parse/sync";
import { pool, withRequestContext, type RequestContext } from "../db.js";
import { writeAudit } from "../audit.js";
import { validateProperties, type PropertySchema } from "../objectValidation.js";

const PRIVILEGED_ROLES = ["supervisor", "compliance", "admin"];

// Fuzzy-match thresholds for entity resolution against existing objects of the same type.
// Above AUTO_MERGE: confident enough to merge automatically (reversible via canonical_of).
// Between the two: "ambiguous" per the build prompt — always queued for human review, never
// auto-merged. Below AMBIGUOUS_FLOOR: treated as a genuinely distinct object, no queue entry.
const AUTO_MERGE_THRESHOLD = 0.92;
const AMBIGUOUS_FLOOR = 0.55;

// Each chunk of rows is its own short transaction instead of the whole run being one giant
// one. Proven necessary, not theoretical: a real ingestion run against this codebase's
// previous single-transaction version took 82s for 20,000 rows over real HTTP, and killing
// the server 20s into that run lost every row silently — including the ingestion_runs row
// itself, since even its own INSERT was part of the same never-committed transaction. There
// was no record a run had even been attempted. Chunking means rows committed in prior chunks
// survive a crash, and ingestion_runs' running totals (updated once per chunk, in the same
// transaction as the rows they count) always reflect real durable progress — which is what
// makes resuming from a checkpoint (below) possible at all.
const CHUNK_SIZE = 500;

type IngestionTemplate = { object_type_id: string; match_property: string; mapping: Record<string, string> };
type IngestionSource = { name: string; default_classification: string };

// Runs one advisory-lock-guarded critical section per ingestion run id. Two concurrent
// attempts to process the same run — the ordinary case (this request is still legitimately
// working through chunks) racing an operator's premature "resume" click, or two resume clicks
// racing each other — would otherwise both read the same checkpoint and process the same rows
// twice, creating duplicate objects. A session-scoped advisory lock on a dedicated connection,
// held for this call's whole duration (not per-chunk-transaction, which would only guard a
// single chunk), makes a second concurrent attempt fail fast instead of racing.
async function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<{ locked: true; result: T } | { locked: false }> {
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query<{ acquired: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired`, [runId]);
    if (!rows[0].acquired) return { locked: false };
    try {
      return { locked: true, result: await fn() };
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [runId]);
    }
  } finally {
    lockClient.release();
  }
}

// Processes records[startAt..] in CHUNK_SIZE-row transactions, checkpointing ingestion_runs
// after each chunk. startAt is 0 for a fresh run or records_ingested + records_quarantined for
// a resume — every row in a committed chunk increments exactly one of those two counters, so
// their sum is always exactly how many rows (from the start of the file) have been durably
// processed, regardless of how many separate attempts it took to get there.
async function runIngestionChunks(
  ctx: RequestContext,
  runId: string,
  records: Record<string, string>[],
  startAt: number,
  schema: PropertySchema,
  mapping: Record<string, string>,
  template: IngestionTemplate,
  source: IngestionSource,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    for (let chunkStart = startAt; chunkStart < records.length; chunkStart += CHUNK_SIZE) {
      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, records.length);
      await withRequestContext(ctx, async (client) => {
        let chunkIngested = 0;
        let chunkQuarantined = 0;
        let chunkAutoMerged = 0;
        let chunkQueuedForReview = 0;

        for (let i = chunkStart; i < chunkEnd; i++) {
          const row = records[i];
          const properties: Record<string, string> = {};
          for (const [csvColumn, propertyKey] of Object.entries(mapping)) {
            if (row[csvColumn] !== undefined && row[csvColumn] !== "") properties[propertyKey] = row[csvColumn];
          }

          const errors = validateProperties(schema, properties);
          if (errors.length > 0) {
            await client.query(
              `INSERT INTO ingestion_run_errors (run_id, row_number, raw_row, error_message) VALUES ($1, $2, $3::jsonb, $4)`,
              [runId, i + 1, JSON.stringify(row), errors.join("; ")],
            );
            chunkQuarantined++;
            continue;
          }

          const objectId = randomUUID();
          await client.query(
            `INSERT INTO objects (id, object_type_id, properties, classification) VALUES ($1, $2, $3::jsonb, $4)`,
            [objectId, template.object_type_id, JSON.stringify(properties), source.default_classification],
          );

          // One multi-row INSERT instead of one round trip per property — for a row with K
          // mapped columns this was K sequential awaited queries; a 1,000-row file with 5
          // mapped columns issued ~5,000 of these alone. Row ordering/timing relative to the
          // object insert and the similarity check right below is unchanged, only this inner
          // loop is collapsed.
          const propertyKeys = Object.keys(properties);
          if (propertyKeys.length > 0) {
            // $1-$4 are shared across every row of this VALUES list (object_id, source name,
            // classification, raw_source_ref are all constant for this ingested row); only
            // property_key varies, one placeholder per key starting at $5.
            const rawSourceRef = `run:${runId}#row:${i + 1}`;
            const valuesSql = propertyKeys.map((_, k) => `($1, $${k + 5}, $2, 1.0, $3, $4)`).join(", ");
            await client.query(
              `INSERT INTO object_property_meta (object_id, property_key, source, confidence, classification, raw_source_ref)
               VALUES ${valuesSql}`,
              [objectId, source.name, source.default_classification, rawSourceRef, ...propertyKeys],
            );
          }
          chunkIngested++;

          const matchValue = properties[template.match_property];
          if (matchValue) {
            // Postgres can only use pg_trgm's GIN index via the `%`/`<->` operators, never via
            // a bare `similarity()` call in ORDER BY — the prior version of this query scored
            // every row of the object type on every ingested row regardless of index. Setting
            // the threshold and filtering with `%` lets the index (when match_property is
            // "name", the one property it currently covers) prune candidates before the exact
            // score is computed.
            await client.query(`SET LOCAL pg_trgm.similarity_threshold = ${AMBIGUOUS_FLOOR}`);
            const { rows: matches } = await client.query(
              `SELECT id, similarity(properties->>$1, $2) AS sim
               FROM objects
               WHERE object_type_id = $3 AND id <> $4 AND canonical_of IS NULL
                 AND (properties->>$1) % $2
               ORDER BY sim DESC LIMIT 1`,
              [template.match_property, matchValue, template.object_type_id, objectId],
            );
            const best = matches[0];
            if (best && best.sim >= AUTO_MERGE_THRESHOLD) {
              await client.query(`UPDATE objects SET canonical_of = $1 WHERE id = $2`, [best.id, objectId]);
              chunkAutoMerged++;
            } else if (best && best.sim >= AMBIGUOUS_FLOOR) {
              await client.query(
                `INSERT INTO resolution_queue (object_a_id, object_b_id, similarity_score, decision) VALUES ($1, $2, $3, 'pending')`,
                [best.id, objectId, best.sim],
              );
              chunkQueuedForReview++;
            }
          }
        }

        await client.query(
          `UPDATE ingestion_runs
           SET records_ingested = records_ingested + $1, records_quarantined = records_quarantined + $2,
               records_auto_merged = records_auto_merged + $3, records_queued_for_review = records_queued_for_review + $4
           WHERE id = $5`,
          [chunkIngested, chunkQuarantined, chunkAutoMerged, chunkQueuedForReview, runId],
        );
      });
    }
    return { ok: true };
  } catch (err) {
    // A chunk failed outright (an infra-level error — per-row validation failures are already
    // caught and quarantined above without aborting the chunk). Whatever prior chunks
    // committed stays durable; mark the run failed instead of leaving it stuck at 'running'
    // forever with no explanation. A failed run can be retried via POST /ingestion/runs/:id/resume.
    await withRequestContext(ctx, async (client) => {
      await client.query(`UPDATE ingestion_runs SET status = 'failed', completed_at = now() WHERE id = $1`, [runId]);
    }).catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function finalizeRun(ctx: RequestContext, runId: string, filename: string) {
  return withRequestContext(ctx, async (client) => {
    const { rows } = await client.query(`SELECT * FROM ingestion_runs WHERE id = $1`, [runId]);
    const run = rows[0];
    const status = run.records_quarantined > 0 ? "completed_with_errors" : "completed";
    await client.query(`UPDATE ingestion_runs SET status = $1, completed_at = now() WHERE id = $2`, [status, runId]);
    await writeAudit(client, {
      userId: ctx.userId,
      action: "ingestion.run",
      resourceType: "ingestion_run",
      resourceId: runId,
      purpose: "data ingestion run",
      details: {
        filename,
        recordsTotal: run.records_total,
        ingested: run.records_ingested,
        quarantined: run.records_quarantined,
        autoMerged: run.records_auto_merged,
        queuedForReview: run.records_queued_for_review,
      },
    });
    const { rows: finalRows } = await client.query(`SELECT * FROM ingestion_runs WHERE id = $1`, [runId]);
    return finalRows[0];
  });
}

const ingestionRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ingestion/sources", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const sources = await withRequestContext(request.ctx, async (client) => {
      const { rows } = await client.query(`SELECT * FROM ingestion_sources ORDER BY name`);
      return rows;
    });
    reply.send({ sources });
  });

  app.post("/ingestion/sources", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    if (request.ctx.actorRole !== "admin") return reply.code(403).send({ error: "only admins can create ingestion sources" });
    const body = request.body as { name?: string; defaultClassification?: string; retentionDays?: number };
    if (!body.name) return reply.code(400).send({ error: "name is required" });

    const source = await withRequestContext(request.ctx, async (client) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO ingestion_sources (id, name, default_classification, retention_days, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, body.name, body.defaultClassification ?? "INTERNAL", body.retentionDays ?? null, request.ctx!.userId],
      );
      const { rows } = await client.query(`SELECT * FROM ingestion_sources WHERE id = $1`, [id]);
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "ingestion.source.create",
        resourceType: "ingestion_source",
        resourceId: id,
        purpose: "new ingestion source configured",
      });
      return rows[0];
    });
    reply.code(201).send(source);
  });

  app.get("/ingestion/templates", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { sourceId } = request.query as { sourceId?: string };
    const templates = await withRequestContext(request.ctx, async (client) => {
      const { rows } = sourceId
        ? await client.query(`SELECT * FROM column_mapping_templates WHERE source_id = $1 ORDER BY name`, [sourceId])
        : await client.query(`SELECT * FROM column_mapping_templates ORDER BY name`);
      return rows;
    });
    reply.send({ templates });
  });

  app.post("/ingestion/templates", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    if (request.ctx.actorRole !== "admin") return reply.code(403).send({ error: "only admins can create mapping templates" });
    const body = request.body as {
      sourceId?: string;
      name?: string;
      objectTypeId?: string;
      matchProperty?: string;
      mapping?: Record<string, string>;
    };
    if (!body.sourceId || !body.name || !body.objectTypeId || !body.matchProperty || !body.mapping) {
      return reply.code(400).send({ error: "sourceId, name, objectTypeId, matchProperty, and mapping are required" });
    }

    const template = await withRequestContext(request.ctx, async (client) => {
      const id = randomUUID();
      await client.query(
        `INSERT INTO column_mapping_templates (id, source_id, name, object_type_id, match_property, mapping, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [id, body.sourceId, body.name, body.objectTypeId, body.matchProperty, JSON.stringify(body.mapping), request.ctx!.userId],
      );
      const { rows } = await client.query(`SELECT * FROM column_mapping_templates WHERE id = $1`, [id]);
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "ingestion.template.create",
        resourceType: "column_mapping_template",
        resourceId: id,
        purpose: "new column mapping template configured",
      });
      return rows[0];
    });
    reply.code(201).send(template);
  });

  app.get("/ingestion/runs", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const runs = await withRequestContext(request.ctx, async (client) => {
      const { rows } = await client.query(
        `SELECT r.*, s.name AS source_name, t.name AS template_name
         FROM ingestion_runs r
         JOIN ingestion_sources s ON s.id = r.source_id
         JOIN column_mapping_templates t ON t.id = r.template_id
         ORDER BY r.started_at DESC LIMIT 100`,
      );
      return rows;
    });
    reply.send({ runs });
  });

  app.get("/ingestion/runs/:id/errors", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = request.params as { id: string };
    const errors = await withRequestContext(request.ctx, async (client) => {
      const { rows } = await client.query(
        `SELECT row_number, raw_row, error_message, created_at FROM ingestion_run_errors WHERE run_id = $1 ORDER BY row_number`,
        [id],
      );
      return rows;
    });
    reply.send({ errors });
  });

  // The core intake pipeline: parse -> validate against the object type's schema -> insert as
  // a new object with full provenance -> fuzzy-match against existing objects of the same type
  // for entity resolution. One bad row quarantines that row and continues; it never aborts the
  // whole batch.
  app.post("/ingestion/runs", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    if (!PRIVILEGED_ROLES.includes(request.ctx.actorRole)) {
      return reply.code(403).send({ error: "ingestion is restricted to supervisor/compliance/admin roles" });
    }

    const filePart = await request.file();
    if (!filePart) return reply.code(400).send({ error: "a CSV file is required" });
    const sourceId = (filePart.fields.sourceId as { value?: string } | undefined)?.value;
    const templateId = (filePart.fields.templateId as { value?: string } | undefined)?.value;
    if (!sourceId || !templateId) return reply.code(400).send({ error: "sourceId and templateId fields are required" });

    const buffer = await filePart.toBuffer();
    let records: Record<string, string>[];
    try {
      records = parse(buffer, { columns: true, skip_empty_lines: true, trim: true });
    } catch (err) {
      return reply.code(400).send({ error: `could not parse CSV: ${err instanceof Error ? err.message : String(err)}` });
    }
    const fileHash = createHash("sha256").update(buffer).digest("hex");

    const setup = await withRequestContext(request.ctx, async (client) => {
      const { rows: sourceRows } = await client.query(`SELECT * FROM ingestion_sources WHERE id = $1`, [sourceId]);
      const { rows: templateRows } = await client.query(`SELECT * FROM column_mapping_templates WHERE id = $1`, [templateId]);
      if (sourceRows.length === 0 || templateRows.length === 0) return { error: "unknown source or template" as const };
      const source = sourceRows[0];
      const template = templateRows[0];

      const { rows: typeRows } = await client.query(`SELECT * FROM object_types WHERE id = $1`, [template.object_type_id]);
      const objectType = typeRows[0];

      const runId = randomUUID();
      await client.query(
        `INSERT INTO ingestion_runs (id, source_id, template_id, filename, status, records_total, started_by, file_hash)
         VALUES ($1, $2, $3, $4, 'running', $5, $6, $7)`,
        [runId, sourceId, templateId, filePart.filename ?? "upload.csv", records.length, request.ctx!.userId, fileHash],
      );

      return { source, template, objectType, runId };
    });

    if ("error" in setup) return reply.code(400).send({ error: setup.error });
    const { source, template, objectType, runId } = setup;
    const schema = objectType.property_schema as PropertySchema;
    const mapping = template.mapping as Record<string, string>;

    const chunkResult = await withRunLock(runId, () =>
      runIngestionChunks(request.ctx!, runId, records, 0, schema, mapping, template, source),
    );
    // A brand-new run's id can't already be locked by anything else, so `locked: false` here
    // would mean something is structurally wrong rather than a real contention case — but
    // handle it the same defensive way as the resume endpoint for consistency.
    if (!chunkResult.locked) {
      return reply.code(409).send({ error: "could not acquire processing lock for this run" });
    }
    if (!chunkResult.result.ok) {
      return reply.code(500).send({ error: `ingestion run failed partway through: ${chunkResult.result.error}` });
    }

    const finalRun = await finalizeRun(request.ctx, runId, filePart.filename ?? "upload.csv");
    reply.code(201).send(finalRun);
  });

  // Resumes a run stuck in 'running' (crashed mid-chunk — the server process died, so nothing
  // is still working on it) or 'failed' (a chunk errored outright). Requires re-uploading the
  // exact same file: file_hash and records_total are both checked so a different or reordered
  // file can't silently process the wrong rows for the un-ingested remainder. Resumes from
  // records_ingested + records_quarantined, which is always exactly how many rows have been
  // durably committed regardless of how many prior attempts it took to get there.
  app.post("/ingestion/runs/:id/resume", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    if (!PRIVILEGED_ROLES.includes(request.ctx.actorRole)) {
      return reply.code(403).send({ error: "ingestion is restricted to supervisor/compliance/admin roles" });
    }
    const { id: runId } = request.params as { id: string };

    const filePart = await request.file();
    if (!filePart) return reply.code(400).send({ error: "the original CSV file must be re-uploaded to resume" });
    const buffer = await filePart.toBuffer();
    let records: Record<string, string>[];
    try {
      records = parse(buffer, { columns: true, skip_empty_lines: true, trim: true });
    } catch (err) {
      return reply.code(400).send({ error: `could not parse CSV: ${err instanceof Error ? err.message : String(err)}` });
    }
    const fileHash = createHash("sha256").update(buffer).digest("hex");

    const setup = await withRequestContext(request.ctx, async (client): Promise<
      | { error: string; status: number }
      | { run: Record<string, any>; source: IngestionSource; template: IngestionTemplate; objectType: { property_schema: PropertySchema }; startAt: number }
    > => {
      const { rows: runRows } = await client.query(`SELECT * FROM ingestion_runs WHERE id = $1`, [runId]);
      if (runRows.length === 0) return { error: "not found", status: 404 };
      const run = runRows[0];
      if (run.status !== "running" && run.status !== "failed") {
        return { error: `run status is '${run.status}' — only a 'running' or 'failed' run can be resumed`, status: 400 };
      }
      if (run.file_hash && run.file_hash !== fileHash) {
        return { error: "uploaded file does not match the original run's file — resume requires re-uploading the exact same file", status: 400 };
      }
      if (records.length !== run.records_total) {
        return {
          error: `uploaded file has ${records.length} rows, but the original run recorded ${run.records_total} — resume requires the exact same file`,
          status: 400,
        };
      }

      const { rows: templateRows } = await client.query(`SELECT * FROM column_mapping_templates WHERE id = $1`, [run.template_id]);
      const { rows: sourceRows } = await client.query(`SELECT * FROM ingestion_sources WHERE id = $1`, [run.source_id]);
      const { rows: typeRows } = await client.query(`SELECT * FROM object_types WHERE id = $1`, [templateRows[0].object_type_id]);

      if (run.status === "failed") {
        await client.query(`UPDATE ingestion_runs SET status = 'running' WHERE id = $1`, [runId]);
      }
      const startAt = run.records_ingested + run.records_quarantined;
      return { run, source: sourceRows[0], template: templateRows[0], objectType: typeRows[0], startAt };
    });

    if ("error" in setup) return reply.code(setup.status).send({ error: setup.error });
    const { run, source, template, objectType, startAt } = setup;
    const schema = objectType.property_schema as PropertySchema;
    const mapping = template.mapping as Record<string, string>;
    const filename: string = run.filename;

    if (startAt >= records.length) {
      // A prior attempt finished every chunk but crashed before its final status update — no
      // rows left to process, just finalize.
      const finalRun = await finalizeRun(request.ctx, runId, filename);
      return reply.send(finalRun);
    }

    const chunkResult = await withRunLock(runId, () =>
      runIngestionChunks(request.ctx!, runId, records, startAt, schema, mapping, template, source),
    );
    if (!chunkResult.locked) {
      return reply.code(409).send({ error: "this run is currently being processed (already resuming, or the original request is still running) — try again shortly" });
    }
    if (!chunkResult.result.ok) {
      return reply.code(500).send({ error: `ingestion run failed partway through resume: ${chunkResult.result.error}` });
    }

    const finalRun = await finalizeRun(request.ctx, runId, filename);
    reply.send(finalRun);
  });
};

export default ingestionRoutes;

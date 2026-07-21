import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { parse } from "csv-parse/sync";
import { withRequestContext } from "../db.js";
import { writeAudit } from "../audit.js";
import { validateProperties, type PropertySchema } from "../objectValidation.js";

const PRIVILEGED_ROLES = ["supervisor", "compliance", "admin"];

// Fuzzy-match thresholds for entity resolution against existing objects of the same type.
// Above AUTO_MERGE: confident enough to merge automatically (reversible via canonical_of).
// Between the two: "ambiguous" per the build prompt — always queued for human review, never
// auto-merged. Below AMBIGUOUS_FLOOR: treated as a genuinely distinct object, no queue entry.
const AUTO_MERGE_THRESHOLD = 0.92;
const AMBIGUOUS_FLOOR = 0.55;

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

    const result = await withRequestContext(request.ctx, async (client) => {
      const { rows: sourceRows } = await client.query(`SELECT * FROM ingestion_sources WHERE id = $1`, [sourceId]);
      const { rows: templateRows } = await client.query(`SELECT * FROM column_mapping_templates WHERE id = $1`, [templateId]);
      if (sourceRows.length === 0 || templateRows.length === 0) return { error: "unknown source or template" as const };
      const source = sourceRows[0];
      const template = templateRows[0];

      const { rows: typeRows } = await client.query(`SELECT * FROM object_types WHERE id = $1`, [template.object_type_id]);
      const objectType = typeRows[0];
      const schema = objectType.property_schema as PropertySchema;

      const runId = randomUUID();
      await client.query(
        `INSERT INTO ingestion_runs (id, source_id, template_id, filename, status, records_total, started_by)
         VALUES ($1, $2, $3, $4, 'running', $5, $6)`,
        [runId, sourceId, templateId, filePart.filename ?? "upload.csv", records.length, request.ctx!.userId],
      );

      let ingested = 0;
      let quarantined = 0;
      let autoMerged = 0;
      let queuedForReview = 0;
      const mapping = template.mapping as Record<string, string>;

      for (let i = 0; i < records.length; i++) {
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
          quarantined++;
          continue;
        }

        const objectId = randomUUID();
        await client.query(
          `INSERT INTO objects (id, object_type_id, properties, classification) VALUES ($1, $2, $3::jsonb, $4)`,
          [objectId, template.object_type_id, JSON.stringify(properties), source.default_classification],
        );
        for (const key of Object.keys(properties)) {
          await client.query(
            `INSERT INTO object_property_meta (object_id, property_key, source, confidence, classification, raw_source_ref)
             VALUES ($1, $2, $3, 1.0, $4, $5)`,
            [objectId, key, source.name, source.default_classification, `run:${runId}#row:${i + 1}`],
          );
        }
        ingested++;

        const matchValue = properties[template.match_property];
        if (matchValue) {
          const { rows: matches } = await client.query(
            `SELECT id, similarity(properties->>$1, $2) AS sim
             FROM objects
             WHERE object_type_id = $3 AND id <> $4 AND canonical_of IS NULL AND properties->>$1 IS NOT NULL
             ORDER BY sim DESC LIMIT 1`,
            [template.match_property, matchValue, template.object_type_id, objectId],
          );
          const best = matches[0];
          if (best && best.sim >= AUTO_MERGE_THRESHOLD) {
            await client.query(`UPDATE objects SET canonical_of = $1 WHERE id = $2`, [best.id, objectId]);
            autoMerged++;
          } else if (best && best.sim >= AMBIGUOUS_FLOOR) {
            await client.query(
              `INSERT INTO resolution_queue (object_a_id, object_b_id, similarity_score, decision) VALUES ($1, $2, $3, 'pending')`,
              [best.id, objectId, best.sim],
            );
            queuedForReview++;
          }
        }
      }

      const status = quarantined > 0 ? "completed_with_errors" : "completed";
      await client.query(
        `UPDATE ingestion_runs
         SET status = $1, records_ingested = $2, records_quarantined = $3,
             records_auto_merged = $4, records_queued_for_review = $5, completed_at = now()
         WHERE id = $6`,
        [status, ingested, quarantined, autoMerged, queuedForReview, runId],
      );

      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "ingestion.run",
        resourceType: "ingestion_run",
        resourceId: runId,
        purpose: "data ingestion run",
        details: { filename: filePart.filename, recordsTotal: records.length, ingested, quarantined, autoMerged, queuedForReview },
      });

      const { rows: runRows } = await client.query(`SELECT * FROM ingestion_runs WHERE id = $1`, [runId]);
      return { run: runRows[0] };
    });

    if ("error" in result) return reply.code(400).send({ error: result.error });
    reply.code(201).send(result.run);
  });
};

export default ingestionRoutes;

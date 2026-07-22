import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../../db.js";
import { writeAudit } from "../../audit.js";
import { caseStatusRequestSchema, caseStatusResponseSchema } from "../../../../shared/schemas/caseStatus.js";

// Case status transitions (with evidence-snapshot freezing on close) and the S7 report export
// that consumes that snapshot.
const casesLifecycleRoutes: FastifyPluginAsync = async (app) => {
  // Closing freezes an evidence snapshot (the specific object/edge IDs relied on) so later
  // ingestion or merges never silently rewrite a finalized report's basis.
  app.patch("/cases/:id/status", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const body = (request.body ?? {}) as { status?: string; purpose?: string };
    const parsedRequest = caseStatusRequestSchema.safeParse({
      id: (request.params as { id?: string }).id,
      status: body.status,
      purpose: body.purpose,
    });
    if (!parsedRequest.success) {
      const issue = parsedRequest.error.issues[0];
      // Preserve the pre-schema wording for a bad `status`: it enumerates the valid values,
      // which Zod's default enum message does not, and it's the message the API's own
      // error-path behavior was last verified against.
      const message =
        issue?.path[0] === "status"
          ? `status must be one of ${caseStatusRequestSchema.shape.status.options.join(", ")}`
          : (issue?.message ?? "invalid request");
      return reply.code(400).send({ error: message });
    }
    const { id, status, purpose } = parsedRequest.data;

    const result = await withRequestContext(request.ctx, async (client) => {
      const params: unknown[] = [status, id];
      let extraSet = "";
      if (status === "closed") {
        const { rows: entityRows } = await client.query(`SELECT object_id FROM case_entities WHERE case_id = $1`, [id]);
        const objectIds = entityRows.map((r) => r.object_id);

        // Freeze actual property values and classifications, not just which IDs were in
        // scope. An earlier version of this snapshot stored IDs only, which stopped a merge
        // or deletion from invalidating the reference but did nothing to stop a later property
        // edit from silently changing what a "frozen" report displays — the exact failure mode
        // this snapshot exists to prevent. Provenance (object_property_meta) is still read live
        // at report time; that log is append-only in practice, so this is a deliberate, smaller
        // remaining gap rather than the same class of bug.
        type SnapshotObject = { id: string; object_type: string; properties: Record<string, unknown>; classification: string };
        type SnapshotEdge = {
          id: string;
          source_object_id: string;
          target_object_id: string;
          relationship: string;
          properties: Record<string, unknown>;
          classification: string;
        };
        const { rows: objectRows } = objectIds.length
          ? await client.query<SnapshotObject>(
              `SELECT o.id, ot.name AS object_type, o.properties, o.classification
               FROM objects o JOIN object_types ot ON ot.id = o.object_type_id
               WHERE o.id = ANY($1::uuid[])`,
              [objectIds],
            )
          : { rows: [] as SnapshotObject[] };
        const { rows: edgeRows } = objectIds.length
          ? await client.query<SnapshotEdge>(
              `SELECT e.id, e.source_object_id, e.target_object_id, rt.name AS relationship, e.properties, e.classification
               FROM edges e JOIN relationship_types rt ON rt.id = e.relationship_type_id
               WHERE e.source_object_id = ANY($1::uuid[]) AND e.target_object_id = ANY($1::uuid[])`,
              [objectIds],
            )
          : { rows: [] as SnapshotEdge[] };
        const snapshot = {
          objectIds,
          edgeIds: edgeRows.map((r) => r.id),
          objects: objectRows,
          edges: edgeRows,
          frozenAt: new Date().toISOString(),
        };
        params.push(JSON.stringify(snapshot));
        extraSet = `, evidence_snapshot = $3::jsonb, closed_at = now()`;
      }
      const { rows } = await client.query(
        `UPDATE cases SET status = $1, updated_at = now() ${extraSet} WHERE id = $2
         RETURNING id, status, evidence_snapshot, closed_at`,
        params,
      );
      if (rows.length === 0) return null;
      await client.query(
        `INSERT INTO case_activity (case_id, actor_id, action, details) VALUES ($1, $2, 'status_changed', $3::jsonb)`,
        [id, request.ctx!.userId, JSON.stringify({ status })],
      );
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "case.status_change",
        resourceType: "case",
        resourceId: id,
        purpose,
        details: { status },
      });
      return rows[0];
    });

    if (!result) return reply.code(404).send({ error: "not found" });
    reply.send(caseStatusResponseSchema.parse(result));
  });

  // S7's headline export. For a closed case, renders from the evidence_snapshot frozen on
  // close (the specific object/edge IDs the report relied on at that moment) rather than live
  // data — the entire reason that snapshot was captured back in Phase 1, and until now nothing
  // had actually consumed it. Redaction is automatic, not a separate step: this query runs
  // through the same RLS-scoped connection as every other read, so an entity above the
  // exporting user's clearance simply never appears in the result.
  app.get(
    "/cases/:id/report",
    // Tighter than the 300/min global default: an export runs several sequential queries
    // (entities, per-entity provenance, notes, activity) per request — see DECISIONS.md #21.
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = request.params as { id: string };
    const { purpose } = request.query as { purpose?: string };
    if (!purpose) return reply.code(400).send({ error: "purpose query param is required to export a case report" });

    const result = await withRequestContext(request.ctx, async (client) => {
      const { rows: caseRows } = await client.query(`SELECT * FROM cases WHERE id = $1`, [id]);
      if (caseRows.length === 0) return null;
      const theCase = caseRows[0];

      const snapshot = theCase.status === "closed" ? theCase.evidence_snapshot : null;
      const isFrozen = !!snapshot;

      let entityRows: { object_id: string; object_type: string; properties: Record<string, unknown>; classification: string }[];
      if (isFrozen) {
        // Frozen data lives in a jsonb column, not table rows — Postgres RLS filters rows, not
        // substructures inside a jsonb value, so redaction here has to be applied explicitly in
        // application code rather than inherited from the connection the way every other read
        // in this API gets it for free. Same clearance-ordering rule as the RLS policies.
        const rank: Record<string, number> = { PUBLIC: 0, INTERNAL: 1, SENSITIVE: 2, RESTRICTED: 3 };
        const viewerRank = rank[request.ctx!.clearance];
        entityRows = (snapshot.objects as { id: string; object_type: string; properties: Record<string, unknown>; classification: string }[])
          .filter((o) => rank[o.classification] <= viewerRank)
          .map((o) => ({ object_id: o.id, object_type: o.object_type, properties: o.properties, classification: o.classification }));
      } else {
        const { rows } = await client.query(
          `SELECT ce.object_id, ot.name AS object_type, o.properties, o.classification
           FROM case_entities ce
           JOIN objects o ON o.id = ce.object_id
           JOIN object_types ot ON ot.id = o.object_type_id
           WHERE ce.case_id = $1`,
          [id],
        );
        entityRows = rows;
      }

      const entities = [];
      for (const e of entityRows) {
        const { rows: propertyMeta } = await client.query(
          `SELECT property_key, source, confidence, classification, ingested_at, raw_source_ref
           FROM object_property_meta WHERE object_id = $1 ORDER BY property_key`,
          [e.object_id],
        );
        entities.push({ ...e, propertyMeta });
      }

      const { rows: notes } = await client.query(
        `SELECT cn.body, cn.author_id, au.display_name AS author_name, cn.created_at
         FROM case_notes cn JOIN app_users au ON au.id = cn.author_id
         WHERE cn.case_id = $1 ORDER BY cn.created_at ASC`,
        [id],
      );
      const { rows: activity } = await client.query(
        `SELECT ca.action, ca.details, au.display_name AS actor_name, ca.occurred_at
         FROM case_activity ca JOIN app_users au ON au.id = ca.actor_id
         WHERE ca.case_id = $1 ORDER BY ca.occurred_at ASC`,
        [id],
      );

      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "case.report.export",
        resourceType: "case",
        resourceId: id,
        purpose,
        details: { isFrozen, entityCount: entities.length },
      });

      return {
        case: theCase,
        isFrozen,
        frozenAt: snapshot?.frozenAt ?? null,
        entities,
        notes,
        activity,
        viewerClearance: request.ctx!.clearance,
        generatedAt: new Date().toISOString(),
      };
    });

    if (!result) return reply.code(404).send({ error: "not found" });
    reply.send(result);
  });
};

export default casesLifecycleRoutes;

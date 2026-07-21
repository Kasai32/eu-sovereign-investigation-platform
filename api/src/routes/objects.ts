import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../db.js";
import { writeAudit } from "../audit.js";
import { ClauseBuilder } from "../lib/clauseBuilder.js";

const objectsRoutes: FastifyPluginAsync = async (app) => {
  // Faceted search: type/name filters, RLS silently restricts to what the session may see —
  // there is no separate "classification filter" the caller can widen past their own clearance.
  app.get("/objects", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const q = request.query as { q?: string; type?: string; limit?: string; offset?: string; purpose?: string };
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const offset = Math.max(Number(q.offset ?? 0), 0);
    const purpose = q.purpose ?? "routine investigation browse";

    const objects = await withRequestContext(request.ctx, async (client) => {
      const filter = new ClauseBuilder()
        .add("ot.name", q.type)
        .addRaw((i) => `similarity(o.properties->>'name', $${i}) > 0.2`, q.q);
      const limitIdx = filter.param(limit);
      const offsetIdx = filter.param(offset);
      const { rows } = await client.query(
        `SELECT o.id, ot.name AS object_type, o.properties, o.classification, o.created_at
         FROM objects o JOIN object_types ot ON ot.id = o.object_type_id
         ${filter.where()}
         ORDER BY o.created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        filter.values,
      );
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "search",
        purpose,
        details: { q: q.q, type: q.type, limit, offset },
      });
      return rows;
    });

    reply.send({ objects });
  });

  // Entity detail is a meaningful access moment, so purpose-of-use is required here (unlike
  // the list/browse endpoint above, which defaults it) — see PHASE1_REVIEW.md for the reasoning.
  app.get("/objects/:id", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = request.params as { id: string };
    const { purpose } = request.query as { purpose?: string };
    if (!purpose) return reply.code(400).send({ error: "purpose query param is required to view entity detail" });

    const result = await withRequestContext(request.ctx, async (client) => {
      const { rows } = await client.query(
        `SELECT o.id, ot.name AS object_type, o.properties, o.classification, o.canonical_of, o.created_at
         FROM objects o JOIN object_types ot ON ot.id = o.object_type_id WHERE o.id = $1`,
        [id],
      );
      if (rows.length === 0) return null;

      const { rows: propertyMeta } = await client.query(
        `SELECT property_key, source, confidence, classification, ingested_at, raw_source_ref
         FROM object_property_meta WHERE object_id = $1 ORDER BY property_key`,
        [id],
      );

      const { rows: neighbors } = await client.query(
        `SELECT e.id AS edge_id, rt.name AS relationship, e.properties AS edge_properties,
                e.classification AS edge_classification,
                CASE WHEN e.source_object_id = $1 THEN e.target_object_id ELSE e.source_object_id END AS neighbor_id,
                CASE WHEN e.source_object_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction
         FROM edges e JOIN relationship_types rt ON rt.id = e.relationship_type_id
         WHERE e.source_object_id = $1 OR e.target_object_id = $1
         LIMIT 100`,
        [id],
      );

      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "object.read",
        resourceType: "object",
        resourceId: id,
        purpose,
      });

      return { object: rows[0], propertyMeta, neighbors };
    });

    if (!result) return reply.code(404).send({ error: "not found" });
    reply.send(result);
  });
};

export default objectsRoutes;

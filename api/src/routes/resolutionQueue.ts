import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../db.js";
import { writeAudit } from "../audit.js";

const DECISIONS = ["merged", "not_a_match", "skipped"] as const;
const MAX_NEIGHBORS_PER_OBJECT = 5;

type NeighborRow = { anchor_id: string; relationship: string; neighbor_id: string; neighbor_type: string };
type Neighbor = { relationship: string; neighbor_id: string; neighbor_type: string };

// Fetches "up to 5 neighbors" for every object in `objectIds` in one round trip, instead of the
// two-query-per-pair (up to 200 round trips for a full 100-pair queue page) the previous
// per-object neighborsFor() required. Each anchor object's edges are found from both directions
// (UNION ALL of "anchor is source" and "anchor is target") so two candidate objects that happen
// to be directly connected to each other still each see the other as a neighbor — the same
// outcome the old per-object queries gave, just computed together.
async function neighborsForBatch(client: import("pg").PoolClient, objectIds: string[]): Promise<Map<string, Neighbor[]>> {
  const byAnchor = new Map<string, Neighbor[]>();
  if (objectIds.length === 0) return byAnchor;

  const { rows } = await client.query<NeighborRow>(
    `SELECT e.source_object_id AS anchor_id, rt.name AS relationship, tgt.id AS neighbor_id, tgt_type.name AS neighbor_type
     FROM edges e
     JOIN relationship_types rt ON rt.id = e.relationship_type_id
     JOIN objects tgt ON tgt.id = e.target_object_id
     JOIN object_types tgt_type ON tgt_type.id = tgt.object_type_id
     WHERE e.source_object_id = ANY($1::uuid[])
     UNION ALL
     SELECT e.target_object_id AS anchor_id, rt.name AS relationship, src.id AS neighbor_id, src_type.name AS neighbor_type
     FROM edges e
     JOIN relationship_types rt ON rt.id = e.relationship_type_id
     JOIN objects src ON src.id = e.source_object_id
     JOIN object_types src_type ON src_type.id = src.object_type_id
     WHERE e.target_object_id = ANY($1::uuid[])`,
    [objectIds],
  );

  for (const row of rows) {
    const list = byAnchor.get(row.anchor_id) ?? [];
    // Keeps the response shape identical to the old per-object query (relationship/neighbor_id/
    // neighbor_type only) — anchor_id was only ever needed to group these rows just above.
    if (list.length < MAX_NEIGHBORS_PER_OBJECT) list.push({ relationship: row.relationship, neighbor_id: row.neighbor_id, neighbor_type: row.neighbor_type });
    byAnchor.set(row.anchor_id, list);
  }
  return byAnchor;
}

const resolutionQueueRoutes: FastifyPluginAsync = async (app) => {
  // S6: pending pairs with similarity score, side-by-side properties, and mini neighborhoods.
  app.get("/resolution-queue", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { status } = request.query as { status?: string };

    const items = await withRequestContext(request.ctx, async (client) => {
      const { rows: pairs } = await client.query(
        `SELECT rq.id, rq.object_a_id, rq.object_b_id, rq.similarity_score, rq.decision,
                rq.decided_by, rq.decided_at, rq.created_at
         FROM resolution_queue rq
         WHERE rq.decision = $1
         ORDER BY rq.similarity_score DESC LIMIT 100`,
        [status ?? "pending"],
      );

      // Batched: one query for every object across every pair, one query for every neighbor
      // across every object, instead of up to 3 queries per pair (up to 300 round trips for a
      // full 100-pair page).
      const allObjectIds = Array.from(new Set(pairs.flatMap((p) => [p.object_a_id, p.object_b_id])));
      const { rows: objRows } = allObjectIds.length
        ? await client.query(
            `SELECT o.id, ot.name AS object_type, o.properties, o.classification
             FROM objects o JOIN object_types ot ON ot.id = o.object_type_id
             WHERE o.id = ANY($1::uuid[])`,
            [allObjectIds],
          )
        : { rows: [] };
      const objectsById = new Map(objRows.map((o) => [o.id, o]));
      const neighborsByObjectId = await neighborsForBatch(client, allObjectIds);

      const enriched = [];
      for (const pair of pairs) {
        const objectA = objectsById.get(pair.object_a_id);
        const objectB = objectsById.get(pair.object_b_id);
        if (!objectA || !objectB) continue; // not visible to this session's clearance
        enriched.push({
          ...pair,
          objectA,
          objectB,
          neighborsA: neighborsByObjectId.get(pair.object_a_id) ?? [],
          neighborsB: neighborsByObjectId.get(pair.object_b_id) ?? [],
        });
      }
      return enriched;
    });

    reply.send({ items });
  });

  // Merge sets canonical_of on the duplicate (object_b) — reversible, never a delete. Not a
  // match / skip just record the decision.
  app.post("/resolution-queue/:id/decide", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = request.params as { id: string };
    const { decision, purpose } = request.body as { decision?: string; purpose?: string };
    if (!decision || !DECISIONS.includes(decision as (typeof DECISIONS)[number])) {
      return reply.code(400).send({ error: `decision must be one of ${DECISIONS.join(", ")}` });
    }

    const result = await withRequestContext(request.ctx, async (client) => {
      const { rows } = await client.query(`SELECT * FROM resolution_queue WHERE id = $1`, [id]);
      if (rows.length === 0) return null;
      const pair = rows[0];

      if (decision === "merged") {
        await client.query(`UPDATE objects SET canonical_of = $1 WHERE id = $2`, [pair.object_a_id, pair.object_b_id]);
      }
      await client.query(
        `UPDATE resolution_queue SET decision = $1, decided_by = $2, decided_at = now() WHERE id = $3`,
        [decision, request.ctx!.userId, id],
      );

      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "resolution.decide",
        resourceType: "resolution_queue",
        resourceId: id,
        purpose: purpose ?? `entity resolution reviewed: ${decision}`,
        details: { decision, objectA: pair.object_a_id, objectB: pair.object_b_id, similarity: pair.similarity_score },
      });

      return { ok: true };
    });

    if (!result) return reply.code(404).send({ error: "not found" });
    reply.send(result);
  });

  // Reversibility per the build prompt: "a false merge is much harder to detect and undo later
  // than a false split." Clears canonical_of and resets the pair to pending for re-review.
  app.post("/resolution-queue/:id/undo", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = request.params as { id: string };
    const { purpose } = request.body as { purpose?: string };

    const result = await withRequestContext(request.ctx, async (client) => {
      const { rows } = await client.query(`SELECT * FROM resolution_queue WHERE id = $1`, [id]);
      if (rows.length === 0) return null;
      const pair = rows[0];
      if (pair.decision !== "merged") return { error: "only a merged decision can be undone" as const };

      await client.query(`UPDATE objects SET canonical_of = NULL WHERE id = $1`, [pair.object_b_id]);
      await client.query(
        `UPDATE resolution_queue SET decision = 'pending', decided_by = NULL, decided_at = NULL WHERE id = $1`,
        [id],
      );

      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "resolution.undo",
        resourceType: "resolution_queue",
        resourceId: id,
        purpose: purpose ?? "undoing entity merge",
        details: { objectA: pair.object_a_id, objectB: pair.object_b_id },
      });

      return { ok: true };
    });

    if (!result) return reply.code(404).send({ error: "not found" });
    if ("error" in result) return reply.code(400).send({ error: result.error });
    reply.send(result);
  });
};

export default resolutionQueueRoutes;

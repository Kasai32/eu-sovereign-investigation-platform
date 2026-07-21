import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../db.js";
import { writeAudit } from "../audit.js";

const DECISIONS = ["merged", "not_a_match", "skipped"] as const;

async function neighborsFor(client: import("pg").PoolClient, objectId: string) {
  const { rows } = await client.query(
    `SELECT rt.name AS relationship,
            neighbor.id AS neighbor_id,
            ot.name AS neighbor_type
     FROM edges e
     JOIN relationship_types rt ON rt.id = e.relationship_type_id
     JOIN objects neighbor ON neighbor.id = CASE WHEN e.source_object_id = $1 THEN e.target_object_id ELSE e.source_object_id END
     JOIN object_types ot ON ot.id = neighbor.object_type_id
     WHERE e.source_object_id = $1 OR e.target_object_id = $1
     LIMIT 5`,
    [objectId],
  );
  return rows;
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

      const enriched = [];
      for (const pair of pairs) {
        const { rows: objRows } = await client.query(
          `SELECT o.id, ot.name AS object_type, o.properties, o.classification
           FROM objects o JOIN object_types ot ON ot.id = o.object_type_id
           WHERE o.id = ANY($1::uuid[])`,
          [[pair.object_a_id, pair.object_b_id]],
        );
        const objectA = objRows.find((o) => o.id === pair.object_a_id);
        const objectB = objRows.find((o) => o.id === pair.object_b_id);
        if (!objectA || !objectB) continue; // not visible to this session's clearance
        const neighborsA = await neighborsFor(client, pair.object_a_id);
        const neighborsB = await neighborsFor(client, pair.object_b_id);
        enriched.push({ ...pair, objectA, objectB, neighborsA, neighborsB });
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

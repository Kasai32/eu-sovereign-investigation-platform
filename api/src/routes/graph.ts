import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../db.js";
import { writeAudit } from "../audit.js";

// Hard server-side cap per the build prompt's rendering budget: the UI warns past ~2,000
// visible elements and should fall back to aggregation past ~10,000, but the API never hands
// the client an unbounded subgraph to begin with regardless of what the UI does with it.
const MAX_NODES = 500;

const graphRoutes: FastifyPluginAsync = async (app) => {
  app.get("/graph/expand", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const q = request.query as { nodeId?: string; hops?: string; purpose?: string };
    if (!q.nodeId) return reply.code(400).send({ error: "nodeId is required" });
    const hops = Math.min(Math.max(Number(q.hops ?? 1), 1), 3);
    const purpose = q.purpose ?? "graph exploration during investigation";

    const result = await withRequestContext(request.ctx, async (client) => {
      // The recursive CTE walks `edges`, which carries RLS — a low-clearance session's
      // traversal simply cannot cross an edge it isn't cleared to see, no separate check needed.
      const { rows: nodeRows } = await client.query(
        `WITH RECURSIVE expansion(object_id, depth) AS (
           SELECT $1::uuid, 0
           UNION
           SELECT CASE WHEN e.source_object_id = ex.object_id THEN e.target_object_id ELSE e.source_object_id END,
                  ex.depth + 1
           FROM edges e
           JOIN expansion ex ON e.source_object_id = ex.object_id OR e.target_object_id = ex.object_id
           WHERE ex.depth < $2
         )
         SELECT object_id, min(depth) AS depth FROM expansion GROUP BY object_id ORDER BY depth LIMIT $3`,
        [q.nodeId, hops, MAX_NODES + 1],
      );

      const truncated = nodeRows.length > MAX_NODES;
      const ids = nodeRows.slice(0, MAX_NODES).map((r) => r.object_id);

      const { rows: nodes } = await client.query(
        `SELECT o.id, ot.name AS object_type, o.properties, o.classification
         FROM objects o JOIN object_types ot ON ot.id = o.object_type_id
         WHERE o.id = ANY($1::uuid[])`,
        [ids],
      );

      const { rows: edges } = await client.query(
        `SELECT e.id, e.source_object_id, e.target_object_id, rt.name AS relationship,
                e.properties, e.classification
         FROM edges e JOIN relationship_types rt ON rt.id = e.relationship_type_id
         WHERE e.source_object_id = ANY($1::uuid[]) AND e.target_object_id = ANY($1::uuid[])`,
        [ids],
      );

      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "graph.expand",
        resourceType: "object",
        resourceId: q.nodeId!,
        purpose,
        details: { hops, nodeCount: nodes.length, truncated },
      });

      return { nodes, edges, truncated, requestedHops: hops };
    });

    reply.send(result);
  });
};

export default graphRoutes;

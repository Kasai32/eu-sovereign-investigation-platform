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

  // Server-side shortest path via a bounded recursive CTE — per the build prompt, path-finding
  // must not be done by pulling the whole graph to the client and walking it in JS. Explores
  // simple paths (no repeated nodes) up to MAX_PATH_HOPS; fine for this dataset's scale. A
  // denser production graph would need a proper early-exit bidirectional BFS or a graph DB
  // (the v2 escape hatch the build prompt already anticipates), not this brute-force expansion.
  const MAX_PATH_HOPS = 6;

  app.get("/graph/path", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const q = request.query as { from?: string; to?: string; purpose?: string };
    if (!q.from || !q.to) return reply.code(400).send({ error: "from and to are required" });
    const purpose = q.purpose ?? "path-finding during investigation";

    const result = await withRequestContext(request.ctx, async (client) => {
      const { rows } = await client.query(
        `WITH RECURSIVE search(node_id, path, depth) AS (
           SELECT $1::uuid, ARRAY[$1::uuid], 0
           UNION ALL
           SELECT
             CASE WHEN e.source_object_id = s.node_id THEN e.target_object_id ELSE e.source_object_id END,
             s.path || (CASE WHEN e.source_object_id = s.node_id THEN e.target_object_id ELSE e.source_object_id END),
             s.depth + 1
           FROM edges e
           JOIN search s ON e.source_object_id = s.node_id OR e.target_object_id = s.node_id
           WHERE s.depth < $3
             AND NOT (CASE WHEN e.source_object_id = s.node_id THEN e.target_object_id ELSE e.source_object_id END = ANY(s.path))
         )
         SELECT path, depth FROM search WHERE node_id = $2::uuid ORDER BY depth ASC LIMIT 1`,
        [q.from, q.to, MAX_PATH_HOPS],
      );

      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "graph.path",
        resourceType: "object",
        resourceId: q.from!,
        purpose,
        details: { to: q.to, found: rows.length > 0 },
      });

      if (rows.length === 0) return { found: false, nodes: [], edges: [] };

      const pathIds: string[] = rows[0].path;
      const { rows: nodes } = await client.query(
        `SELECT o.id, ot.name AS object_type, o.properties, o.classification
         FROM objects o JOIN object_types ot ON ot.id = o.object_type_id
         WHERE o.id = ANY($1::uuid[])`,
        [pathIds],
      );

      // One connecting edge per consecutive pair in the path (lowest id if several exist).
      // A plain loop over at most MAX_PATH_HOPS pairs is simpler and more obviously correct
      // than trying to batch this into one query.
      const edges: unknown[] = [];
      for (let i = 0; i < pathIds.length - 1; i++) {
        const { rows: pairEdges } = await client.query(
          `SELECT e.id, e.source_object_id, e.target_object_id, rt.name AS relationship,
                  e.properties, e.classification
           FROM edges e JOIN relationship_types rt ON rt.id = e.relationship_type_id
           WHERE (e.source_object_id = $1 AND e.target_object_id = $2)
              OR (e.source_object_id = $2 AND e.target_object_id = $1)
           ORDER BY e.id LIMIT 1`,
          [pathIds[i], pathIds[i + 1]],
        );
        if (pairEdges[0]) edges.push(pairEdges[0]);
      }

      return { found: true, path: pathIds, hops: rows[0].depth, nodes, edges };
    });

    reply.send(result);
  });
};

export default graphRoutes;

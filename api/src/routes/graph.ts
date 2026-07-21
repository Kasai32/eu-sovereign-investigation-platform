import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../db.js";
import { writeAudit } from "../audit.js";

// Hard server-side cap per the build prompt's rendering budget: the UI warns past ~2,000
// visible elements and should fall back to aggregation past ~10,000, but the API never hands
// the client an unbounded subgraph to begin with regardless of what the UI does with it.
const MAX_NODES = 500;

// Caps how many edges are followed out of any single node per recursion step. Without this,
// the recursive CTE's only limits were depth (hops) and a final LIMIT applied after the full
// expansion materialized — a hub entity (e.g. a shared address linked to thousands of accounts,
// a realistic fraud-ring pattern) could force Postgres to build a combinatorially large
// intermediate result before that final LIMIT ever took effect.
const MAX_FANOUT_PER_NODE = 50;

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
           SELECT nxt.neighbor_id, ex.depth + 1
           FROM expansion ex
           CROSS JOIN LATERAL (
             SELECT CASE WHEN e.source_object_id = ex.object_id THEN e.target_object_id ELSE e.source_object_id END AS neighbor_id
             FROM edges e
             WHERE e.source_object_id = ex.object_id OR e.target_object_id = ex.object_id
             LIMIT $4
           ) nxt
           WHERE ex.depth < $2
         )
         SELECT object_id, min(depth) AS depth FROM expansion GROUP BY object_id ORDER BY depth LIMIT $3`,
        [q.nodeId, hops, MAX_NODES + 1, MAX_FANOUT_PER_NODE],
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

  // Shortest path via an app-level breadth-first search, one hop per round trip, tracking only
  // visited node ids rather than every candidate path. The original version was a single
  // recursive CTE that tracked a full path array per candidate (per the build prompt's
  // "path-finding must not be done by pulling the whole graph to the client and walking it in
  // JS" — the CTE itself was the server-side equivalent of that). A 1M-object/5M-edge load test
  // found it timed out well before its own advertised MAX_PATH_HOPS: candidate-path count grows
  // combinatorially with fan-out^hops when every path is tracked separately, and no per-node
  // fan-out cap fixes that (capping enough to stay fast made the search silently skip most of a
  // node's real neighbors, so it could report "no path" when one existed). Tracking only visited
  // nodes instead makes total work linear in edges actually examined.
  //
  // MAX_PATH_EDGES_EXAMINED is a real, deliberate tradeoff, not just a safety margin: on the same
  // load-test graph (median node degree 8, one connected component), unidirectional BFS between
  // two arbitrary nodes several hops apart can legitimately need to touch a large fraction of the
  // whole graph on its last hop before the frontier reaches the target — small-world graphs grow
  // near-exponentially per hop, so the hop that finds a distant target is often as expensive as
  // every previous hop combined (observed: one real 4-hop pair required 778k edges examined and
  // ~390k of the graph's 1M nodes visited to connect). Chasing full completeness would mean no
  // fixed budget keeps this under the 3s target for every pair. 150k stays comfortably under 3s
  // in every case measured (worst observed: ~1s), at the cost of occasionally reporting "not
  // found within budget" (budgetExceeded: true) for pairs that are genuinely connected but distant
  // — an honest "didn't finish searching" rather than a wrong "no path exists" or a hang. A
  // bidirectional BFS (search from both ends, meet in the middle) would close this gap for real —
  // that's what the original comment's "early-exit bidirectional BFS" meant — but is a larger
  // rewrite than this pass; worth doing before path-finding is relied on for genuinely distant
  // pairs rather than the "does X connect to Y within a few hops" queries this mainly serves.
  const MAX_PATH_HOPS = 6;
  const MAX_PATH_EDGES_EXAMINED = 150_000;

  app.get("/graph/path", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const q = request.query as { from?: string; to?: string; purpose?: string };
    if (!q.from || !q.to) return reply.code(400).send({ error: "from and to are required" });
    const purpose = q.purpose ?? "path-finding during investigation";
    const from = q.from;
    const to = q.to;

    const result = await withRequestContext(request.ctx, async (client) => {
      const parent = new Map<string, string>();
      const visited = new Set<string>([from]);
      let frontier = [from];
      let found = from === to;
      let edgesExamined = 0;
      let hopsTaken = 0;

      while (!found && frontier.length > 0 && hopsTaken < MAX_PATH_HOPS && edgesExamined < MAX_PATH_EDGES_EXAMINED) {
        hopsTaken++;
        const frontierSet = new Set(frontier);
        const remainingBudget = MAX_PATH_EDGES_EXAMINED - edgesExamined;
        const { rows: edgeRows } = await client.query<{ source_object_id: string; target_object_id: string }>(
          `SELECT source_object_id, target_object_id FROM edges
           WHERE source_object_id = ANY($1::uuid[]) OR target_object_id = ANY($1::uuid[])
           LIMIT $2`,
          [frontier, remainingBudget],
        );
        edgesExamined += edgeRows.length;

        const nextFrontier: string[] = [];
        for (const row of edgeRows) {
          const inFrontier = frontierSet.has(row.source_object_id) ? row.source_object_id : row.target_object_id;
          const neighbor = inFrontier === row.source_object_id ? row.target_object_id : row.source_object_id;
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          parent.set(neighbor, inFrontier);
          nextFrontier.push(neighbor);
          if (neighbor === to) {
            found = true;
            break;
          }
        }
        frontier = nextFrontier;
      }

      // Budget exhausted before either finding the target or exploring every reachable node
      // within MAX_PATH_HOPS: some real neighbors were never queried, so a "not found" here
      // means "not found within the search budget," not "provably no path exists."
      const budgetExceeded = !found && edgesExamined >= MAX_PATH_EDGES_EXAMINED;

      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "graph.path",
        resourceType: "object",
        resourceId: from,
        purpose,
        details: { to, found, hops: hopsTaken, edgesExamined, budgetExceeded },
      });

      if (!found) return { found: false as const, nodes: [], edges: [], budgetExceeded };

      const pathIds: string[] = [to];
      for (let cur = to; cur !== from; ) {
        const p = parent.get(cur)!;
        pathIds.push(p);
        cur = p;
      }
      pathIds.reverse();

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

      return { found: true as const, path: pathIds, hops: pathIds.length - 1, nodes, edges };
    });

    reply.send(result);
  });
};

export default graphRoutes;

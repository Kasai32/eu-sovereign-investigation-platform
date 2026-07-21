-- Times the exact query shapes used by the API (graph.ts, objects.ts, ingestion.ts) against
-- whatever data currently exists in the database. Run after db/scripts/loadtest-generate.sh.
-- Uses EXPLAIN ANALYZE rather than the API itself so RLS/auth are exercised at the SQL level
-- (which is where every one of these query shapes actually spends its time) without needing a
-- live Keycloak token for a load-test session.

\timing on

\echo '=== picking a random node and the highest-degree (hub) node to expand from ==='
SELECT id AS random_node FROM objects WHERE properties->>'_lt' = 'true' OFFSET floor(random()*1000000) LIMIT 1 \gset
SELECT source_object_id AS hub_node, count(*) AS degree
FROM edges WHERE properties->>'_lt' = 'true'
GROUP BY source_object_id ORDER BY count(*) DESC LIMIT 1 \gset

\echo random node: :random_node
\echo hub node: :hub_node (degree: :degree)

-- Session context: RESTRICTED clearance so RLS never filters anything out (worst case for
-- volume — a lower clearance would only ever see fewer rows, never more work).
SET app.actor_role = 'admin';
SET app.current_clearance = 'RESTRICTED';
SET app.current_user_id = '11111111-1111-1111-1111-111111111104';

\echo ''
\echo '=== /graph/expand: 2-hop from a random node (blueprint target: <3s) ==='
EXPLAIN (ANALYZE, BUFFERS, TIMING)
WITH RECURSIVE expansion(object_id, depth) AS (
  SELECT :'random_node'::uuid, 0
  UNION
  SELECT nxt.neighbor_id, ex.depth + 1
  FROM expansion ex
  CROSS JOIN LATERAL (
    SELECT CASE WHEN e.source_object_id = ex.object_id THEN e.target_object_id ELSE e.source_object_id END AS neighbor_id
    FROM edges e
    WHERE e.source_object_id = ex.object_id OR e.target_object_id = ex.object_id
    LIMIT 50
  ) nxt
  WHERE ex.depth < 2
)
SELECT object_id, min(depth) AS depth FROM expansion GROUP BY object_id ORDER BY depth LIMIT 501;

\echo ''
\echo '=== /graph/expand: 2-hop from the highest-degree hub node (worst case for the fan-out cap) ==='
EXPLAIN (ANALYZE, BUFFERS, TIMING)
WITH RECURSIVE expansion(object_id, depth) AS (
  SELECT :'hub_node'::uuid, 0
  UNION
  SELECT nxt.neighbor_id, ex.depth + 1
  FROM expansion ex
  CROSS JOIN LATERAL (
    SELECT CASE WHEN e.source_object_id = ex.object_id THEN e.target_object_id ELSE e.source_object_id END AS neighbor_id
    FROM edges e
    WHERE e.source_object_id = ex.object_id OR e.target_object_id = ex.object_id
    LIMIT 50
  ) nxt
  WHERE ex.depth < 2
)
SELECT object_id, min(depth) AS depth FROM expansion GROUP BY object_id ORDER BY depth LIMIT 501;

\echo ''
\echo '=== /graph/expand: 3-hop from the hub node (max allowed hops) ==='
EXPLAIN (ANALYZE, BUFFERS, TIMING)
WITH RECURSIVE expansion(object_id, depth) AS (
  SELECT :'hub_node'::uuid, 0
  UNION
  SELECT nxt.neighbor_id, ex.depth + 1
  FROM expansion ex
  CROSS JOIN LATERAL (
    SELECT CASE WHEN e.source_object_id = ex.object_id THEN e.target_object_id ELSE e.source_object_id END AS neighbor_id
    FROM edges e
    WHERE e.source_object_id = ex.object_id OR e.target_object_id = ex.object_id
    LIMIT 50
  ) nxt
  WHERE ex.depth < 3
)
SELECT object_id, min(depth) AS depth FROM expansion GROUP BY object_id ORDER BY depth LIMIT 501;

\echo ''
\echo '=== /objects search: trigram name search (objects.ts) ==='
SET pg_trgm.similarity_threshold = 0.2;
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT o.id, ot.name AS object_type, o.properties, o.classification, o.created_at
FROM objects o JOIN object_types ot ON ot.id = o.object_type_id
WHERE (o.properties->>'name') % 'James Smith'
ORDER BY o.created_at DESC
LIMIT 50 OFFSET 0;

\echo ''
\echo '=== ingestion entity-resolution match query (ingestion.ts), against the Person type ==='
SELECT id AS person_type_id FROM object_types WHERE name = 'Person' \gset
SET pg_trgm.similarity_threshold = 0.55;
EXPLAIN (ANALYZE, BUFFERS, TIMING)
SELECT id, similarity(properties->>'name', 'James Smith') AS sim
FROM objects
WHERE object_type_id = :'person_type_id' AND id <> :'random_node' AND canonical_of IS NULL
  AND (properties->>'name') % 'James Smith'
ORDER BY sim DESC LIMIT 1;

\echo ''
\echo '=== /graph/path: shortest path between two random nodes (up to 6 hops) ==='
\echo 'NOTE: unlike /graph/expand, this endpoint has no fan-out cap (not part of this review pass) — 30s timeout guard in case it explodes at this scale.'
SELECT id AS random_node2 FROM objects WHERE properties->>'_lt' = 'true' OFFSET floor(random()*1000000) LIMIT 1 \gset
SET statement_timeout = '30s';
EXPLAIN (ANALYZE, BUFFERS, TIMING)
WITH RECURSIVE search(node_id, path, depth) AS (
  SELECT :'random_node'::uuid, ARRAY[:'random_node'::uuid], 0
  UNION ALL
  SELECT
    CASE WHEN e.source_object_id = s.node_id THEN e.target_object_id ELSE e.source_object_id END,
    s.path || (CASE WHEN e.source_object_id = s.node_id THEN e.target_object_id ELSE e.source_object_id END),
    s.depth + 1
  FROM edges e
  JOIN search s ON e.source_object_id = s.node_id OR e.target_object_id = s.node_id
  WHERE s.depth < 6
    AND NOT (CASE WHEN e.source_object_id = s.node_id THEN e.target_object_id ELSE e.source_object_id END = ANY(s.path))
)
SELECT path, depth FROM search WHERE node_id = :'random_node2'::uuid ORDER BY depth ASC LIMIT 1;

\echo ''
\echo '=== table sizes ==='
SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS total_size
FROM pg_class WHERE relname IN ('objects','edges') ORDER BY relname;

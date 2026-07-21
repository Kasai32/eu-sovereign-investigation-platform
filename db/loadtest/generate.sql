-- Generates synthetic objects/edges at a configurable scale to validate performance against the
-- blueprint's stated target (>=1M objects / 5M edges, 2-hop expand <3s). Every row this script
-- creates is tagged {"_lt": true} in its properties so db/loadtest/cleanup.sql can remove
-- exactly this data and nothing else (existing seed/dev data is left untouched).
--
-- Invoke via psql -v obj_count=1000000 -v edge_count=5000000 -f generate.sql
-- (db/scripts/loadtest-generate.sh wraps this with sane defaults).
--
-- Edge source selection is skewed toward low-index objects (power(random(),3)) so a handful of
-- objects end up as high-degree hub nodes, deliberately mirroring the "shared address linked to
-- thousands of accounts" fraud-ring pattern called out as the realistic worst case for
-- /graph/expand's recursive CTE.

\timing on
\set ON_ERROR_STOP on

BEGIN;
SET LOCAL work_mem = '256MB';
SET LOCAL maintenance_work_mem = '512MB';

CREATE TEMP TABLE lt_type_ids AS
SELECT (row_number() OVER ())::int AS idx, id FROM object_types;

DO $$
DECLARE ids uuid[]; rel_ids uuid[];
BEGIN
  SELECT array_agg(id) INTO ids FROM object_types;
  PERFORM set_config('lt.type_ids', array_to_string(ids, ','), true);
  SELECT array_agg(id) INTO rel_ids FROM relationship_types;
  PERFORM set_config('lt.rel_ids', array_to_string(rel_ids, ','), true);
END $$;

\echo 'generating objects...'
INSERT INTO objects (id, object_type_id, properties, classification, created_at)
SELECT
  gen_random_uuid(),
  (string_to_array(current_setting('lt.type_ids'), ',')::uuid[])[1 + floor(random() * array_length(string_to_array(current_setting('lt.type_ids'), ','), 1))::int],
  jsonb_build_object(
    'name',
    (ARRAY['James','Mary','John','Patricia','Robert','Jennifer','Michael','Linda','William','Elizabeth',
           'David','Barbara','Richard','Susan','Joseph','Jessica','Thomas','Sarah','Charles','Karen',
           'Christopher','Nancy','Daniel','Lisa','Matthew','Betty','Anthony','Margaret','Mark','Sandra',
           'Donald','Ashley','Steven','Kimberly','Paul','Emily','Andrew','Donna','Joshua','Michelle'])
      [1 + floor(random() * 40)::int]
    || ' ' ||
    (ARRAY['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez',
           'Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin',
           'Lee','Perez','Thompson','White','Harris','Sanchez','Clark','Ramirez','Lewis','Robinson',
           'Walker','Young','Allen','King','Wright','Scott','Torres','Nguyen','Hill','Flores'])
      [1 + floor(random() * 40)::int],
    '_lt', true
  ),
  (ARRAY['PUBLIC','INTERNAL','INTERNAL','INTERNAL','SENSITIVE','SENSITIVE','RESTRICTED']::classification_level[])
    [1 + floor(random() * 7)::int],
  now()
FROM generate_series(1, :obj_count);

\echo 'indexing generated object ids for edge generation...'
CREATE TEMP TABLE lt_obj_ids (idx int PRIMARY KEY, id uuid);
INSERT INTO lt_obj_ids
SELECT (row_number() OVER ())::int, id FROM objects WHERE properties->>'_lt' = 'true';

\echo 'generating edges...'
-- random() must be materialized once per row in a subquery, not referenced directly in a join
-- condition: Postgres re-evaluates a volatile function on every candidate row a join filter
-- scans, not once per output row, which silently produces the wrong row count (caught during
-- a small-scale dry run of this script: 100k requested edges produced 300k).
INSERT INTO edges (source_object_id, target_object_id, relationship_type_id, properties, classification, source, confidence)
SELECT
  src.id,
  tgt.id,
  (string_to_array(current_setting('lt.rel_ids'), ',')::uuid[])[1 + floor(random() * array_length(string_to_array(current_setting('lt.rel_ids'), ','), 1))::int],
  '{"_lt": true}'::jsonb,
  (ARRAY['PUBLIC','INTERNAL','INTERNAL','INTERNAL','SENSITIVE','SENSITIVE','RESTRICTED']::classification_level[])
    [1 + floor(random() * 7)::int],
  'loadtest_generator',
  round((0.5 + random() * 0.5)::numeric, 3)
FROM (
  SELECT
    1 + floor(power(random(), 3) * :obj_count)::int AS src_idx,
    1 + floor(random() * :obj_count)::int AS tgt_idx
  FROM generate_series(1, :edge_count)
) picks
JOIN lt_obj_ids src ON src.idx = picks.src_idx
JOIN lt_obj_ids tgt ON tgt.idx = picks.tgt_idx
WHERE src.id <> tgt.id;

COMMIT;

\echo 'analyzing...'
ANALYZE objects;
ANALYZE edges;

\echo 'done. row counts:'
SELECT
  (SELECT count(*) FROM objects WHERE properties->>'_lt' = 'true') AS lt_objects,
  (SELECT count(*) FROM edges WHERE properties->>'_lt' = 'true') AS lt_edges;

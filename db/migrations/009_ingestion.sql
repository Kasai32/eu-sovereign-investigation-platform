-- S5 (data intake) + the tables S6's resolution queue was already designed against in Phase 0
-- (resolution_queue, objects.canonical_of). Deliberate v1 scope per the blueprint: file upload
-- only, no live connectors.

DO $$ BEGIN
  CREATE TYPE ingestion_run_status AS ENUM ('pending', 'running', 'completed', 'completed_with_errors', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ingestion_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  default_classification classification_level NOT NULL DEFAULT 'INTERNAL',
  retention_days int,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A mapping template targets exactly one object type per v1 scope: "map this CSV to Person
-- rows", not a generalized multi-entity-per-row mapper. match_property names which mapped
-- property is used for fuzzy entity-resolution against existing objects of the same type.
CREATE TABLE IF NOT EXISTS column_mapping_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES ingestion_sources(id) ON DELETE CASCADE,
  name text NOT NULL,
  object_type_id uuid NOT NULL REFERENCES object_types(id),
  match_property text NOT NULL,
  mapping jsonb NOT NULL,  -- { "csv column name": "property_key", ... }
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES ingestion_sources(id),
  template_id uuid NOT NULL REFERENCES column_mapping_templates(id),
  filename text NOT NULL,
  status ingestion_run_status NOT NULL DEFAULT 'pending',
  records_total int NOT NULL DEFAULT 0,
  records_ingested int NOT NULL DEFAULT 0,
  records_quarantined int NOT NULL DEFAULT 0,
  records_auto_merged int NOT NULL DEFAULT 0,
  records_queued_for_review int NOT NULL DEFAULT 0,
  started_by uuid NOT NULL REFERENCES app_users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ingestion_runs_source ON ingestion_runs(source_id, started_at);

CREATE TABLE IF NOT EXISTS ingestion_run_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES ingestion_runs(id) ON DELETE CASCADE,
  row_number int NOT NULL,
  raw_row jsonb NOT NULL,
  error_message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_run_errors_run ON ingestion_run_errors(run_id);

GRANT SELECT, INSERT, UPDATE ON ingestion_sources, column_mapping_templates, ingestion_runs, ingestion_run_errors TO app_user;

-- Sources/templates are schema-shaping (like object_types): readable by everyone, writable
-- only by admins. Triggering/viewing runs is restricted to supervisor/compliance/admin —
-- deliberately not open to plain analysts, matching "access control before ingestion" from
-- the build prompt's working process.
ALTER TABLE ingestion_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY ingestion_sources_select ON ingestion_sources FOR SELECT USING (true);
CREATE POLICY ingestion_sources_insert ON ingestion_sources FOR INSERT
  WITH CHECK (current_setting('app.actor_role', true) = 'admin');

ALTER TABLE column_mapping_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE column_mapping_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY column_mapping_templates_select ON column_mapping_templates FOR SELECT USING (true);
CREATE POLICY column_mapping_templates_insert ON column_mapping_templates FOR INSERT
  WITH CHECK (current_setting('app.actor_role', true) = 'admin');

ALTER TABLE ingestion_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY ingestion_runs_select ON ingestion_runs FOR SELECT
  USING (current_setting('app.actor_role', true) IN ('supervisor', 'compliance', 'admin'));
CREATE POLICY ingestion_runs_insert ON ingestion_runs FOR INSERT
  WITH CHECK (current_setting('app.actor_role', true) IN ('supervisor', 'compliance', 'admin'));
CREATE POLICY ingestion_runs_update ON ingestion_runs FOR UPDATE
  USING (current_setting('app.actor_role', true) IN ('supervisor', 'compliance', 'admin'));

ALTER TABLE ingestion_run_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_run_errors FORCE ROW LEVEL SECURITY;
CREATE POLICY ingestion_run_errors_select ON ingestion_run_errors FOR SELECT
  USING (current_setting('app.actor_role', true) IN ('supervisor', 'compliance', 'admin'));
CREATE POLICY ingestion_run_errors_insert ON ingestion_run_errors FOR INSERT
  WITH CHECK (current_setting('app.actor_role', true) IN ('supervisor', 'compliance', 'admin'));

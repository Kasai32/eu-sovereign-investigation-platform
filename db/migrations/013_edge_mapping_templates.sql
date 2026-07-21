-- Closes DECISIONS.md #16: column_mapping_templates only ever produced objects from a CSV —
-- there was no way to ingest a file that creates edges between two *existing* objects (e.g. a
-- transactions file mapping to transacted_with relationships between two accounts), even though
-- the seed data itself models transactions as edges. An edge-mapping template doesn't create
-- objects; each row must match an already-existing source and target object (by a chosen
-- property) or the row quarantines — there's no equivalent of object ingestion's auto-merge
-- here, since there's nothing to merge, only an edge to create or not.
CREATE TABLE IF NOT EXISTS edge_mapping_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES ingestion_sources(id) ON DELETE CASCADE,
  name text NOT NULL,
  relationship_type_id uuid NOT NULL REFERENCES relationship_types(id),
  source_object_type_id uuid NOT NULL REFERENCES object_types(id),
  source_match_column text NOT NULL,   -- CSV column identifying the edge's source object
  source_match_property text NOT NULL, -- object property that column's value must match
  target_object_type_id uuid NOT NULL REFERENCES object_types(id),
  target_match_column text NOT NULL,
  target_match_property text NOT NULL,
  property_mapping jsonb NOT NULL DEFAULT '{}', -- { "csv column name": "edge property_key", ... }
  default_classification classification_level NOT NULL DEFAULT 'INTERNAL',
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- An ingestion run now targets exactly one of column_mapping_templates (object ingestion) or
-- edge_mapping_templates (edge ingestion), never both and never neither.
ALTER TABLE ingestion_runs ALTER COLUMN template_id DROP NOT NULL;
ALTER TABLE ingestion_runs ADD COLUMN IF NOT EXISTS edge_template_id uuid REFERENCES edge_mapping_templates(id);
ALTER TABLE ingestion_runs DROP CONSTRAINT IF EXISTS ingestion_runs_exactly_one_template;
ALTER TABLE ingestion_runs ADD CONSTRAINT ingestion_runs_exactly_one_template
  CHECK ((template_id IS NOT NULL) <> (edge_template_id IS NOT NULL));

GRANT SELECT, INSERT ON edge_mapping_templates TO app_user;

-- Same RLS posture as column_mapping_templates: schema-shaping data, readable by everyone,
-- writable only by admins.
ALTER TABLE edge_mapping_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_mapping_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY edge_mapping_templates_select ON edge_mapping_templates FOR SELECT USING (true);
CREATE POLICY edge_mapping_templates_insert ON edge_mapping_templates FOR INSERT
  WITH CHECK (current_setting('app.actor_role', true) = 'admin');

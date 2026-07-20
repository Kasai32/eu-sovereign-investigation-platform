-- Ontology core: object types are data, not code. New object types must not require a deploy.

CREATE TABLE IF NOT EXISTS object_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  property_schema jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_type_id uuid NOT NULL REFERENCES object_types(id),
  properties jsonb NOT NULL DEFAULT '{}',
  classification classification_level NOT NULL DEFAULT 'INTERNAL',
  canonical_of uuid REFERENCES objects(id),  -- set after entity-resolution merge; NULL = not a duplicate
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_objects_type ON objects(object_type_id);
CREATE INDEX IF NOT EXISTS idx_objects_canonical_of ON objects(canonical_of);
CREATE INDEX IF NOT EXISTS idx_objects_properties_gin ON objects USING gin(properties jsonb_path_ops);
-- Fuzzy-match index for entity resolution: trigram similarity over a common "name" property.
CREATE INDEX IF NOT EXISTS idx_objects_name_trgm ON objects USING gin ((properties->>'name') gin_trgm_ops);

CREATE TABLE IF NOT EXISTS object_property_meta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  property_key text NOT NULL,
  source text NOT NULL,
  confidence numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  classification classification_level NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  raw_source_ref text
);

CREATE INDEX IF NOT EXISTS idx_property_meta_object ON object_property_meta(object_id, property_key);

CREATE TABLE IF NOT EXISTS relationship_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  from_object_type_id uuid REFERENCES object_types(id),
  to_object_type_id uuid REFERENCES object_types(id)
);

CREATE TABLE IF NOT EXISTS edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_object_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  target_object_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  relationship_type_id uuid NOT NULL REFERENCES relationship_types(id),
  properties jsonb DEFAULT '{}',
  classification classification_level NOT NULL DEFAULT 'INTERNAL',
  source text,
  confidence numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_object_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_object_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(relationship_type_id);

-- Entity-resolution review queue. Ambiguous matches land here; nothing auto-merges above a
-- human review boundary. Merge sets objects.canonical_of on the duplicate (reversible) rather
-- than deleting it, so a bad merge can be undone and the merge itself is auditable.
CREATE TABLE IF NOT EXISTS resolution_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_a_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  object_b_id uuid NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  similarity_score numeric(5,4) NOT NULL,
  decision resolution_decision NOT NULL DEFAULT 'pending',
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (object_a_id <> object_b_id)
);

CREATE INDEX IF NOT EXISTS idx_resolution_queue_pending ON resolution_queue(decision) WHERE decision = 'pending';

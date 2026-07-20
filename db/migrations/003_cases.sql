-- App users (local dev auth model). Real SSO/OIDC via Keycloak is a build-prompt Phase 1 item;
-- this table is what RLS session variables are populated from until then.
CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  display_name text NOT NULL,
  role app_user_role NOT NULL DEFAULT 'analyst',
  clearance classification_level NOT NULL DEFAULT 'INTERNAL',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE resolution_queue
  ADD CONSTRAINT fk_resolution_queue_decided_by FOREIGN KEY (decided_by) REFERENCES app_users(id);

CREATE TABLE IF NOT EXISTS cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  status case_status NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'normal',
  classification classification_level NOT NULL DEFAULT 'INTERNAL',
  created_by uuid NOT NULL REFERENCES app_users(id),
  assigned_to uuid REFERENCES app_users(id),
  -- Frozen on close: the specific object/edge IDs the report relied on, so later data
  -- changes never silently rewrite a finalized report's basis.
  evidence_snapshot jsonb,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_assigned_to ON cases(assigned_to);

CREATE TABLE IF NOT EXISTS case_members (
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, user_id)
);

CREATE TABLE IF NOT EXISTS case_entities (
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  object_id uuid NOT NULL REFERENCES objects(id),
  pinned_by uuid NOT NULL REFERENCES app_users(id),
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, object_id)
);

CREATE TABLE IF NOT EXISTS case_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES app_users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
  -- Append-only by convention at the API layer for now; a DB-level immutability trigger
  -- (like audit_log's) is a candidate hardening item if note-tampering becomes a real risk.
);

CREATE TABLE IF NOT EXISTS case_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  object_id uuid REFERENCES objects(id),  -- links to a Document object if ingested into the ontology
  filename text NOT NULL,
  storage_ref text NOT NULL,
  classification classification_level NOT NULL DEFAULT 'INTERNAL',
  uploaded_by uuid NOT NULL REFERENCES app_users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- Per-case activity trail, distinct from the global audit_log: this is case-scoped UX
-- ("what happened in this case"), audit_log is compliance-scoped ("who accessed what, why").
-- Both are populated from the same write path so they never drift.
CREATE TABLE IF NOT EXISTS case_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES app_users(id),
  action text NOT NULL,
  details jsonb DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_activity_case ON case_activity(case_id, occurred_at);

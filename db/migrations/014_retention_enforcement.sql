-- Retention enforcement (PRD v1.1 N4): per-source retention_days was stored since 009 but
-- never applied. Anonymizes, never deletes — 005 deliberately grants app_user no DELETE on
-- objects/edges/object_property_meta ("merges use canonical_of; cases close, they don't
-- disappear"). A scheduled sweep clears objects.properties/edges.properties to a marker via
-- UPDATE, which app_user already has grants for; the row, its id, its edges, and any case
-- linkage all stay intact.

-- A stable, real identity for the sweep's actor, not a bare UUID with nothing behind it — audit
-- entries and app_users listings need "who did this" to resolve to something inspectable in the
-- same UI a human actor's actions show up in, distinguishable from any analyst by name/email.
INSERT INTO app_users (id, email, display_name, role, clearance, is_active)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'system-retention@platform.local',
  'System — Retention Enforcement',
  'admin',
  'RESTRICTED',
  true
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS retention_enforcement_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  objects_anonymized int NOT NULL DEFAULT 0,
  edges_anonymized int NOT NULL DEFAULT 0,
  triggered_by uuid NOT NULL REFERENCES app_users(id)
);

CREATE INDEX IF NOT EXISTS idx_retention_runs_started ON retention_enforcement_runs(started_at);

GRANT SELECT, INSERT, UPDATE ON retention_enforcement_runs TO app_user;

-- Same visibility as the audit log this feeds into: compliance/admin/supervisor can see when
-- retention last ran, analysts can't. Writes are restricted to admin at the DB layer too (the
-- system actor's own role is 'admin'), not just an API-layer check a routing bug could bypass.
ALTER TABLE retention_enforcement_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_enforcement_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY retention_runs_select ON retention_enforcement_runs FOR SELECT
  USING (current_setting('app.actor_role', true) IN ('supervisor', 'compliance', 'admin'));
CREATE POLICY retention_runs_insert ON retention_enforcement_runs FOR INSERT
  WITH CHECK (current_setting('app.actor_role', true) = 'admin');
CREATE POLICY retention_runs_update ON retention_enforcement_runs FOR UPDATE
  USING (current_setting('app.actor_role', true) = 'admin')
  WITH CHECK (current_setting('app.actor_role', true) = 'admin');

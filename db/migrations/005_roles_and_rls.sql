-- Dedicated, non-superuser, non-owner application role. The app MUST connect as this role,
-- never as the migration/bootstrap role (postgres). Connecting as a superuser or table owner
-- makes every policy below a silent no-op — see the RLS test in db/scripts/test-rls.sh, which
-- proves this against real query results rather than trusting these policy definitions.
DO $$ BEGIN
  CREATE ROLE app_user LOGIN PASSWORD 'app_user_local_dev_only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE app_user WITH LOGIN PASSWORD 'app_user_local_dev_only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;

-- Ontology + case data: read/write, never delete (merges use canonical_of; cases close, they
-- don't disappear).
GRANT SELECT, INSERT, UPDATE ON
  objects, edges, object_property_meta, resolution_queue,
  cases, case_members, case_entities, case_notes, case_documents, case_activity,
  app_users, object_types, relationship_types
TO app_user;

-- Audit log: SELECT only, gated further by RLS below. No INSERT/UPDATE/DELETE grant at all —
-- the only write path is the SECURITY DEFINER function.
GRANT SELECT ON audit_log TO app_user;
GRANT EXECUTE ON FUNCTION write_audit_log(uuid, text, text, uuid, text, jsonb) TO app_user;
GRANT EXECUTE ON FUNCTION verify_audit_log() TO app_user;  -- API layer gates this to compliance/admin

-- ---------------------------------------------------------------------------
-- Row-level security. All policies key off session variables the API layer sets per request
-- after authenticating the user, e.g.:
--   SET LOCAL app.current_user_id = '...';
--   SET LOCAL app.actor_role = 'analyst';
--   SET LOCAL app.current_clearance = 'SENSITIVE';
-- current_setting(..., true) returns NULL if unset, and NULL comparisons are not TRUE, so an
-- API bug that forgets to set these variables fails closed (no rows visible) rather than open.
-- ---------------------------------------------------------------------------

ALTER TABLE objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE objects FORCE ROW LEVEL SECURITY;
CREATE POLICY objects_select ON objects FOR SELECT
  USING (classification <= current_setting('app.current_clearance', true)::classification_level);
CREATE POLICY objects_insert ON objects FOR INSERT
  WITH CHECK (classification <= current_setting('app.current_clearance', true)::classification_level);
CREATE POLICY objects_update ON objects FOR UPDATE
  USING (classification <= current_setting('app.current_clearance', true)::classification_level)
  WITH CHECK (classification <= current_setting('app.current_clearance', true)::classification_level);

ALTER TABLE edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE edges FORCE ROW LEVEL SECURITY;
CREATE POLICY edges_select ON edges FOR SELECT
  USING (classification <= current_setting('app.current_clearance', true)::classification_level);
CREATE POLICY edges_insert ON edges FOR INSERT
  WITH CHECK (classification <= current_setting('app.current_clearance', true)::classification_level);
CREATE POLICY edges_update ON edges FOR UPDATE
  USING (classification <= current_setting('app.current_clearance', true)::classification_level)
  WITH CHECK (classification <= current_setting('app.current_clearance', true)::classification_level);

-- Provenance is filtered independently of the object it describes, per the ontology design:
-- a SENSITIVE source note about an otherwise-INTERNAL object must not leak through the object row.
ALTER TABLE object_property_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_property_meta FORCE ROW LEVEL SECURITY;
CREATE POLICY property_meta_select ON object_property_meta FOR SELECT
  USING (classification <= current_setting('app.current_clearance', true)::classification_level);
CREATE POLICY property_meta_insert ON object_property_meta FOR INSERT
  WITH CHECK (classification <= current_setting('app.current_clearance', true)::classification_level);

ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases FORCE ROW LEVEL SECURITY;
CREATE POLICY cases_select ON cases FOR SELECT
  USING (
    classification <= current_setting('app.current_clearance', true)::classification_level
    AND (
      current_setting('app.actor_role', true) IN ('supervisor', 'compliance', 'admin')
      OR created_by = current_setting('app.current_user_id', true)::uuid
      OR assigned_to = current_setting('app.current_user_id', true)::uuid
      OR EXISTS (
        SELECT 1 FROM case_members cm
        WHERE cm.case_id = cases.id AND cm.user_id = current_setting('app.current_user_id', true)::uuid
      )
    )
  );
CREATE POLICY cases_insert ON cases FOR INSERT
  WITH CHECK (classification <= current_setting('app.current_clearance', true)::classification_level);
CREATE POLICY cases_update ON cases FOR UPDATE
  USING (classification <= current_setting('app.current_clearance', true)::classification_level)
  WITH CHECK (classification <= current_setting('app.current_clearance', true)::classification_level);

-- Case-scoped child tables inherit visibility from the parent case. The subquery against
-- `cases` is itself subject to cases' own RLS policy for the querying session, so this can't
-- be used to see into a case that cases_select would otherwise hide.
ALTER TABLE case_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_members FORCE ROW LEVEL SECURITY;
CREATE POLICY case_members_select ON case_members FOR SELECT
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_members.case_id));
CREATE POLICY case_members_insert ON case_members FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_members.case_id));

ALTER TABLE case_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_entities FORCE ROW LEVEL SECURITY;
CREATE POLICY case_entities_select ON case_entities FOR SELECT
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_entities.case_id));
CREATE POLICY case_entities_insert ON case_entities FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_entities.case_id));

ALTER TABLE case_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY case_notes_select ON case_notes FOR SELECT
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_notes.case_id));
CREATE POLICY case_notes_insert ON case_notes FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_notes.case_id));

ALTER TABLE case_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY case_documents_select ON case_documents FOR SELECT
  USING (
    classification <= current_setting('app.current_clearance', true)::classification_level
    AND EXISTS (SELECT 1 FROM cases c WHERE c.id = case_documents.case_id)
  );
CREATE POLICY case_documents_insert ON case_documents FOR INSERT
  WITH CHECK (
    classification <= current_setting('app.current_clearance', true)::classification_level
    AND EXISTS (SELECT 1 FROM cases c WHERE c.id = case_documents.case_id)
  );

ALTER TABLE case_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE case_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY case_activity_select ON case_activity FOR SELECT
  USING (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_activity.case_id));
CREATE POLICY case_activity_insert ON case_activity FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM cases c WHERE c.id = case_activity.case_id));

-- Object/relationship type definitions are schema metadata, not classified instance data:
-- readable by everyone, writable only by admins (schema changes are deliberate, not casual).
ALTER TABLE object_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_types FORCE ROW LEVEL SECURITY;
CREATE POLICY object_types_select ON object_types FOR SELECT USING (true);
CREATE POLICY object_types_insert ON object_types FOR INSERT
  WITH CHECK (current_setting('app.actor_role', true) = 'admin');
CREATE POLICY object_types_update ON object_types FOR UPDATE
  USING (current_setting('app.actor_role', true) = 'admin')
  WITH CHECK (current_setting('app.actor_role', true) = 'admin');

ALTER TABLE relationship_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_types FORCE ROW LEVEL SECURITY;
CREATE POLICY relationship_types_select ON relationship_types FOR SELECT USING (true);
CREATE POLICY relationship_types_insert ON relationship_types FOR INSERT
  WITH CHECK (current_setting('app.actor_role', true) = 'admin');

-- Audit log: compliance/admin only, enforced at the database, not just an `if (role !== ...)`
-- check in a route handler that a routing bug could bypass.
-- FORCE matters only for the table owner (app_user is never the owner, so it's bound by
-- audit_log_select_compliance regardless of FORCE). In local dev, migrations run as the
-- `postgres` superuser, which always bypasses RLS irrespective of FORCE, so write_audit_log()/
-- verify_audit_log() keep working. If production migrations instead run as a dedicated
-- non-superuser owner role, that role needs BYPASSRLS (safe: it's a DDL/migration role, never
-- the app's runtime connection role) or these SECURITY DEFINER functions will start failing
-- their own INSERT/SELECT once FORCE applies to them too.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_select_compliance ON audit_log FOR SELECT
  USING (current_setting('app.actor_role', true) IN ('compliance', 'admin'));
-- No INSERT/UPDATE/DELETE policy exists for any role: writes go exclusively through
-- write_audit_log(), and the immutability trigger in 004 blocks mutation outright.

-- app_users: everyone can see basic directory info (needed for assignee/author display);
-- only admins can change role or clearance.
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_users FORCE ROW LEVEL SECURITY;
CREATE POLICY app_users_select ON app_users FOR SELECT USING (true);
CREATE POLICY app_users_update ON app_users FOR UPDATE
  USING (current_setting('app.actor_role', true) = 'admin')
  WITH CHECK (current_setting('app.actor_role', true) = 'admin');

-- Resolution queue: visible to any authenticated analyst role (reviewers need to work the
-- queue). Known simplification, called out in the Phase 0 self-review: it does not yet inherit
-- the classification of the two candidate objects it references.
ALTER TABLE resolution_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE resolution_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY resolution_queue_select ON resolution_queue FOR SELECT
  USING (current_setting('app.actor_role', true) IN ('analyst', 'supervisor', 'compliance', 'admin'));
CREATE POLICY resolution_queue_insert ON resolution_queue FOR INSERT WITH CHECK (true);
CREATE POLICY resolution_queue_update ON resolution_queue FOR UPDATE
  USING (current_setting('app.actor_role', true) IN ('analyst', 'supervisor', 'compliance', 'admin'));

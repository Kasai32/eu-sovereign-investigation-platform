-- cases_select's EXISTS subquery on case_members, combined with case_members_select's EXISTS
-- subquery back on cases, forms a policy evaluation cycle: Postgres rejects it outright with
-- "infinite recursion detected in policy for relation cases" (42P17). Found live via
-- api/src/routes/cases.ts GET /cases/:id, not by inspection.
--
-- Fix: a SECURITY DEFINER function that computes case visibility once, bypassing RLS
-- internally (it runs as the function owner, not as app_user), so nothing recurses through
-- case_members' or cases' own policies while evaluating it.
CREATE OR REPLACE FUNCTION case_visible(p_case_id uuid) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM cases c
    WHERE c.id = p_case_id
      AND c.classification <= current_setting('app.current_clearance', true)::classification_level
      AND (
        current_setting('app.actor_role', true) IN ('supervisor', 'compliance', 'admin')
        OR c.created_by = current_setting('app.current_user_id', true)::uuid
        OR c.assigned_to = current_setting('app.current_user_id', true)::uuid
        OR EXISTS (
          SELECT 1 FROM case_members cm
          WHERE cm.case_id = c.id AND cm.user_id = current_setting('app.current_user_id', true)::uuid
        )
      )
  );
$$;

GRANT EXECUTE ON FUNCTION case_visible(uuid) TO app_user;

DROP POLICY IF EXISTS cases_select ON cases;
CREATE POLICY cases_select ON cases FOR SELECT USING (case_visible(id));

DROP POLICY IF EXISTS case_members_select ON case_members;
CREATE POLICY case_members_select ON case_members FOR SELECT USING (case_visible(case_id));
DROP POLICY IF EXISTS case_members_insert ON case_members;
CREATE POLICY case_members_insert ON case_members FOR INSERT WITH CHECK (case_visible(case_id));

DROP POLICY IF EXISTS case_entities_select ON case_entities;
CREATE POLICY case_entities_select ON case_entities FOR SELECT USING (case_visible(case_id));
DROP POLICY IF EXISTS case_entities_insert ON case_entities;
CREATE POLICY case_entities_insert ON case_entities FOR INSERT WITH CHECK (case_visible(case_id));

DROP POLICY IF EXISTS case_notes_select ON case_notes;
CREATE POLICY case_notes_select ON case_notes FOR SELECT USING (case_visible(case_id));
DROP POLICY IF EXISTS case_notes_insert ON case_notes;
CREATE POLICY case_notes_insert ON case_notes FOR INSERT WITH CHECK (case_visible(case_id));

DROP POLICY IF EXISTS case_documents_select ON case_documents;
CREATE POLICY case_documents_select ON case_documents FOR SELECT
  USING (
    classification <= current_setting('app.current_clearance', true)::classification_level
    AND case_visible(case_id)
  );
DROP POLICY IF EXISTS case_documents_insert ON case_documents;
CREATE POLICY case_documents_insert ON case_documents FOR INSERT
  WITH CHECK (
    classification <= current_setting('app.current_clearance', true)::classification_level
    AND case_visible(case_id)
  );

DROP POLICY IF EXISTS case_activity_select ON case_activity;
CREATE POLICY case_activity_select ON case_activity FOR SELECT USING (case_visible(case_id));
DROP POLICY IF EXISTS case_activity_insert ON case_activity;
CREATE POLICY case_activity_insert ON case_activity FOR INSERT WITH CHECK (case_visible(case_id));

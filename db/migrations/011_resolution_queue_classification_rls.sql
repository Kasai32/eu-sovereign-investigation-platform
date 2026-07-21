-- Closes the gap flagged in 005's comment and confirmed by external review: resolution_queue
-- was visible/actionable by any analyst role regardless of the classification of the two
-- candidate objects it references. An under-cleared reviewer could see and act on a queue entry
-- for a RESTRICTED pair. Combined with the app-layer fix in resolutionQueue.ts (checking
-- rowCount on the merge UPDATE), this closes both the access path and the silent-failure mode.
DROP POLICY IF EXISTS resolution_queue_select ON resolution_queue;
CREATE POLICY resolution_queue_select ON resolution_queue FOR SELECT
  USING (
    current_setting('app.actor_role', true) IN ('analyst', 'supervisor', 'compliance', 'admin')
    AND (SELECT o.classification FROM objects o WHERE o.id = object_a_id)
        <= current_setting('app.current_clearance', true)::classification_level
    AND (SELECT o.classification FROM objects o WHERE o.id = object_b_id)
        <= current_setting('app.current_clearance', true)::classification_level
  );

DROP POLICY IF EXISTS resolution_queue_update ON resolution_queue;
CREATE POLICY resolution_queue_update ON resolution_queue FOR UPDATE
  USING (
    current_setting('app.actor_role', true) IN ('analyst', 'supervisor', 'compliance', 'admin')
    AND (SELECT o.classification FROM objects o WHERE o.id = object_a_id)
        <= current_setting('app.current_clearance', true)::classification_level
    AND (SELECT o.classification FROM objects o WHERE o.id = object_b_id)
        <= current_setting('app.current_clearance', true)::classification_level
  )
  WITH CHECK (
    current_setting('app.actor_role', true) IN ('analyst', 'supervisor', 'compliance', 'admin')
    AND (SELECT o.classification FROM objects o WHERE o.id = object_a_id)
        <= current_setting('app.current_clearance', true)::classification_level
    AND (SELECT o.classification FROM objects o WHERE o.id = object_b_id)
        <= current_setting('app.current_clearance', true)::classification_level
  );

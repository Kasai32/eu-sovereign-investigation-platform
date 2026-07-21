-- S2's inspector needs a "remove from case" action (unpinning a mistakenly-added entity).
-- case_entities had no DELETE grant/policy — adding both here.
GRANT DELETE ON case_entities TO app_user;

CREATE POLICY case_entities_delete ON case_entities FOR DELETE USING (case_visible(case_id));

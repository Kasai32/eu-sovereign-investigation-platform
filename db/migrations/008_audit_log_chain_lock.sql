-- Real bug found via actual concurrent usage (CaseWorkspacePage fires GET /cases/:id and
-- GET /cases/:id/graph in parallel): write_audit_log()'s "SELECT last row_hash, then INSERT"
-- was not atomic against other writers. Two transactions committing within microseconds of
-- each other can both read the same "last" row before either inserts, both compute their
-- row_hash against that same prev_hash, and both succeed — forking the chain (two rows sharing
-- one prev_hash), which verify_audit_log() correctly reports as broken from that point on.
--
-- Fix: an advisory lock scoped to the transaction, taken before the read, serializes all
-- concurrent callers of write_audit_log() without requiring a schema change or locking the
-- whole table. Released automatically at COMMIT/ROLLBACK.
CREATE OR REPLACE FUNCTION write_audit_log(
  p_user_id uuid,
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_purpose text,
  p_details jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_ts timestamptz := now();
  v_prev_hash text;
  v_row_hash text;
BEGIN
  IF p_purpose IS NULL OR btrim(p_purpose) = '' THEN
    RAISE EXCEPTION 'purpose of use is required for audit_log entries';
  END IF;

  IF current_setting('app.current_user_id', true) IS NOT NULL
     AND current_setting('app.current_user_id', true)::uuid <> p_user_id THEN
    RAISE EXCEPTION 'write_audit_log: p_user_id does not match session actor';
  END IF;

  -- Serializes concurrent writers so the read-last-hash-then-insert below is effectively
  -- atomic. Cheap and uncontended in practice (audit writes aren't perf-critical at this
  -- scale); a busier deployment could shard this lock key by day/hour if it ever contends.
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));

  SELECT row_hash INTO v_prev_hash FROM audit_log ORDER BY seq DESC LIMIT 1;
  IF v_prev_hash IS NULL THEN
    v_prev_hash := repeat('0', 64);
  END IF;

  v_row_hash := encode(
    digest(
      v_prev_hash
      || p_user_id::text
      || p_action
      || coalesce(p_resource_type, '')
      || coalesce(p_resource_id::text, '')
      || p_purpose
      || v_ts::text
      || p_details::text,
      'sha256'
    ),
    'hex'
  );

  INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, purpose, details, occurred_at, prev_hash, row_hash)
  VALUES (v_id, p_user_id, p_action, p_resource_type, p_resource_id, p_purpose, p_details, v_ts, v_prev_hash, v_row_hash);

  RETURN v_id;
END;
$$;

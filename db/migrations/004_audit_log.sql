-- Immutable, append-only, hash-chained audit log. Every read, write, search, export, and
-- AI query goes through the same table and the same write_audit_log() entry point — there
-- is deliberately no separate "AI log" or app-code-only audit path.

CREATE SEQUENCE IF NOT EXISTS audit_log_seq;

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint NOT NULL DEFAULT nextval('audit_log_seq') UNIQUE,
  user_id uuid NOT NULL,
  action text NOT NULL,               -- e.g. 'object.read', 'case.export', 'ai.query', 'search'
  resource_type text,
  resource_id uuid,
  purpose text NOT NULL,              -- required "purpose of use" justification
  details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  prev_hash text NOT NULL,
  row_hash text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_seq ON audit_log(seq);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);

-- No app role is ever granted INSERT/UPDATE/DELETE on this table directly (see 005).
-- The only write path is this SECURITY DEFINER function, owned by the migration/owner role,
-- so it runs with the owner's privileges regardless of the caller's grants.
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
  v_ts timestamptz := now();          -- fixed once, reused in both the row and the hash input
  v_prev_hash text;
  v_row_hash text;
BEGIN
  IF p_purpose IS NULL OR btrim(p_purpose) = '' THEN
    RAISE EXCEPTION 'purpose of use is required for audit_log entries';
  END IF;

  -- Defense-in-depth against a buggy or compromised API layer attributing an action to the
  -- wrong user: if a session actor is set, the claimed p_user_id must match it. Unset session
  -- actor (NULL) is allowed through for non-interactive/service writes (e.g. scheduled
  -- ingestion), which have no per-request session to check against.
  IF current_setting('app.current_user_id', true) IS NOT NULL
     AND current_setting('app.current_user_id', true)::uuid <> p_user_id THEN
    RAISE EXCEPTION 'write_audit_log: p_user_id does not match session actor';
  END IF;

  SELECT row_hash INTO v_prev_hash FROM audit_log ORDER BY seq DESC LIMIT 1;
  IF v_prev_hash IS NULL THEN
    v_prev_hash := repeat('0', 64);   -- genesis row
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

-- Append-only enforcement: UPDATE/DELETE unconditionally raise, regardless of caller.
CREATE OR REPLACE FUNCTION audit_log_block_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit_log;
CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

DROP TRIGGER IF EXISTS trg_audit_log_no_delete ON audit_log;
CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();

-- Walks the full chain and recomputes each row_hash using the exact same formula as
-- write_audit_log(), from the stored occurred_at (never a freshly-computed timestamp,
-- which is the classic source of false-positive "tampering" from formatting drift).
CREATE OR REPLACE FUNCTION verify_audit_log() RETURNS TABLE(is_valid boolean, first_broken_seq bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec record;
  expected_prev text := repeat('0', 64);
  computed text;
  broken bigint := NULL;
BEGIN
  FOR rec IN SELECT * FROM audit_log ORDER BY seq ASC LOOP
    IF rec.prev_hash <> expected_prev THEN
      broken := rec.seq;
      EXIT;
    END IF;

    computed := encode(
      digest(
        rec.prev_hash
        || rec.user_id::text
        || rec.action
        || coalesce(rec.resource_type, '')
        || coalesce(rec.resource_id::text, '')
        || rec.purpose
        || rec.occurred_at::text
        || rec.details::text,
        'sha256'
      ),
      'hex'
    );

    IF computed <> rec.row_hash THEN
      broken := rec.seq;
      EXIT;
    END IF;

    expected_prev := rec.row_hash;
  END LOOP;

  IF broken IS NULL THEN
    RETURN QUERY SELECT true, NULL::bigint;
  ELSE
    RETURN QUERY SELECT false, broken;
  END IF;
END;
$$;

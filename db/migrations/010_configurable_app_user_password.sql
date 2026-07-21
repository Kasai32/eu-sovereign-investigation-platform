-- Makes app_user's password configurable via the APP_USER_PASSWORD env var, read by
-- db/scripts/migrate.sh and passed in as a psql variable. Deliberately a new migration rather
-- than editing 005_roles_and_rls.sql in place — migrations here are append-only once applied
-- (see the Phase 3 self-review for why: rewriting an applied migration's history is exactly
-- the kind of thing that looks harmless locally and breaks any environment that already ran
-- the original version).
--
-- migrate.sh always passes app_user_password (falling back to the same placeholder 005 used
-- if APP_USER_PASSWORD isn't set), so this ALTER is safe to run unconditionally.
ALTER ROLE app_user WITH PASSWORD :'app_user_password';

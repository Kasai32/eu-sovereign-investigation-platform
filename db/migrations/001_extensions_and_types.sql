-- Extensions and shared enum types.
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest() for the audit hash chain
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy matching for entity resolution

DO $$ BEGIN
  CREATE TYPE classification_level AS ENUM ('PUBLIC','INTERNAL','SENSITIVE','RESTRICTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Enum values are ordered by declaration order in Postgres, so classification <= clearance
-- comparisons below work directly without a separate rank-mapping table.

DO $$ BEGIN
  CREATE TYPE case_status AS ENUM ('open','under_review','closed','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE app_user_role AS ENUM ('analyst','supervisor','compliance','admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE resolution_decision AS ENUM ('pending','merged','not_a_match','skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

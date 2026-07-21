-- Supports resuming a crashed/failed ingestion run: file_hash lets the resume endpoint verify
-- the re-uploaded file is byte-for-byte the same one the run was started with (a different or
-- reordered file would make the checkpoint-based resume silently process the wrong rows for
-- the remaining, un-ingested portion).
ALTER TABLE ingestion_runs ADD COLUMN IF NOT EXISTS file_hash text;

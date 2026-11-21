-- 0002: what went wrong before an upload, on `ingests`.
--
-- Firmware build 3 adds to an upload, as a query string, what went wrong before it: failed
-- uploads with their codes, the gap and time without a data link, and the largest body
-- accepted and the smallest refused since power-up. The Worker keeps it as JSON in
-- ingests.diag (see uploadDiag() in src/ingest.ts), and Logs shows it under the upload.
--
-- Run by hand, once, on every database that was created before this column was in
-- schema.sql. Not idempotent: a second run stops with "duplicate column name" and changes
-- nothing. A fresh database gets the column from schema.sql and must not run this file.
--   remote: npx wrangler d1 execute vette --remote --config wrangler.local.toml --file=schema-changes/0002-ingests-diag.sql
--   local:  npx wrangler d1 execute vette --local --file=schema-changes/0002-ingests-diag.sql
--
-- Order: run this first, then deploy the Worker that writes the column. That Worker answers
-- 503 on every upload until the column exists (the logger keeps its data and retries). The
-- old Worker keeps working after this file and leaves the column empty.

ALTER TABLE ingests ADD COLUMN diag TEXT;

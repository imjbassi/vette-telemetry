-- 0001: odometer at both ends of a session, firmware build and link-down count on `trips`.
--
-- Run by hand, once, on every database that was created before these columns were in
-- schema.sql. Not idempotent: a second run stops at the first ALTER with "duplicate column
-- name" and changes nothing. A fresh database gets the columns from schema.sql and must not
-- run this file.
--   remote: npx wrangler d1 execute vette --remote --config wrangler.local.toml --file=schema-changes/0001-trips-odometer-fw.sql
--   local:  npx wrangler d1 execute vette --local --file=schema-changes/0001-trips-odometer-fw.sql
--
-- Order: run this first, then deploy the Worker that writes the columns. That Worker answers
-- 503 on every upload until the columns exist (the logger keeps its data and retries). The
-- old Worker keeps working after this file, but resets the new columns of a session it
-- writes to, so do both steps while the car is parked.
-- If a run stops after the ALTERs, run the UPDATE at the end on its own. It can be repeated.

ALTER TABLE trips ADD COLUMN odo_start REAL;
ALTER TABLE trips ADD COLUMN odo_end REAL;
ALTER TABLE trips ADD COLUMN fw INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN nolink_n INTEGER NOT NULL DEFAULT 0;

-- Existing sessions: first and last odometer reading, straight from the samples. Sessions
-- without a reading stay NULL. fw and nolink_n stay 0, older firmware had neither.
UPDATE trips SET
  odo_start = (SELECT odo_km FROM samples WHERE samples.boot = trips.boot AND odo_km IS NOT NULL ORDER BY ms ASC LIMIT 1),
  odo_end   = (SELECT odo_km FROM samples WHERE samples.boot = trips.boot AND odo_km IS NOT NULL ORDER BY ms DESC LIMIT 1);

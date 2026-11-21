-- Rebuild the rollup tables (trips, minutes, track) from `samples`.
-- Minute and route rows are cleared first and every trip row is written again, so rows left
-- over from before a repair cannot survive and be counted twice. Run it after repairing samples
-- by hand, and once after deploying a change to the rollup rules (such as SPEED_ROUNDING_KPH on
-- 2026-11-20) so that older sessions follow them. Deploy first: readings the old Worker folds
-- after the run keep the old rules. The commands:
--   remote: npx wrangler d1 execute vette --remote --config wrangler.local.toml --file=maintenance/rebuild-rollups.sql
--   local:  npx wrangler d1 execute vette --local --file=maintenance/rebuild-rollups.sql
-- Safe to run again, also after a run that stopped half way. Run it while the car is parked:
-- an upload that lands between two statements would be folded into half-built rows.
--
-- Cost on the D1 Free plan (limits 5,000,000 rows read and 100,000 rows written a day).
-- Rows read: about 11 per sample (431,060 for 37,774 samples on 2026-11-20), so past about
-- 400,000 samples one run uses up the reads of a day. Rows written depend on the kind of
-- sample, because every minute and route row is deleted and written again, and D1 counts
-- index entries too:
--   driving at 1 Hz with GPS          about 0.3 per sample
--   parked heartbeat with a GPS fix   about 5 per sample. Build 2 stores one every 30 s
--                                     while parked, and each becomes a route point.
--   parked heartbeat without a fix    about 1 per sample
-- The writes come to about track rows x 4 + minutes rows x 2 + trips rows x 4, so count
-- them first. This reads each rollup row once:
--   npx wrangler d1 execute vette --remote --config wrangler.local.toml --command "SELECT (SELECT COUNT(*) FROM track) * 4 + (SELECT COUNT(*) FROM minutes) * 2 + (SELECT COUNT(*) FROM trips) * 4 AS writes"
-- The count is on the safe side: on 2026-11-20 it said 11,280 for a run that wrote 8,853.
-- Run the whole file only when it is under about 90,000 and there are under about 400,000
-- samples. Reads and writes that uploads made earlier in the same UTC day count too. The
-- remote run is one unit: the database answers nothing while it runs, and a run that fails
-- changes nothing. A run that uses up the daily reads or writes leaves every upload answering
-- 503 until 00:00 UTC. The logger keeps its data and sends it afterwards.
-- Past that size, rebuild one range of sessions per UTC day. Add
-- `WHERE boot BETWEEN <lo> AND <hi>` in five places, with the same two numbers in all five:
-- after both DELETEs below, after `SELECT DISTINCT boot, -1 FROM samples`, and after
-- `AS dms FROM samples` in the trips INSERT and in the minutes INSERT (inside the bracket).
-- Sessions outside the range keep their rows. Count the range first with the query above,
-- with the same `WHERE boot BETWEEN <lo> AND <hi>` after each of its three table names.
--
-- Same rules as src/rollup.ts: each sample covers the gap since the previous one in its
-- session, gaps over 5 s count as missing, a moving speed reading counts 0.5 km/h more
-- (SPEED_ROUNDING_KPH), and a record written without the adapter link (flags & 4) never
-- counts as engine-on. One thing differs from what uploads built:
--   trips.fw is kept from the old trip row of the session, because samples do not store
--   the firmware build byte. A session without a trip row gets 0.
-- Until 2026-11-20, uploads left the minutes of a session whose clock was learned late in
-- their estimated slot. This moves them to the real one, because samples only keep the
-- corrected time. Uploads have done the same since (MINUTE_REBUILD_SQL in src/rollup.ts).

-- trips is not cleared here: the INSERT further down reads fw from the old rows.
DELETE FROM minutes;
DELETE FROM track;

-- Route points come first, trips.track_ms is read from them. Same walk as fold(): starting
-- at -1, take the first GPS sample at least 15 s after the last one taken. The walk ends
-- with a NULL, and neither that nor the -1 matches a sample in the join.
INSERT OR REPLACE INTO track (boot, ms, ts, lat, lon, mph)
WITH RECURSIVE pick(boot, ms) AS (
  SELECT DISTINCT boot, -1 FROM samples
  UNION ALL
  SELECT p.boot, (SELECT MIN(s.ms) FROM samples s
                  WHERE s.boot = p.boot AND s.ms >= p.ms + 15000 AND s.lat IS NOT NULL AND s.lon IS NOT NULL)
  FROM pick p WHERE p.ms IS NOT NULL
)
SELECT s.boot, s.ms, s.ts, s.lat, s.lon, CAST(ROUND(s.speed_kph * 0.621371) AS INTEGER)
FROM pick p JOIN samples s ON s.boot = p.boot AND s.ms = p.ms;

INSERT OR REPLACE INTO trips (boot, start_ts, end_ts, last_ms, track_ms, n, gps_n, engine_n, km, maf_g,
                              engine_s, moving_s, max_kph, max_rpm, max_coolant, rpm_sum, rpm_n, est,
                              odo_start, odo_end, fw, nolink_n)
SELECT boot, MIN(ts), MAX(ts), MAX(ms),
  COALESCE((SELECT MAX(t.ms) FROM track t WHERE t.boot = x.boot), -1),
  COUNT(*), SUM(lat IS NOT NULL AND lon IS NOT NULL), SUM((flags & 5) = 1),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 AND speed_kph > 0 THEN (speed_kph + 0.5) * dms / 3600000.0 END), 0),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 THEN maf_gs * dms / 1000.0 END), 0),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 AND (flags & 5) = 1 THEN dms END), 0) / 1000.0,
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 AND speed_kph > 0 THEN dms END), 0) / 1000.0,
  MAX(speed_kph), MAX(rpm), MAX(coolant_c),
  COALESCE(SUM(CASE WHEN rpm > 0 THEN rpm END), 0), COALESCE(SUM(rpm > 0), 0), MAX(ts_est),
  (SELECT o.odo_km FROM samples o WHERE o.boot = x.boot AND o.odo_km IS NOT NULL ORDER BY o.ms ASC LIMIT 1),
  (SELECT o.odo_km FROM samples o WHERE o.boot = x.boot AND o.odo_km IS NOT NULL ORDER BY o.ms DESC LIMIT 1),
  COALESCE((SELECT o.fw FROM trips o WHERE o.boot = x.boot), 0), SUM((flags & 4) != 0)
FROM (SELECT *, ms - LAG(ms) OVER (PARTITION BY boot ORDER BY ms) AS dms FROM samples) AS x
GROUP BY boot;

-- Trip rows of sessions that have no samples any more.
DELETE FROM trips WHERE NOT EXISTS (SELECT 1 FROM samples s WHERE s.boot = trips.boot);

INSERT OR REPLACE INTO minutes (t, boot, n, engine_n, gps_n, km, maf_g, engine_s, moving_s,
  spd_sum, spd_n, spd_max, rpm_sum, rpm_n, rpm_max, cool_sum, cool_n, cool_max, cool_eng_sum, cool_eng_n,
  fuel_sum, fuel_n, fuel_min, fuel_max, volt_sum, volt_n, volt_min, volt_max, thr_sum, thr_n, thr_max,
  iat_sum, iat_n, iat_min, iat_max, maf_sum, maf_n, maf_max)
SELECT (ts / 60) * 60, boot, COUNT(*), SUM((flags & 5) = 1), SUM(lat IS NOT NULL AND lon IS NOT NULL),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 AND speed_kph > 0 THEN (speed_kph + 0.5) * dms / 3600000.0 END), 0),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 THEN maf_gs * dms / 1000.0 END), 0),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 AND (flags & 5) = 1 THEN dms END), 0) / 1000.0,
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 AND speed_kph > 0 THEN dms END), 0) / 1000.0,
  COALESCE(SUM(speed_kph), 0), COUNT(speed_kph), MAX(speed_kph),
  COALESCE(SUM(CASE WHEN rpm > 0 THEN rpm END), 0), COALESCE(SUM(rpm > 0), 0), MAX(rpm),
  COALESCE(SUM(coolant_c), 0), COUNT(coolant_c), MAX(coolant_c),
  COALESCE(SUM(CASE WHEN (flags & 5) = 1 THEN coolant_c END), 0), SUM(CASE WHEN (flags & 5) = 1 AND coolant_c IS NOT NULL THEN 1 ELSE 0 END),
  COALESCE(SUM(fuel_pct), 0), COUNT(fuel_pct), MIN(fuel_pct), MAX(fuel_pct),
  COALESCE(SUM(adapter_v), 0), COUNT(adapter_v), MIN(adapter_v), MAX(adapter_v),
  COALESCE(SUM(throttle_pct), 0), COUNT(throttle_pct), MAX(throttle_pct),
  COALESCE(SUM(intake_c), 0), COUNT(intake_c), MIN(intake_c), MAX(intake_c),
  COALESCE(SUM(maf_gs), 0), COUNT(maf_gs), MAX(maf_gs)
FROM (SELECT *, ms - LAG(ms) OVER (PARTITION BY boot ORDER BY ms) AS dms FROM samples)
GROUP BY 1, 2;

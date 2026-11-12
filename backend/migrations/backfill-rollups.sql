-- Rebuild the rollup tables (trips, minutes, track) from `samples`.
-- Idempotent. Scans every sample once, so run it only after creating the tables or after
-- repairing samples by hand:
--   npx wrangler d1 execute vette --remote --config wrangler.local.toml --file=migrations/backfill-rollups.sql
-- Same integration rules as src/rollup.ts: each sample covers the gap since the previous one
-- in its session, gaps over 5 s count as missing.

INSERT OR REPLACE INTO trips (boot, start_ts, end_ts, last_ms, track_ms, n, gps_n, engine_n, km, maf_g,
                              engine_s, moving_s, max_kph, max_rpm, max_coolant, rpm_sum, rpm_n, est)
SELECT boot, MIN(ts), MAX(ts), MAX(ms), MAX(ms), COUNT(*), SUM(lat IS NOT NULL), SUM(flags & 1),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 THEN speed_kph * dms / 3600000.0 END), 0),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 THEN maf_gs * dms / 1000.0 END), 0),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 AND (flags & 1) THEN dms END), 0) / 1000.0,
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 AND speed_kph > 0 THEN dms END), 0) / 1000.0,
  MAX(speed_kph), MAX(rpm), MAX(coolant_c),
  COALESCE(SUM(CASE WHEN rpm > 0 THEN rpm END), 0), SUM(rpm > 0), MAX(ts_est)
FROM (SELECT *, ms - LAG(ms) OVER (PARTITION BY boot ORDER BY ms) AS dms FROM samples)
GROUP BY boot;

INSERT OR REPLACE INTO minutes (t, boot, n, engine_n, gps_n, km, maf_g, engine_s, moving_s,
  spd_sum, spd_n, spd_max, rpm_sum, rpm_n, rpm_max, cool_sum, cool_n, cool_max, cool_eng_sum, cool_eng_n,
  fuel_sum, fuel_n, fuel_min, fuel_max, volt_sum, volt_n, volt_min, volt_max, thr_sum, thr_n, thr_max,
  iat_sum, iat_n, iat_min, iat_max, maf_sum, maf_n, maf_max)
SELECT (ts / 60) * 60, boot, COUNT(*), SUM(flags & 1), SUM(lat IS NOT NULL),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 THEN speed_kph * dms / 3600000.0 END), 0),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 THEN maf_gs * dms / 1000.0 END), 0),
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 AND (flags & 1) THEN dms END), 0) / 1000.0,
  COALESCE(SUM(CASE WHEN dms BETWEEN 1 AND 5000 AND speed_kph > 0 THEN dms END), 0) / 1000.0,
  COALESCE(SUM(speed_kph), 0), COUNT(speed_kph), MAX(speed_kph),
  COALESCE(SUM(CASE WHEN rpm > 0 THEN rpm END), 0), SUM(rpm > 0), MAX(rpm),
  COALESCE(SUM(coolant_c), 0), COUNT(coolant_c), MAX(coolant_c),
  COALESCE(SUM(CASE WHEN flags & 1 THEN coolant_c END), 0), SUM(CASE WHEN (flags & 1) AND coolant_c IS NOT NULL THEN 1 ELSE 0 END),
  COALESCE(SUM(fuel_pct), 0), COUNT(fuel_pct), MIN(fuel_pct), MAX(fuel_pct),
  COALESCE(SUM(adapter_v), 0), COUNT(adapter_v), MIN(adapter_v), MAX(adapter_v),
  COALESCE(SUM(throttle_pct), 0), COUNT(throttle_pct), MAX(throttle_pct),
  COALESCE(SUM(intake_c), 0), COUNT(intake_c), MIN(intake_c), MAX(intake_c),
  COALESCE(SUM(maf_gs), 0), COUNT(maf_gs), MAX(maf_gs)
FROM (SELECT *, ms - LAG(ms) OVER (PARTITION BY boot ORDER BY ms) AS dms FROM samples)
GROUP BY 1, 2;

INSERT OR REPLACE INTO track (boot, ms, ts, lat, lon, mph)
SELECT boot, ms, ts, lat, lon, CAST(ROUND(speed_kph * 0.621371) AS INTEGER)
FROM samples WHERE lat IS NOT NULL AND lon IS NOT NULL AND ms % 15000 < 1000;

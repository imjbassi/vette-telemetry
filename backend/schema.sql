-- One row per 1 Hz sample. (boot, ms) is the device's natural key, so re-uploads are idempotent.
CREATE TABLE IF NOT EXISTS samples (
  boot        INTEGER NOT NULL,
  ms          INTEGER NOT NULL,
  ts          INTEGER NOT NULL,      -- unix seconds
  ts_est      INTEGER NOT NULL,      -- 1 if ts was estimated from upload time
  lat         REAL, lon REAL, sats INTEGER,
  rpm         INTEGER,
  speed_kph   INTEGER,
  coolant_c   REAL,
  intake_c    REAL,
  maf_gs      REAL,
  throttle_pct INTEGER,
  fuel_pct    REAL,
  adapter_v   REAL,
  ecu_v       REAL,
  odo_km      REAL,
  csq         INTEGER,
  flags       INTEGER NOT NULL,
  PRIMARY KEY (boot, ms)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS samples_ts ON samples(ts);

-- Unix time at millis()==0 for each device boot, once known.
CREATE TABLE IF NOT EXISTS boots (
  boot        INTEGER PRIMARY KEY,
  epoch_base  INTEGER
);

-- Last known value of every field, merged across uploads. One row.
CREATE TABLE IF NOT EXISTS latest (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  json        TEXT NOT NULL
);

-- One row per upload. received_at must stay NOT NULL: src/ingest.ts stops a stale upload by
-- inserting a NULL here on purpose, which fails the whole batch.
CREATE TABLE IF NOT EXISTS ingests (
  received_at INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  records     INTEGER NOT NULL,
  rejected    INTEGER NOT NULL,
  -- Added by schema-changes/0002-ingests-diag.sql. What went wrong before this upload, as
  -- JSON (uploadDiag() in src/ingest.ts). NULL when the logger had nothing to say.
  diag        TEXT
);
CREATE INDEX IF NOT EXISTS ingests_at ON ingests(received_at);

-- ---------------------------------------------------------------------------------------
-- Rollups, updated incrementally on every upload (see src/rollup.ts). D1 bills every row a
-- query scans, so the dashboard and Claude tools read these instead of re-aggregating
-- `samples`. maintenance/rebuild-rollups.sql rebuilds them from `samples` if ever needed.
--
-- This file only creates what is missing. A change to an existing table also needs a
-- numbered file in schema-changes/, run by hand once on each existing database.

-- One row per session (device power-up). A trip is a session with the engine on.
-- A session id is the boot counter of the board plus its install id times 65536 (see src/record.ts).
CREATE TABLE IF NOT EXISTS trips (
  boot        INTEGER PRIMARY KEY,
  start_ts    INTEGER, end_ts INTEGER,
  last_ms     INTEGER NOT NULL DEFAULT -1,   -- newest sample folded in; replays at or below are skipped
  track_ms    INTEGER NOT NULL DEFAULT -1,   -- newest sample copied to `track`
  n           INTEGER NOT NULL DEFAULT 0, gps_n INTEGER NOT NULL DEFAULT 0, engine_n INTEGER NOT NULL DEFAULT 0,
  km          REAL NOT NULL DEFAULT 0, maf_g REAL NOT NULL DEFAULT 0,
  engine_s    REAL NOT NULL DEFAULT 0, moving_s REAL NOT NULL DEFAULT 0,
  max_kph     INTEGER, max_rpm INTEGER, max_coolant REAL,
  rpm_sum     REAL NOT NULL DEFAULT 0, rpm_n INTEGER NOT NULL DEFAULT 0,
  est         INTEGER NOT NULL DEFAULT 0,
  -- Added by schema-changes/0001-trips-odometer-fw.sql. Keep the order: columns added to an
  -- existing table always land at the end.
  odo_start   REAL,                          -- first odometer reading of the session, km
  odo_end     REAL,                          -- last odometer reading of the session, km
  fw          INTEGER NOT NULL DEFAULT 0,    -- highest firmware build byte seen in the session
  nolink_n    INTEGER NOT NULL DEFAULT 0     -- records written while the adapter link was down
);
CREATE INDEX IF NOT EXISTS trips_end ON trips(end_ts);

-- Per-minute aggregates per session. History reads these for anything longer than an hour.
CREATE TABLE IF NOT EXISTS minutes (
  t INTEGER NOT NULL, boot INTEGER NOT NULL,
  n INTEGER, engine_n INTEGER, gps_n INTEGER,
  km REAL, maf_g REAL, engine_s REAL, moving_s REAL,
  spd_sum REAL, spd_n INTEGER, spd_max INTEGER,
  rpm_sum REAL, rpm_n INTEGER, rpm_max INTEGER,
  cool_sum REAL, cool_n INTEGER, cool_max REAL, cool_eng_sum REAL, cool_eng_n INTEGER,
  fuel_sum REAL, fuel_n INTEGER, fuel_min REAL, fuel_max REAL,
  volt_sum REAL, volt_n INTEGER, volt_min REAL, volt_max REAL,
  thr_sum REAL, thr_n INTEGER, thr_max INTEGER,
  iat_sum REAL, iat_n INTEGER, iat_min REAL, iat_max REAL,
  maf_sum REAL, maf_n INTEGER, maf_max REAL,
  PRIMARY KEY (t, boot)
) WITHOUT ROWID;

-- GPS route points, one every 15 s, for maps over long periods.
CREATE TABLE IF NOT EXISTS track (
  boot INTEGER NOT NULL, ms INTEGER NOT NULL, ts INTEGER NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL, mph INTEGER,
  PRIMARY KEY (boot, ms)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS track_ts ON track(ts);

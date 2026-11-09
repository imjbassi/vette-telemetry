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

CREATE TABLE IF NOT EXISTS ingests (
  received_at INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  records     INTEGER NOT NULL,
  rejected    INTEGER NOT NULL
);

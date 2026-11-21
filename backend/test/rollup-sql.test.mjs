// The two hand-run SQL files against what the Worker builds:
//   maintenance/rebuild-rollups.sql must give the same trips, minutes and track as ingest did,
//   schema-changes/0001 must turn an old database into what schema.sql creates today.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import rebuildSql from "../maintenance/rebuild-rollups.sql";
import changeSql from "../schema-changes/0001-trips-odometer-fw.sql";
import change2Sql from "../schema-changes/0002-ingests-diag.sql";
import schemaSql from "../schema.sql";
import { F } from "../scripts/lib/record-encode.mjs";
import { MINUTE_REBUILD_SQL } from "../src/rollup.ts";
import { execFile, makeEnv, one, rows } from "./helpers/d1.mjs";
import { assertRowsNear, drive, noLink, post, postChunks, restoreNow, setNow, sid, snapshot, T0 } from "./helpers/drive.mjs";

afterEach(restoreNow);

const LATE = sid(21, 173); // the session whose clock is learned after its first upload

// A database filled only through handleIngest, with every kind of session the rules know.
async function fleet() {
  const env = makeEnv();

  // A ten-minute drive in uploads of 31, the size the car really sends.
  const a = drive({ boot: 12, n: 600 });
  await postChunks(env, a, [31], { now: T0 + 700 });

  // A full backlog segment of slow records.
  setNow(T0 + 4400);
  await post(env, drive({ boot: 13, n: 341, stepMs: 2000, base: T0 + 3600 }));

  // The adapter link drops for three minutes in the middle.
  const c1 = drive({ boot: 7, fw: 3, n: 30, base: T0 + 7200 });
  const down = [79, 109, 139, 169, 199, 229].map((s, i) => noLink({
    boot: 7, ms: s * 1000, base: T0 + 7200, lat: 37.8199 + i * 0.001, lon: -122.4783 + i * 0.001,
    flags: i === 2 ? F.NO_LINK | F.ENGINE_ON : F.NO_LINK,
  }));
  const c2 = drive({ boot: 7, fw: 3, n: 30, ms0: 232000, base: T0 + 7200, odo0: 126800 });
  setNow(T0 + 7340);
  await post(env, [...c1, ...down.slice(0, 3)]);
  setNow(T0 + 7465);
  await post(env, [...down.slice(3), ...c2]);

  // Legacy firmware, a car without odometer, no GPS fix.
  setNow(T0 + 10100);
  await post(env, drive({ boot: 44, inst: 0, fw: 0, n: 50, base: T0 + 10000, odo0: null, gps: false }));

  // Parked and quiet: only the adapter voltage, never an RPM, no GPS.
  const quiet = [0, 2, 4, 6, 36, 66, 96].map((s) => ({
    boot: 20, inst: 173, fw: 2, ms: 30000 + s * 1000, epoch: T0 + 12030 + s, flags: F.QUIET, adapter_v: 12.4, csq: 15,
  }));
  setNow(T0 + 12200);
  await post(env, quiet);

  // Clock learned late: first upload estimated, second one carries the time. Like 162-127 its
  // first readings have no fix, and there is a gap over 5 s and an engine stop with RPM 0.
  const f = drive({ boot: 21, n: 70, ms0: 2000, base: T0 + 14050 })
    .filter((_, i) => i < 8 || i > 14)
    .map((r, i) => (i < 20 ? (({ lat, lon, sats, ...rest }) => rest)(r) : r))
    .map((r, i) => (i === 25 ? { ...r, rpm: 0, flags: 0 } : r));
  setNow(T0 + 14100);
  await post(env, f.slice(0, 40).map((r) => ({ ...r, epoch: 0 })));
  // The minute each reading of the first upload was filed in, by its estimated time.
  env.lateEstimated = rows(env, "SELECT ms, (ts / 60) * 60 AS t FROM samples WHERE boot = ? ORDER BY ms", LATE);
  setNow(T0 + 14130);
  await post(env, f.slice(40));

  // Never gets a clock at all.
  setNow(T0 + 16000);
  await post(env, drive({ boot: 22, n: 20, clock: false }));

  // Gaps inside a drive: exactly 5 s still counts, 6 s does not. An engine stop with RPM 0 in a
  // session that only fold() builds.
  const h = drive({ boot: 23, n: 60, base: T0 + 18000 }).filter((_, i) => !(i >= 10 && i <= 13) && !(i >= 30 && i <= 34))
    .map((r, i) => (i === 40 ? { ...r, rpm: 0, flags: 0 } : r));
  setNow(T0 + 18100);
  await post(env, h);

  // Replays and an overlap on top, as a flaky link would cause.
  setNow(T0 + 18200);
  await post(env, a.slice(100, 200));
  await post(env, h.slice(20));
  return env;
}

test("rebuild-rollups.sql reproduces what incremental ingest built", async () => {
  const env = await fleet();
  const built = snapshot(env);
  assert.equal(built.trips.length, 8);
  assert.deepEqual(built.trips.map((t) => t.fw).sort(), [0, 2, 2, 2, 2, 2, 2, 3]);
  assert.equal(one(env, "SELECT SUM(n) AS n FROM trips").n, built.samples.length, "every sample is in a trip exactly once");
  assert.equal(one(env, "SELECT SUM(n) AS n FROM minutes").n, built.samples.length);

  execFile(env, rebuildSql);
  const rebuilt = snapshot(env);

  assert.deepEqual(rebuilt.samples, built.samples, "samples are only read");
  // Samples do not store the firmware build. The rebuild carries it over from the old trip rows.
  assertRowsNear(rebuilt.trips, built.trips, { label: "trips" });
  assert.deepEqual(rebuilt.trips.map((t) => t.fw).sort(), [0, 2, 2, 2, 2, 2, 2, 3]);
  assert.deepEqual(rebuilt.track, built.track);

  // Minutes match row for row, also for the session whose first upload had estimated times:
  // ingest moved those readings to the minute of their real time when the clock came.
  assertRowsNear(rebuilt.minutes, built.minutes, { label: "minutes" });
  const real = rows(env, "SELECT ms, (ts / 60) * 60 AS t FROM samples WHERE boot = ? ORDER BY ms", LATE);
  assert.ok(env.lateEstimated.some((r, i) => r.t !== real[i].t), "the test really has readings that changed minute");

  // Running it again changes nothing.
  execFile(env, rebuildSql);
  assert.deepEqual(snapshot(env), rebuilt);
});

// ingest.ts runs MINUTE_REBUILD_SQL for one session when its clock comes late. It has to give
// every kind of session the rows fold() builds: gaps, no fix, link down, quiet, legacy, replays.
test("MINUTE_REBUILD_SQL gives every session the minute rows ingest built", async () => {
  const env = await fleet();
  const built = snapshot(env).minutes;
  const sessions = rows(env, "SELECT boot FROM trips ORDER BY boot");
  assert.equal(sessions.length, 8);
  for (const { boot } of sessions) {
    env.DB.sqlite.prepare("DELETE FROM minutes WHERE boot = ?").run(boot);
    env.DB.sqlite.prepare(MINUTE_REBUILD_SQL).run(boot);
  }
  assertRowsNear(snapshot(env).minutes, built, { label: "minutes" });
});

test("a session continues correctly after a rebuild", async () => {
  const rebuilt = await fleet();
  const plain = await fleet();
  execFile(rebuilt, rebuildSql);

  // The next uploads of two sessions: the ten-minute drive and the one with the link drop.
  const more = drive({ boot: 12, n: 640 }).slice(600);
  const moreLink = [
    noLink({ boot: 7, ms: 290000, base: T0 + 7200 }),
    ...drive({ boot: 7, fw: 3, n: 40, ms0: 232000, base: T0 + 7200, odo0: 126800 }).slice(30),
  ];
  for (const env of [rebuilt, plain]) {
    setNow(T0 + 18300);
    assert.equal((await post(env, more)).status, 200);
    assert.equal((await post(env, moreLink)).status, 200);
  }
  const a = snapshot(rebuilt), b = snapshot(plain);
  assert.deepEqual(a.samples, b.samples);
  assert.deepEqual(a.track, b.track);
  // Every trip, the two that continued and the ones the rebuild alone wrote, build byte included.
  assertRowsNear(a.trips, b.trips, { label: "trips" });
  assertRowsNear(a.minutes, b.minutes, { label: "minutes" });
});

// 162-127 on 2026-11-20: its first 3 minutes went up 11 to 14 minutes late, in uploads without a
// clock, so they were dated as if just written, 11 to 13 minutes after their real time. The
// clock came with a later upload.
test("a backlog uploaded late without a clock moves to its real minutes when the clock comes", async () => {
  const env = makeEnv();
  const boot = sid(27, 173);
  const all = drive({ boot: 27, n: 300, ms0: 10000 }); // written at T0 + 10 to T0 + 309
  setNow(T0 + 189 + 720);
  await post(env, all.slice(0, 180).map((r) => ({ ...r, epoch: 0 })));
  assert.ok(rows(env, "SELECT t FROM minutes WHERE boot = ?", boot).every((m) => m.t >= T0 + 720), "filed 12 minutes late");
  setNow(T0 + 920);
  await post(env, all.slice(180));
  assert.deepEqual(rows(env, "SELECT t, n FROM minutes WHERE boot = ? ORDER BY t", boot), [
    { t: T0, n: 50 }, { t: T0 + 60, n: 60 }, { t: T0 + 120, n: 60 }, { t: T0 + 180, n: 60 }, { t: T0 + 240, n: 60 }, { t: T0 + 300, n: 10 },
  ]);
  assert.deepEqual(one(env, "SELECT start_ts, end_ts, est FROM trips WHERE boot = ?", boot), { start_ts: T0 + 10, end_ts: T0 + 309, est: 0 });
  // What the rebuild script makes from the same readings, distance and fuel included.
  const built = snapshot(env);
  execFile(env, rebuildSql);
  assertRowsNear(snapshot(env).minutes, built.minutes, { label: "minutes" });
  assertRowsNear(snapshot(env).trips, built.trips, { label: "trips" });
});

test("rebuild-rollups.sql clears rollup rows that no sample backs any more", async () => {
  const env = makeEnv();
  setNow(T0 + 700);
  await post(env, drive({ boot: 12, n: 300 }));
  await post(env, drive({ boot: 13, n: 60, base: T0 + 300 }));
  const boot = sid(12, 173);
  const before = snapshot(env);

  // A repair by hand: one session's times move by an hour, another session is deleted.
  env.DB.sqlite.exec(`UPDATE samples SET ts = ts + 3600 WHERE boot = ${boot}; DELETE FROM samples WHERE boot = ${sid(13, 173)};`);
  execFile(env, rebuildSql);
  const after = snapshot(env);

  assert.equal(after.trips.length, 1, "the trip row of the deleted session is gone");
  assert.equal(after.trips[0].fw, 2);
  assert.equal(after.trips[0].start_ts, before.trips.find((t) => t.boot === boot).start_ts + 3600);
  assert.equal(one(env, "SELECT SUM(n) AS n FROM minutes").n, 300, "no minute is counted twice");
  assert.deepEqual(after.minutes.map((m) => m.t), before.minutes.filter((m) => m.boot === boot).map((m) => m.t + 3600));
  assert.deepEqual(after.track.map((p) => [p.boot, p.ms, p.ts]),
    before.track.filter((p) => p.boot === boot).map((p) => [p.boot, p.ms, p.ts + 3600]));
});

test("rebuild-rollups.sql on an empty database does nothing and does not fail", () => {
  const env = makeEnv();
  execFile(env, rebuildSql);
  assert.deepEqual(snapshot(env), { samples: [], trips: [], minutes: [], track: [] });
});

test("rebuild-rollups.sql gives a session without a trip row build 0, and drops trip rows without samples", async () => {
  const env = makeEnv();
  setNow(T0 + 700);
  await post(env, drive({ boot: 12, fw: 3, n: 40 }));
  await post(env, drive({ boot: 13, fw: 2, n: 40, base: T0 + 300 }));
  const built = snapshot(env);
  // One trip row was lost, and one is left over from samples that were deleted by hand.
  env.DB.sqlite.exec(`DELETE FROM trips WHERE boot = ${sid(13, 173)}; INSERT INTO trips (boot, n, fw) VALUES (999, 5, 2);`);
  execFile(env, rebuildSql);
  const rebuilt = snapshot(env);
  assertRowsNear(rebuilt.trips, [built.trips[0], { ...built.trips[1], fw: 0 }], { label: "trips" });
  assert.deepEqual(rebuilt.trips.map((t) => [t.boot, t.fw]), [[sid(12, 173), 3], [sid(13, 173), 0]]);
});

// The header of rebuild-rollups.sql says how to rebuild a range of sessions once the whole
// table no longer fits into a day of the Free plan. This makes exactly those five edits.
function rangeSql(lo, hi) {
  const where = ` WHERE boot BETWEEN ${lo} AND ${hi}`;
  let edits = 0;
  // Puts the range between `before` and `after`, wherever the two stand together.
  const add = (sql, before, after) => {
    const parts = sql.split(before + after);
    edits += parts.length - 1;
    return parts.join(before + where + after);
  };
  let sql = rebuildSql.replace(/^--.*$/gm, ""); // the header quotes some of these places
  sql = add(sql, "DELETE FROM minutes", ";");
  sql = add(sql, "DELETE FROM track", ";");
  sql = add(sql, "SELECT DISTINCT boot, -1 FROM samples", "");
  sql = add(sql, "AS dms FROM samples", ")");
  assert.equal(edits, 5, "the five places named in the header are all there");
  return sql;
}

test("rebuild-rollups.sql edited for a range of sessions rebuilds only that range", async () => {
  const whole = await fleet();
  const sliced = await fleet();
  execFile(whole, rebuildSql);
  const want = snapshot(whole);

  // First half of the sessions: the others keep what ingest built.
  const boots = want.trips.map((t) => t.boot);
  const mid = boots[3];
  const untouched = snapshot(sliced);
  execFile(sliced, rangeSql(0, mid));
  const half = snapshot(sliced);
  for (const name of ["trips", "minutes", "track"]) {
    assertRowsNear(half[name].filter((r) => r.boot <= mid), want[name].filter((r) => r.boot <= mid), { label: `${name} in the range` });
    assert.deepEqual(half[name].filter((r) => r.boot > mid), untouched[name].filter((r) => r.boot > mid), `${name} outside the range`);
  }
  // Second half: together the two runs give what one whole run gives.
  execFile(sliced, rangeSql(mid + 1, boots[boots.length - 1]));
  const both = snapshot(sliced);
  assert.deepEqual(both.track, want.track);
  assertRowsNear(both.trips, want.trips, { label: "trips after both ranges" });
  assertRowsNear(both.minutes, want.minutes, { label: "minutes after both ranges" });
});

// ------------------------------------------------------------ schema change 0001

// The trips table as it was before 0001 (schema.sql at commit 8c6115f).
const OLD_TRIPS = `
CREATE TABLE IF NOT EXISTS trips (
  boot        INTEGER PRIMARY KEY,
  start_ts    INTEGER, end_ts INTEGER,
  last_ms     INTEGER NOT NULL DEFAULT -1,   -- newest sample folded in; replays at or below are skipped
  track_ms    INTEGER NOT NULL DEFAULT -1,   -- newest sample copied to \`track\`
  n           INTEGER NOT NULL DEFAULT 0, gps_n INTEGER NOT NULL DEFAULT 0, engine_n INTEGER NOT NULL DEFAULT 0,
  km          REAL NOT NULL DEFAULT 0, maf_g REAL NOT NULL DEFAULT 0,
  engine_s    REAL NOT NULL DEFAULT 0, moving_s REAL NOT NULL DEFAULT 0,
  max_kph     INTEGER, max_rpm INTEGER, max_coolant REAL,
  rpm_sum     REAL NOT NULL DEFAULT 0, rpm_n INTEGER NOT NULL DEFAULT 0,
  est         INTEGER NOT NULL DEFAULT 0
);`;
const OLD_TRIP_INSERT = `INSERT INTO trips (boot, start_ts, end_ts, last_ms, track_ms, n, gps_n, engine_n, km, maf_g, engine_s,
  moving_s, max_kph, max_rpm, max_coolant, rpm_sum, rpm_n, est) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

// schema.sql only creates what is missing, so with the old table in place first this is a
// database as the live one is today.
function oldDatabase() {
  const env = makeEnv({ schema: OLD_TRIPS + schemaSql });
  const sample = env.DB.sqlite.prepare(`INSERT INTO samples (boot, ms, ts, ts_est, odo_km, rpm, flags) VALUES (?,?,?,0,?,?,1)`);
  // Session 9: the odometer answers from the second record on and misses the last one.
  [[1000, null], [2000, 12671.1], [3000, 12671.2], [4000, 12671.4], [5000, null]].forEach(([ms, odo]) =>
    sample.run(9, ms, T0 + ms / 1000, odo, 900));
  // Session 10: a car that never answered the odometer.
  [1000, 2000].forEach((ms) => sample.run(10, ms, T0 + 500 + ms / 1000, null, 900));
  const trip = env.DB.sqlite.prepare(OLD_TRIP_INSERT);
  trip.run(9, T0 + 1, T0 + 5, 5000, -1, 5, 0, 5, 0, 0, 4, 0, null, 900, null, 4500, 5, 0);
  trip.run(10, T0 + 501, T0 + 502, 2000, -1, 2, 0, 2, 0, 0, 1, 0, null, 900, null, 1800, 2, 0);
  return env;
}

const columns = (env) => rows(env, "PRAGMA table_info(trips)");

test("schema change 0001 turns the old trips table into today's", async () => {
  const old = oldDatabase();
  const fresh = makeEnv();
  assert.equal(columns(old).length, 18, "the old database really has the old table");
  assert.equal(columns(fresh).length, 22);
  const tripsBefore = rows(old, "SELECT * FROM trips ORDER BY boot");

  execFile(old, changeSql);

  // Same names, types, defaults and order, so SELECT * and the Worker's upsert see one shape.
  assert.deepEqual(columns(old), columns(fresh));
  assert.deepEqual(rows(old, "SELECT * FROM trips ORDER BY boot"), [
    { ...tripsBefore[0], odo_start: 12671.1, odo_end: 12671.4, fw: 0, nolink_n: 0 },
    { ...tripsBefore[1], odo_start: null, odo_end: null, fw: 0, nolink_n: 0 },
  ]);

  // Not idempotent, as its header says: the second run stops and changes nothing.
  assert.throws(() => execFile(old, changeSql), /duplicate column name/);
  assert.deepEqual(columns(old), columns(fresh));

  // The Worker carries on with an old session: the start reading stays, the rest moves on.
  setNow(T0 + 20);
  const next = [6000, 7000].map((ms, i) => ({ boot: 9, inst: 0, fw: 2, ms, epoch: T0 + ms / 1000, rpm: 950, odo_km: 12671.5 + i / 10, flags: F.ENGINE_ON }));
  assert.deepEqual((await post(old, next)).json, { ok: true, records: 2, rejected: 0 });
  assert.deepEqual(one(old, "SELECT n, last_ms, odo_start, odo_end, fw, nolink_n, engine_s, rpm_n FROM trips WHERE boot = 9"),
    { n: 7, last_ms: 7000, odo_start: 12671.1, odo_end: 12671.6, fw: 2, nolink_n: 0, engine_s: 6, rpm_n: 7 });
});

// ------------------------------------------------------------ schema change 0002

// The ingests table as it was before 0002 (schema.sql at commit 1eb2a81).
const OLD_INGESTS = `
CREATE TABLE IF NOT EXISTS ingests (
  received_at INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  records     INTEGER NOT NULL,
  rejected    INTEGER NOT NULL
);`;

test("schema change 0002 adds ingests.diag and keeps the upload log", async () => {
  const old = makeEnv({ schema: OLD_INGESTS + schemaSql });
  const fresh = makeEnv();
  const cols = (env) => rows(env, "PRAGMA table_info(ingests)");
  assert.equal(cols(old).length, 4, "the old database really has the old table");
  old.DB.sqlite.exec("INSERT INTO ingests VALUES (1794436900, 96, 2, 0)");
  // Before the change an upload fails loudly (index.ts answers 503) and stores nothing.
  setNow(T0 + 100);
  await assert.rejects(post(old, drive({ n: 2 })), /diag/);
  assert.equal(one(old, "SELECT COUNT(*) AS n FROM samples").n, 0);

  execFile(old, change2Sql);
  assert.deepEqual(cols(old), cols(fresh));
  assert.deepEqual(rows(old, "SELECT * FROM ingests"), [{ received_at: 1794436900, bytes: 96, records: 2, rejected: 0, diag: null }]);
  // Not idempotent, as its header says.
  assert.throws(() => execFile(old, change2Sql), /duplicate column name/);
  assert.equal((await post(old, drive({ n: 2 }))).status, 200);
});

test("without schema change 0001 an upload fails loudly and stores nothing", async () => {
  const old = oldDatabase();
  setNow(T0 + 20);
  // index.ts turns the exception into a 503, so the logger keeps the records.
  // A session that already has a trip row: the row read back lacks the new columns.
  await assert.rejects(post(old, [{ boot: 9, inst: 0, fw: 2, ms: 6000, epoch: T0 + 6, rpm: 950, flags: F.ENGINE_ON }]));
  // A new session: the upsert names columns the table does not have.
  await assert.rejects(post(old, [{ boot: 11, inst: 0, fw: 2, ms: 6000, epoch: T0 + 6, rpm: 950, flags: F.ENGINE_ON }]), /odo_start/);
  assert.equal(one(old, "SELECT COUNT(*) AS n FROM samples").n, 7);
  assert.equal(one(old, "SELECT COUNT(*) AS n FROM trips").n, 2);
  assert.equal(one(old, "SELECT COUNT(*) AS n FROM ingests").n, 0);
});

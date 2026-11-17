// The real handleIngest against a D1 look-alike, end to end: bytes in, rows out.
// The rule behind most of these: the logger deletes what it sent on any 2xx, so an upload is
// either stored completely or answered with an error.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { encodeRecord, F, joinRecords, MAX_UPLOAD_RECORDS } from "../scripts/lib/record-encode.mjs";
import { getLatest, handleIngest, MAX_BODY_BYTES } from "../src/ingest";
import { makeEnv, one, rows } from "./helpers/d1.mjs";
import {
  assertRowsNear, drive, encodeAll, near, noLink, post, postChunks, referenceTrip, restoreNow, setNow, sid, snapshot,
  T0, watchBatches,
} from "./helpers/drive.mjs";

afterEach(restoreNow);

const count = (env, table) => one(env, `SELECT COUNT(*) AS n FROM ${table}`).n;
const GOLDEN_HEX = "c8010c0040e201003beff46ad8db8a16684bffb66608d2046437890336015817bf15ff0ff7ee0100e2360b01ad02077c";

// ------------------------------------------------------------ what gets refused

test("a body over 65,536 bytes is refused with 413 before anything touches the database", async () => {
  setNow(T0 + 2000);
  const env = makeEnv();
  assert.equal(MAX_BODY_BYTES, 65536);

  // 1,366 perfectly good records are 65,568 bytes.
  const r = await post(env, encodeAll(drive({ n: 1366 })));
  assert.equal(r.status, 413);
  assert.deepEqual(r.json, { ok: false, error: "too large" });

  // One byte over is enough.
  assert.equal((await post(env, new Uint8Array(65537))).status, 413);

  // So is the declared length alone. The body is then not even read.
  const declared = {
    headers: new Headers({ "Content-Length": "65537" }),
    arrayBuffer: async () => { throw new Error("the body was read"); },
  };
  const res = await handleIngest(declared, env);
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { ok: false, error: "too large" });

  assert.equal(env.DB.statements, 0, "no statement ran");
});

test("a body of exactly 65,536 bytes is stored", async () => {
  setNow(T0 + 2000);
  const env = makeEnv();
  // 1,365 records and a 16-byte torn tail.
  const body = new Uint8Array(65536);
  body.set(encodeAll(drive({ n: 1365 })));
  const r = await post(env, body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, records: 1365, rejected: 1 });
  assert.equal(count(env, "samples"), 1365);
  assert.equal(one(env, "SELECT n FROM trips").n, 1365);
  assert.equal(env.DB.batches.length, 1);
});

test("an intact record of an unknown version gives 422 and writes nothing", async (t) => {
  setNow(T0 + 100);
  const warned = t.mock.method(console, "warn", () => {});
  const env = makeEnv();
  const good = drive({ n: 3 });
  const body = joinRecords([encodeRecord(good[0]), encodeRecord({ ...good[1], version: 2 }), encodeRecord(good[2])]);
  const r = await post(env, body);
  assert.equal(r.status, 422);
  assert.deepEqual(r.json, { ok: false, error: "unknown record version", unknown: 1 });
  assert.equal(env.DB.statements, 0, "no statement ran, not even a read");
  assert.equal(warned.mock.callCount(), 1, "the refusal leaves a line in the Worker log");
  for (const name of ["samples", "trips", "minutes", "track", "boots", "latest", "ingests"]) assert.equal(count(env, name), 0, name);

  // The same records in the known version are stored on the retry.
  const again = await post(env, good);
  assert.deepEqual(again.json, { ok: true, records: 3, rejected: 0 });
  assert.equal(count(env, "samples"), 3);
});

test("a flipped byte and a torn tail are counted as rejected, the rest is stored", async () => {
  setNow(T0 + 100);
  const env = makeEnv();
  const fields = drive({ n: 3 });
  const body = new Uint8Array(3 * 48 + 20);
  body.set(encodeAll(fields));
  body[48 + 21] ^= 0x40; // inside the second record
  body.set(encodeRecord(fields[2]).subarray(0, 20), 3 * 48); // a record cut off by a power loss

  const r = await post(env, body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, records: 2, rejected: 2 });
  assert.deepEqual(rows(env, "SELECT ms FROM samples ORDER BY ms").map((x) => x.ms), [fields[0].ms, fields[2].ms]);
  assert.deepEqual(rows(env, "SELECT * FROM ingests"), [{ received_at: T0 + 100, bytes: 164, records: 2, rejected: 2 }]);
});

test("a torn segment in the middle of a body does not cost the records behind it", async (t) => {
  setNow(T0 + 100);
  const env = makeEnv();
  // Older firmware sends its segment files back to back at their raw size. Here the first
  // one ends in 20 bytes of a record that was never finished, and the next session follows.
  const before = drive({ boot: 11, inst: 0, fw: 0, n: 3 });
  const after = drive({ boot: 12, inst: 0, fw: 0, n: 5, base: T0 + 40 });
  const torn = encodeRecord({ ...before[2], ms: before[2].ms + 1000 }).subarray(0, 20);
  const body = joinRecords([encodeAll(before), torn, encodeAll(after)]);
  assert.equal(body.length, 8 * 48 + 20);

  const r = await post(env, body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, records: 8, rejected: 1 });
  assert.deepEqual(rows(env, "SELECT boot, ms FROM samples ORDER BY boot, ms"),
    [...before, ...after].map((x) => ({ boot: x.boot, ms: x.ms })));
  assert.deepEqual(rows(env, "SELECT boot, n FROM trips ORDER BY boot"), [{ boot: 11, n: 3 }, { boot: 12, n: 5 }]);
  assert.deepEqual(rows(env, "SELECT * FROM ingests"), [{ received_at: T0 + 100, bytes: 404, records: 8, rejected: 1 }]);

  // A record of an unknown version behind the torn piece still refuses the whole upload.
  t.mock.method(console, "warn", () => {});
  const other = makeEnv();
  const v2 = await post(other, joinRecords([encodeAll(before), torn, encodeRecord({ ...after[0], version: 2 }), encodeAll(after.slice(1))]));
  assert.equal(v2.status, 422);
  assert.deepEqual(v2.json, { ok: false, error: "unknown record version", unknown: 1 });
  assert.equal(other.DB.statements, 0);
});

test("the golden record is stored with the contract's values", async () => {
  setNow(T0 + 200);
  const env = makeEnv();
  const r = await post(env, new Uint8Array(Buffer.from(GOLDEN_HEX, "hex")));
  assert.deepEqual(r.json, { ok: true, records: 1, rejected: 0 });
  assert.deepEqual(rows(env, "SELECT * FROM samples"), [{
    boot: 11337740, ms: 123456, ts: 1794436923, ts_est: 0, lat: 37.8199, lon: -122.4783, sats: 11, rpm: 2150,
    speed_kph: 88, coolant_c: 90.5, intake_c: 31, maf_gs: 12.34, throttle_pct: 23, fuel_pct: 74.9, adapter_v: 14.18,
    ecu_v: 14.05, odo_km: 12671.1, csq: 21, flags: 1,
  }]);
  assert.deepEqual(rows(env, "SELECT * FROM boots"), [{ boot: 11337740, epoch_base: T0 }]);
  const trip = one(env, "SELECT * FROM trips");
  assert.deepEqual(
    [trip.boot, trip.n, trip.engine_n, trip.odo_start, trip.odo_end, trip.fw, trip.nolink_n, trip.start_ts, trip.est],
    [11337740, 1, 1, 12671.1, 12671.1, 2, 0, 1794436923, 0],
  );
});

// ------------------------------------------------------------ uploads without samples

test("an empty or fully rejected upload is logged but does not touch latest", async () => {
  const env = makeEnv();

  // On a new database there is no latest row to begin with.
  // 96 bytes without a record in them are one damaged stretch, so rejected is 1.
  setNow(T0 + 50);
  const garbage = new Uint8Array(96).fill(0x55);
  assert.deepEqual((await post(env, garbage)).json, { ok: true, records: 0, rejected: 1 });
  assert.equal(count(env, "latest"), 0);
  assert.equal(count(env, "ingests"), 1);

  setNow(T0 + 100);
  await post(env, drive({ n: 5 }));
  const before = one(env, "SELECT json FROM latest").json;
  assert.equal(JSON.parse(before).last_upload.v, T0 + 100);

  setNow(T0 + 500);
  assert.deepEqual((await post(env, garbage)).json, { ok: true, records: 0, rejected: 1 });
  assert.deepEqual((await post(env, new Uint8Array(0))).json, { ok: true, records: 0, rejected: 0 });
  assert.deepEqual((await post(env, new Uint8Array(20))).json, { ok: true, records: 0, rejected: 1 });
  assert.equal(one(env, "SELECT json FROM latest").json, before, "the car did not report in");
  assert.deepEqual(
    rows(env, "SELECT received_at, bytes, records, rejected FROM ingests ORDER BY rowid"),
    [
      { received_at: T0 + 50, bytes: 96, records: 0, rejected: 1 },
      { received_at: T0 + 100, bytes: 240, records: 5, rejected: 0 },
      { received_at: T0 + 500, bytes: 96, records: 0, rejected: 1 },
      { received_at: T0 + 500, bytes: 0, records: 0, rejected: 0 },
      { received_at: T0 + 500, bytes: 20, records: 0, rejected: 1 },
    ],
  );
  assert.equal(count(env, "samples"), 5);
});

test("the upload log is pruned after 30 days", async () => {
  const env = makeEnv();
  setNow(T0);
  await post(env, new Uint8Array(0));
  setNow(T0 + 29 * 86400);
  await post(env, new Uint8Array(0));
  assert.equal(count(env, "ingests"), 2);
  setNow(T0 + 30 * 86400 + 1);
  await post(env, new Uint8Array(0));
  assert.deepEqual(rows(env, "SELECT received_at FROM ingests ORDER BY received_at").map((r) => r.received_at),
    [T0 + 29 * 86400, T0 + 30 * 86400 + 1]);
});

// ------------------------------------------------------------ replays and chunking

test("posting the same upload twice changes nothing the second time", async () => {
  const env = makeEnv();
  const fields = drive({ n: 200 });
  setNow(T0 + 230);
  assert.deepEqual((await post(env, fields)).json, { ok: true, records: 200, rejected: 0 });
  const before = snapshot(env);
  const latestBefore = await getLatest(env);
  assert.equal(before.samples.length, 200);
  assert.equal(before.trips.length, 1);
  assert.ok(before.minutes.length >= 3);
  assert.ok(before.track.length >= 10);

  setNow(T0 + 245);
  const batches = watchBatches(env);
  assert.deepEqual((await post(env, fields)).json, { ok: true, records: 200, rejected: 0 });
  assert.deepEqual(snapshot(env), before);

  // The replay wrote two rows: the latest row and the upload log. No sample was rewritten.
  assert.equal(batches.length, 1);
  assert.equal(batches[0].reduce((n, r) => n + r.meta.changes, 0), 2);

  const latestAfter = await getLatest(env);
  assert.deepEqual(latestAfter.last_upload, { v: T0 + 245, ts: T0 + 245, boot: 0, ms: 0 });
  assert.deepEqual({ ...latestAfter, last_upload: null }, { ...latestBefore, last_upload: null });
});

test("a replayed upload without a clock keeps its first estimated times", async () => {
  const env = makeEnv();
  const fields = drive({ n: 40, clock: false });
  setNow(T0 + 100);
  await post(env, fields);
  const before = snapshot(env);
  assert.equal(before.trips[0].est, 1);
  setNow(T0 + 160);
  assert.equal((await post(env, fields)).status, 200);
  assert.deepEqual(snapshot(env), before);
});

test("an upload that overlaps an earlier one only adds what is new", async () => {
  const all = drive({ n: 150 });
  const whole = makeEnv();
  setNow(T0 + 200);
  await post(whole, all);

  const env = makeEnv();
  await post(env, all.slice(0, 100));
  setNow(T0 + 215);
  await post(env, all.slice(50, 150));

  const a = snapshot(env), b = snapshot(whole);
  assert.deepEqual(a.samples, b.samples);
  assert.deepEqual(a.track, b.track);
  assertRowsNear(a.trips, b.trips, { label: "trips" });
  assertRowsNear(a.minutes, b.minutes, { label: "minutes" });
});

test("the same record twice in one upload counts once", async () => {
  const fields = drive({ n: 30 });
  const env = makeEnv(), clean = makeEnv();
  setNow(T0 + 100);
  // The copies differ in a value, so it shows which one is kept: the first, in samples and rollups alike.
  const doubled = [...fields.slice(0, 20), { ...fields[19], rpm: 6500 }, { ...fields[5], rpm: 6500 }, ...fields.slice(20)];
  assert.deepEqual((await post(env, doubled)).json, { ok: true, records: 32, rejected: 0 });
  await post(clean, fields);
  assert.deepEqual(snapshot(env), snapshot(clean));
  assert.equal(one(env, "SELECT n FROM trips").n, 30);
});

test("one drive gives the same trip and minutes posted at once or in pieces", async () => {
  const fields = drive({ n: 600 }); // ten minutes at 1 Hz, 28,800 bytes
  const whole = makeEnv();
  setNow(T0 + 700);
  assert.deepEqual((await post(whole, fields)).json, { ok: true, records: 600, rejected: 0 });
  const want = snapshot(whole);
  assert.equal(want.trips.length, 1);
  assert.equal(want.minutes.length, 11); // T0+20 to T0+619

  for (const sizes of [[31], [1, 40, 300], [MAX_UPLOAD_RECORDS], [7, 200, 13]]) {
    const env = makeEnv();
    const posts = await postChunks(env, fields, sizes, { now: T0 + 700 });
    assert.ok(posts > 1);
    assert.equal(env.DB.batches.length, posts, "one batch per upload");
    const got = snapshot(env);
    const label = `chunks of ${sizes.join("/")}`;
    assert.deepEqual(got.samples, want.samples, label);
    assert.deepEqual(got.track, want.track, label);
    assertRowsNear(got.trips, want.trips, { label: `${label}: trips` });
    assertRowsNear(got.minutes, want.minutes, { label: `${label}: minutes` });
  }

  // And the trip row is right, not only the same every time.
  const ref = referenceTrip(fields);
  const trip = want.trips[0];
  assertRowsNear(
    {
      boot: trip.boot, start_ts: trip.start_ts, end_ts: trip.end_ts, last_ms: trip.last_ms, track_ms: trip.track_ms,
      n: trip.n, gps_n: trip.gps_n, engine_n: trip.engine_n, km: trip.km, maf_g: trip.maf_g, engine_s: trip.engine_s,
      moving_s: trip.moving_s, max_kph: trip.max_kph, max_rpm: trip.max_rpm, max_coolant: trip.max_coolant,
      rpm_sum: trip.rpm_sum, rpm_n: trip.rpm_n, est: trip.est, odo_start: trip.odo_start, odo_end: trip.odo_end,
      fw: trip.fw, nolink_n: trip.nolink_n,
    },
    {
      boot: sid(12, 173), start_ts: T0 + 20, end_ts: T0 + 619, last_ms: 619000, track_ms: ref.track_ms,
      n: 600, gps_n: 600, engine_n: 600, km: ref.km, maf_g: ref.maf_g, engine_s: 599, moving_s: ref.moving_s,
      max_kph: 100, max_rpm: 3000, max_coolant: 95, rpm_sum: ref.rpm_sum, rpm_n: 600, est: 0,
      odo_start: 12671.1, odo_end: ref.odo_end, fw: 2, nolink_n: 0,
    },
    { label: "trip against the reference" },
  );
  assert.ok(ref.km > 5 && ref.odo_end > 12671.1, "the made-up drive really moves");
  assert.deepEqual(want.track.map((p) => [p.ms, p.mph]), ref.track.map((p) => [p.ms, p.mph]));
  // Minutes add up to the trip.
  const sums = one(whole, "SELECT SUM(n) AS n, SUM(km) AS km, SUM(maf_g) AS maf_g, SUM(engine_s) AS engine_s, SUM(gps_n) AS gps_n FROM minutes");
  assertRowsNear(sums, { n: 600, km: trip.km, maf_g: trip.maf_g, engine_s: 599, gps_n: 600 }, { label: "minute sums" });
});

test("a full 341-record upload of slow records goes through in one batch", async () => {
  const env = makeEnv();
  const fields = drive({ n: MAX_UPLOAD_RECORDS, stepMs: 2000 }); // 2 s apart with GPS, 16,368 bytes
  assert.equal(encodeAll(fields).length, 16368);
  setNow(T0 + 720);
  const r = await post(env, fields);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, records: 341, rejected: 0 });

  assert.equal(env.DB.batches.length, 1, "exactly one batch");
  assert.ok(env.DB.batches[0] > 400, `${env.DB.batches[0]} statements, more than the old slice of 400`);

  const ref = referenceTrip(fields);
  const trip = one(env, "SELECT * FROM trips");
  assert.equal(count(env, "samples"), 341);
  assert.equal(trip.n, 341);
  assert.equal(trip.gps_n, 341);
  assert.equal(trip.last_ms, 20000 + 340 * 2000);
  assert.ok(near(trip.km, ref.km) && near(trip.engine_s, 680) && near(trip.maf_g, ref.maf_g));
  assert.equal(count(env, "track"), ref.track.length);
  assert.equal(ref.track.length, 43); // every 16 s over 680 s
  assert.equal(one(env, "SELECT SUM(n) AS n FROM minutes").n, 341);
  assert.equal((await getLatest(env)).rpm.ms, trip.last_ms);
});

test("more than 100 sessions in one upload stay inside D1's limit of bound values", async () => {
  const env = makeEnv();
  const first = Array.from({ length: 120 }, (_, i) => ({ boot: i + 1, inst: 9, fw: 2, ms: 5000, epoch: T0 + i, rpm: 800, flags: F.ENGINE_ON }));
  setNow(T0 + 200);
  assert.deepEqual((await post(env, first)).json, { ok: true, records: 120, rejected: 0 });
  assert.equal(count(env, "trips"), 120);
  assert.equal(count(env, "boots"), 120);

  // The second upload has to find every one of the 120 trip rows and clock bases again.
  const second = first.map((r) => ({ ...r, ms: 6000, epoch: 0 }));
  setNow(T0 + 215);
  assert.deepEqual((await post(env, second)).json, { ok: true, records: 120, rejected: 0 });
  assert.deepEqual(rows(env, "SELECT DISTINCT n, engine_s, est FROM trips"), [{ n: 2, engine_s: 1, est: 0 }]);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM samples WHERE ts_est = 1").n, 0);
});

// ------------------------------------------------------------ failures

test("a failed batch keeps nothing, and the retry stores everything", async () => {
  const env = makeEnv();
  const fields = drive({ n: 120 });
  setNow(T0 + 200);
  // Fails late in the batch, after the samples and rollups were written inside the transaction.
  env.DB.sqlite.exec(`CREATE TRIGGER boom BEFORE INSERT ON latest BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`);
  await assert.rejects(post(env, fields), /disk on fire/);
  for (const t of ["samples", "trips", "minutes", "track", "boots", "latest", "ingests"]) assert.equal(count(env, t), 0, t);

  env.DB.sqlite.exec(`DROP TRIGGER boom`);
  assert.deepEqual((await post(env, fields)).json, { ok: true, records: 120, rejected: 0 });
  const clean = makeEnv();
  await post(clean, fields);
  assert.deepEqual(snapshot(env), snapshot(clean));
});

test("a damaged latest row does not block uploads", async () => {
  const env = makeEnv();
  env.DB.sqlite.exec(`INSERT INTO latest (id, json) VALUES (1, '{"rpm": {"v": 1')`);
  assert.deepEqual(await getLatest(env), {});
  setNow(T0 + 100);
  assert.equal((await post(env, drive({ n: 2 }))).status, 200);
  const L = await getLatest(env);
  assert.equal(L.rpm.v, 700);
  assert.equal(L.last_upload.v, T0 + 100);

  // Text that parses but holds an entry that is not whole, as a hand edit could leave it.
  // The entry is dropped and gets a fresh value. A whole entry next to it is kept.
  const kept = { v: 5, ts: 9, boot: 1, ms: 2 };
  for (const rpm of ["null", "5", '"x"', "[1]", '{"v": 1}', '{"v": 1, "ts": 5, "boot": null, "ms": 0}', '{"v": 1, "ts": 1e999, "boot": 1, "ms": 0}']) {
    const hurt = makeEnv();
    hurt.DB.sqlite.prepare(`INSERT INTO latest (id, json) VALUES (1, ?)`).run(`{"rpm": ${rpm}, "odo_km": ${JSON.stringify(kept)}}`);
    assert.deepEqual(await getLatest(hurt), { odo_km: kept }, rpm);
    const r = await post(hurt, drive({ n: 2, odo0: null }));
    assert.deepEqual(r, { status: 200, json: { ok: true, records: 2, rejected: 0 } }, rpm);
    const after = await getLatest(hurt);
    assert.deepEqual(after.rpm, { v: 700, ts: T0 + 21, boot: sid(12, 173), ms: 21000 }, rpm);
    assert.deepEqual(after.odo_km, kept, rpm);
    assert.equal(count(hurt, "samples"), 2, rpm);
  }
});

test("a second copy of an upload that commits in between is refused, not folded twice", async () => {
  const fields = drive({ n: 46 });
  setNow(T0 + 100);
  const clean = makeEnv();
  await post(clean, fields);
  const want = snapshot(clean);

  // The logger resends after a stall, and the resend is stored while the first request is
  // still between its read of the trip row and its batch. [stalled request, resend]:
  for (const [stalled, resent] of [[fields.slice(0, 31), fields], [fields, fields.slice(0, 31)], [fields, fields]]) {
    const env = makeEnv();
    const batch = env.DB.batch.bind(env.DB);
    let other;
    env.DB.batch = async (stmts) => {
      env.DB.batch = batch;
      other = await post(env, resent);
      return batch(stmts);
    };
    const label = `${stalled.length} stalled, ${resent.length} resent`;
    await assert.rejects(post(env, stalled), /NOT NULL constraint failed: ingests\.received_at/, label);
    assert.deepEqual(other, { status: 200, json: { ok: true, records: resent.length, rejected: 0 } }, label);
    assert.equal(one(env, "SELECT SUM(n) AS n FROM minutes").n, resent.length, `${label}: no minute is counted twice`);
    assert.equal(count(env, "ingests"), 1, `${label}: the refused upload left nothing`);

    // The logger got an error for the stalled request, so it sends that body again.
    assert.equal((await post(env, stalled)).status, 200, label);
    const got = snapshot(env);
    assert.deepEqual(got.samples, want.samples, label);
    assert.deepEqual(got.track, want.track, label);
    assertRowsNear(got.trips, want.trips, { label: `${label}: trips` });
    assertRowsNear(got.minutes, want.minutes, { label: `${label}: minutes` });
  }
});

test("a stalled resend made only of replays is refused too, so it cannot roll latest back", async () => {
  const fields = drive({ n: 46 });
  setNow(T0 + 100);
  const clean = makeEnv();
  await post(clean, fields);
  const want = snapshot(clean);
  const wantLatest = await getLatest(clean);

  // Records 1 to 31 are stored and the answer is lost. Their resend stalls between its reads
  // and its batch while a larger copy, records 1 to 46, is stored.
  const env = makeEnv();
  assert.equal((await post(env, fields.slice(0, 31))).status, 200);
  const batch = env.DB.batch.bind(env.DB);
  let other;
  env.DB.batch = async (stmts) => {
    env.DB.batch = batch;
    other = await post(env, fields);
    return batch(stmts);
  };
  await assert.rejects(post(env, fields.slice(0, 31)), /NOT NULL constraint failed: ingests\.received_at/);
  assert.deepEqual(other, { status: 200, json: { ok: true, records: 46, rejected: 0 } });
  assert.equal(count(env, "ingests"), 2, "the refused upload left nothing");
  let L = await getLatest(env);
  for (const k of ["rpm", "engine_on", "odo_km"]) assert.deepEqual(L[k], wantLatest[k], k);

  // The logger sends the refused body again. It is a plain replay now and changes nothing.
  assert.deepEqual(await post(env, fields.slice(0, 31)), { status: 200, json: { ok: true, records: 31, rejected: 0 } });
  L = await getLatest(env);
  for (const k of ["rpm", "engine_on", "odo_km"]) assert.deepEqual(L[k], wantLatest[k], k);
  assert.equal(L.rpm.ms, fields[45].ms);
  const got = snapshot(env);
  assert.deepEqual(got.samples, want.samples);
  assert.deepEqual(got.track, want.track);
  assertRowsNear(got.trips, want.trips, { label: "trips" });
  assertRowsNear(got.minutes, want.minutes, { label: "minutes" });
});

// ------------------------------------------------------------ clocks

test("clock learning: estimated times are fixed by a later upload that carries the time", async () => {
  const env = makeEnv();
  const boot = sid(12, 173);
  const base = T0 + 50; // true unix time at ms 0 of the session
  const all = drive({ n: 79, ms0: 2000, base });
  const clockless = (list) => list.map((r) => ({ ...r, epoch: 0 }));

  // Upload 1: the modem has no time yet. The newest record is assumed to be from right now.
  const now1 = T0 + 100;
  setNow(now1);
  await post(env, clockless(all.slice(0, 40))); // ms 2000 to 41000
  assert.deepEqual(one(env, "SELECT MIN(ts) AS lo, MAX(ts) AS hi, MIN(ts_est) AS est, COUNT(*) AS n FROM samples"),
    { lo: now1 - 39, hi: now1, est: 1, n: 40 });
  assert.deepEqual(one(env, "SELECT start_ts, end_ts, est, n FROM trips"), { start_ts: now1 - 39, end_ts: now1, est: 1, n: 40 });
  assert.deepEqual(rows(env, "SELECT ms, ts FROM track ORDER BY ms"), [{ ms: 15000, ts: now1 - 26 }, { ms: 30000, ts: now1 - 11 }]);
  assert.equal(count(env, "boots"), 0);
  let L = await getLatest(env);
  assert.deepEqual(L.rpm, { v: all[39].rpm, ts: now1, boot, ms: 41000, est: true });
  assert.deepEqual(L.odo_km, { v: all[39].odo_km, ts: now1, boot, ms: 41000, est: true });

  // Upload 2: now with the time, and without an odometer reading.
  setNow(T0 + 130);
  await post(env, all.slice(40, 70).map(({ odo_km, ...r }) => r)); // ms 42000 to 71000
  assert.deepEqual(rows(env, "SELECT boot, epoch_base FROM boots"), [{ boot, epoch_base: base }]);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM samples WHERE ts_est = 0 AND ts = ? + ms / 1000", base).n, 70, "every sample has its real time");
  assert.deepEqual(one(env, "SELECT start_ts, end_ts, est, n FROM trips"), { start_ts: base + 2, end_ts: base + 71, est: 0, n: 70 });
  assert.deepEqual(rows(env, "SELECT ms, ts FROM track ORDER BY ms"),
    [15, 30, 45, 60].map((s) => ({ ms: s * 1000, ts: base + s })));
  L = await getLatest(env);
  assert.deepEqual(L.rpm, { v: all[69].rpm, ts: base + 71, boot, ms: 71000 });
  // Not in upload 2, so still the value from upload 1, but with its time corrected.
  assert.deepEqual(L.odo_km, { v: all[39].odo_km, ts: base + 41, boot, ms: 41000 });
  assert.ok(Object.values(L).every((e) => !e.est), "no estimated entry is left");
  // Minute buckets keep the slot they were first counted in. Only the total is exact.
  assert.deepEqual(rows(env, "SELECT t, n FROM minutes ORDER BY t"), [{ t: T0 + 60, n: 68 }, { t: T0 + 120, n: 2 }]);

  // Upload 3: records without a time again. The stored base dates them.
  setNow(T0 + 145);
  await post(env, clockless(all.slice(70))); // ms 72000 to 80000
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM samples WHERE ts_est = 0 AND ts = ? + ms / 1000", base).n, 79);
  assert.deepEqual(one(env, "SELECT start_ts, end_ts, est, n FROM trips"), { start_ts: base + 2, end_ts: base + 80, est: 0, n: 79 });
});

test("a device clock in the future counts as unknown, for every firmware build", async () => {
  const env = makeEnv();
  const now = T0 + 1000;
  setNow(now);
  await post(env, [
    { boot: 1, inst: 0, fw: 0, ms: 9000, epoch: now + 301, rpm: 800 },
    { boot: 2, inst: 4, fw: 2, ms: 9000, epoch: now + 301, rpm: 800 },
    { boot: 3, inst: 4, fw: 2, ms: 9000, epoch: now + 300, rpm: 800 },
  ]);
  assert.deepEqual(rows(env, "SELECT boot, ts, ts_est FROM samples ORDER BY boot"), [
    { boot: 1, ts: now, ts_est: 1 },
    { boot: sid(2, 4), ts: now, ts_est: 1 },
    { boot: sid(3, 4), ts: now + 300, ts_est: 0 },
  ]);
  assert.deepEqual(rows(env, "SELECT boot, epoch_base FROM boots"), [{ boot: sid(3, 4), epoch_base: now + 291 }]);
});

// A session that never got a trusted clock: 90 records at 1 Hz, really written at
// T0 + ms / 1000. The first 60 are uploaded while driving, 30 at a time, one second after the
// newest was written. The last 30 stay on the logger when the ignition goes off.
const WRITTEN = (r) => T0 + r.ms / 1000;
async function uploadLivePart(env, all) {
  for (const part of [all.slice(0, 30), all.slice(30, 60)]) {
    setNow(WRITTEN(part[29]) + 1);
    assert.deepEqual((await post(env, part)).json, { ok: true, records: 30, rejected: 0 });
  }
  assert.deepEqual(one(env, "SELECT n, start_ts, end_ts, est FROM trips WHERE boot = ?", sid(all[0].boot, all[0].inst)),
    { n: 60, start_ts: WRITTEN(all[0]) + 1, end_ts: WRITTEN(all[59]) + 1, est: 1 });
}
// Every one of the 90 samples is still an estimate, one second late like the live part.
function assertStillEstimated(env, all, label) {
  const boot = sid(all[0].boot, all[0].inst);
  assert.deepEqual(rows(env, "SELECT ms, ts - ms / 1000 AS at0, ts_est FROM samples WHERE boot = ? ORDER BY ms", boot),
    all.map((r) => ({ ms: r.ms, at0: T0 + 1, ts_est: 1 })), label);
  assert.deepEqual(one(env, "SELECT n, start_ts, end_ts, est FROM trips WHERE boot = ?", boot),
    { n: 90, start_ts: WRITTEN(all[0]) + 1, end_ts: WRITTEN(all[89]) + 1, est: 1 }, label);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM boots WHERE boot = ?", boot).n, 0, `${label}: no clock was learned`);
  // The minutes of the tail sit next to the others, not hours later.
  assert.deepEqual(rows(env, "SELECT t, n FROM minutes WHERE boot = ? ORDER BY t", boot), [{ t: T0, n: 39 }, { t: T0 + 60, n: 51 }], label);
}

test("a legacy clock that is 8 h ahead is not learned when the tail arrives 9 h later", async () => {
  const env = makeEnv();
  // Firmware before the clock fix stamps the cell clock plus 8 h until GNSS locks.
  const all = drive({ boot: 30, inst: 0, fw: 0, n: 90, gps: false, odo0: null, base: T0 + 8 * 3600 });
  await uploadLivePart(env, all); // the clock looks like the future here and is ignored

  // Next start, 9 h later: the tail goes out first, together with the new session. By now
  // the wrong clock no longer looks like the future.
  const later = T0 + 9 * 3600 + 200;
  setNow(later);
  const next = drive({ boot: 31, inst: 0, fw: 0, n: 5, gps: false, odo0: null, base: later - 24 + 8 * 3600 });
  assert.deepEqual((await post(env, [...all.slice(60), ...next])).json, { ok: true, records: 35, rejected: 0 });
  assertStillEstimated(env, all, "tail 9 h later");
  // The new session is dated at this upload, as before.
  assert.deepEqual(one(env, "SELECT start_ts, end_ts, est FROM trips WHERE boot = 31"), { start_ts: later - 4, end_ts: later, est: 1 });
});

test("the same holds when the last live upload is sent again together with the tail", async () => {
  const env = makeEnv();
  const all = drive({ boot: 30, inst: 0, fw: 0, n: 90, gps: false, odo0: null, base: T0 + 8 * 3600 });
  await uploadLivePart(env, all);
  // The answer to the second live upload was lost, so its records are still on the logger.
  // They carry the same wrong clock as the tail.
  setNow(T0 + 9 * 3600 + 200);
  assert.deepEqual((await post(env, all.slice(30))).json, { ok: true, records: 60, rejected: 0 });
  assertStillEstimated(env, all, "resend and tail 9 h later");
});

test("the tail of a session without a clock is not dated at the upload that brings it", async () => {
  const env = makeEnv();
  const all = drive({ boot: 40, n: 90, clock: false });
  await uploadLivePart(env, all);
  const later = T0 + 2 * 3600;
  setNow(later);
  const next = drive({ boot: 41, n: 5, base: later - 30 });
  await post(env, [...all.slice(60), ...next]);
  assertStillEstimated(env, all, "tail 2 h later");
  // A tail with a few replayed records in front keeps the stored times as well.
  await post(env, all.slice(55));
  assertStillEstimated(env, all, "tail sent again");
});

test("a true clock that arrives hours later with the tail is still learned", async () => {
  const env = makeEnv();
  const boot = sid(40, 173);
  const all = drive({ boot: 40, n: 90 }); // epoch is the real time of each record
  await uploadLivePart(env, all.map((r, i) => (i < 60 ? { ...r, epoch: 0 } : r)));
  setNow(T0 + 2 * 3600);
  await post(env, all.slice(60));
  assert.deepEqual(rows(env, "SELECT boot, epoch_base FROM boots"), [{ boot, epoch_base: T0 }]);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM samples WHERE ts_est = 0 AND ts = ? + ms / 1000", T0).n, 90);
  assert.deepEqual(one(env, "SELECT n, start_ts, end_ts, est FROM trips WHERE boot = ?", boot),
    { n: 90, start_ts: WRITTEN(all[0]), end_ts: WRITTEN(all[89]), est: 0 });
});

test("the legacy GPS correction applies to firmware build 0 only", async () => {
  const env = makeEnv();
  // What firmware before the GPS fix stored for 37.8199, -122.4783 (degrees read as ddmm.mmmm).
  const lat = 37.8199 / 60, lon = -(1 + 22.4783 / 60);
  setNow(T0 + 100);
  await post(env, [
    { boot: 5, inst: 0, fw: 0, ms: 1000, epoch: T0 + 90, lat, lon, sats: 5 },
    { boot: 5, inst: 9, fw: 2, ms: 1000, epoch: T0 + 90, lat, lon, sats: 5 },
    { boot: 6, inst: 0, fw: 0, ms: 1000, epoch: T0 + 90, lat: 37.8199, lon: -122.4783, sats: 5 },
  ]);
  const at = (boot) => one(env, "SELECT lat, lon FROM samples WHERE boot = ?", boot);
  const close = (a, b) => Math.abs(a - b) < 1e-5;
  assert.ok(close(at(5).lat, 37.8199) && close(at(5).lon, -122.4783), `legacy record corrected: ${JSON.stringify(at(5))}`);
  assert.ok(close(at(sid(5, 9)).lat, lat) && close(at(sid(5, 9)).lon, lon), "a build 2 record near 0,0 is left alone");
  assert.deepEqual(at(6), { lat: 37.8199, lon: -122.4783 }, "a legacy record with a normal position is left alone");

  // latest gets the corrected position as well.
  const solo = makeEnv();
  await post(solo, [{ boot: 5, inst: 0, fw: 0, ms: 1000, epoch: T0 + 90, lat, lon, sats: 5 }]);
  const L = await getLatest(solo);
  assert.ok(close(L.lat.v, 37.8199) && close(L.lon.v, -122.4783), JSON.stringify(L.lat));
});

// ------------------------------------------------------------ latest

test("latest follows time across sessions, not the session number", async () => {
  const env = makeEnv();
  const entries = (L) => Object.fromEntries(Object.entries(L).filter(([k]) => k !== "last_upload"));

  // Session 500 of a legacy board is seen first.
  const a = drive({ boot: 500, inst: 0, fw: 0, n: 5, base: T0 + 1000 });
  setNow(T0 + 1030);
  await post(env, a);
  let L = await getLatest(env);
  assert.deepEqual(L.rpm, { v: a[4].rpm, ts: T0 + 1024, boot: 500, ms: 24000 });
  assert.deepEqual(L.fw, { v: 0, ts: T0 + 1024, boot: 500, ms: 24000 });
  assert.deepEqual(L.link, { v: 1, ts: T0 + 1024, boot: 500, ms: 24000 });
  assert.deepEqual(L.engine_on, { v: 1, ts: T0 + 1024, boot: 500, ms: 24000 });

  // A session with a lower number reports later. It must win on every field.
  const b = drive({ boot: 3, inst: 0, fw: 2, n: 5, base: T0 + 2000 });
  setNow(T0 + 2030);
  await post(env, b);
  L = await getLatest(env);
  const at = { ts: T0 + 2024, boot: 3, ms: 24000 };
  for (const [k, e] of Object.entries(entries(L))) assert.equal(e.boot, 3, k);
  assert.deepEqual(L.speed_kph, { v: b[4].speed_kph, ...at });
  assert.deepEqual(L.odo_km, { v: b[4].odo_km, ...at });
  assert.deepEqual(L.lat, { v: b[4].lat, ...at });
  assert.deepEqual(L.fw, { v: 2, ...at });
  assert.deepEqual(L.link, { v: 1, ...at });
  assert.deepEqual(Object.keys(entries(L)).sort(), ["adapter_v", "coolant_c", "csq", "ecu_v", "engine_on", "fuel_pct", "fw",
    "intake_c", "lat", "link", "lon", "maf_gs", "odo_km", "rpm", "sats", "speed_kph", "throttle_pct"]);
  const newest = entries(L);

  // A backlog from an older session with a higher number arrives afterwards. Nothing moves.
  setNow(T0 + 2040);
  await post(env, drive({ boot: 900, inst: 0, fw: 0, n: 5, base: T0 + 500 }));
  assert.deepEqual(entries(await getLatest(env)), newest);
  // Same for an old session of a board with an install id, whose number is far higher.
  await post(env, drive({ boot: 1, inst: 173, fw: 2, n: 5, base: T0 + 1500 }));
  assert.deepEqual(entries(await getLatest(env)), newest);
  // Inside one session an older record never replaces a newer one.
  await post(env, [{ ...b[0], rpm: 6000 }]);
  assert.deepEqual(entries(await getLatest(env)), newest);
  assert.equal(count(env, "trips"), 4);

  // The adapter link drops: position and signal keep coming, the engine values stay as they were.
  setNow(T0 + 2065);
  await post(env, [noLink({ boot: 3, inst: 0, fw: 2, ms: 60000, base: T0 + 2000, lat: 37.82, lon: -122.47 })]);
  L = await getLatest(env);
  const down = { ts: T0 + 2060, boot: 3, ms: 60000 };
  assert.deepEqual(L.link, { v: 0, ...down });
  assert.deepEqual(L.engine_on, { v: 0, ...down });
  assert.deepEqual(L.fw, { v: 2, ...down });
  assert.deepEqual(L.lat, { v: 37.82, ...down });
  assert.deepEqual(L.csq, { v: 17, ...down });
  assert.deepEqual(L.rpm, newest.rpm);
  assert.deepEqual(L.odo_km, newest.odo_km);
});

test("in one body the later session wins latest, also over a session without a clock", async () => {
  const env = makeEnv();
  // Session 11 never had a clock and never got an upload out. Its records are dated at this
  // upload, which is later than the few seconds old records of the session that is running.
  const parked = drive({ boot: 11, n: 10, clock: false }).map(({ rpm, ...r }) => ({ ...r, rpm: 0, flags: 0 }));
  const running = drive({ boot: 12, n: 12, base: T0 + 3600 }); // ms 20000 to 31000
  setNow(T0 + 3600 + 34);
  assert.deepEqual((await post(env, [...parked, ...running])).json, { ok: true, records: 22, rejected: 0 });
  assert.equal(one(env, "SELECT end_ts FROM trips WHERE boot = ?", sid(11, 173)).end_ts, T0 + 3634, "the old session really has the later time");

  const L = await getLatest(env);
  const at = { ts: T0 + 3631, boot: sid(12, 173), ms: 31000 };
  for (const [k, e] of Object.entries(L)) if (k !== "last_upload") assert.equal(e.boot, at.boot, k);
  assert.deepEqual(L.rpm, { v: running[11].rpm, ...at });
  assert.deepEqual(L.engine_on, { v: 1, ...at });
});

test("a 0 % fuel reading does not replace the last real one in latest", async () => {
  const env = makeEnv();
  const boot = sid(12, 173);
  // 57.6 %, then one bad PID 2F reply carried into the last three records.
  const fields = drive({ n: 10 }).map((r, i) => ({ ...r, fuel_raw: i < 7 ? 147 : 0 })); // ms 20000 to 29000
  setNow(T0 + 30);
  await post(env, fields);
  let L = await getLatest(env);
  assert.deepEqual(L.fuel_pct, { v: 57.6, ts: T0 + 26, boot, ms: 26000 });
  assert.equal(L.rpm.ms, 29000, "the other fields still come from the newest record");
  // The readings themselves are stored as they came.
  assert.deepEqual(rows(env, "SELECT fuel_pct FROM samples WHERE ms >= 26000 ORDER BY ms").map((r) => r.fuel_pct), [57.6, 0, 0, 0]);

  // An upload of nothing but 0 % readings leaves it too, and a real reading replaces it as usual.
  setNow(T0 + 45);
  await post(env, drive({ n: 5, ms0: 30000 }).map((r) => ({ ...r, fuel_raw: 0 })));
  L = await getLatest(env);
  assert.deepEqual([L.fuel_pct.v, L.fuel_pct.ms, L.rpm.ms], [57.6, 26000, 34000]);
  setNow(T0 + 60);
  await post(env, drive({ n: 1, ms0: 40000 }).map((r) => ({ ...r, fuel_raw: 145 })));
  assert.deepEqual((await getLatest(env)).fuel_pct, { v: 56.9, ts: T0 + 40, boot, ms: 40000 });
});

test("engine_on bridges a missed RPM reply for 5 s, and nothing else", async () => {
  const boot = sid(12, 173);
  const on = drive({ n: 30 }); // ms 20000 to 49000, every record with an RPM above zero
  // A record as the firmware writes it when the RPM reply is missing: no RPM, no engine bit.
  const noRpm = (ms, more = {}) => {
    const { rpm, ...rest } = on[29];
    return { ...rest, ms, epoch: T0 + ms / 1000, flags: 0, ...more };
  };
  const engine = async (env) => (await getLatest(env)).engine_on;
  const fresh = async () => {
    const env = makeEnv();
    setNow(T0 + 50);
    await post(env, on);
    assert.deepEqual(await engine(env), { v: 1, ts: T0 + 49, boot, ms: 49000 });
    return env;
  };

  // The newest record of an upload missed its reply: the car is still running.
  let env = makeEnv();
  setNow(T0 + 51);
  await post(env, [...on, noRpm(50000)]);
  assert.deepEqual(await engine(env), { v: 1, ts: T0 + 50, boot, ms: 50000 });
  assert.equal((await getLatest(env)).rpm.ms, 49000);
  assert.deepEqual(one(env, "SELECT n, engine_n FROM trips"), { n: 31, engine_n: 30 }, "what is stored about the record does not change");

  // The same when the last RPM is in the stored row and the record comes alone.
  env = await fresh();
  await post(env, [noRpm(50000)]);
  assert.equal((await engine(env)).v, 1);

  // A real shutdown, the ECU stays silent: on up to 5 s after the last RPM, off from then on.
  env = await fresh();
  for (const [ms, v] of [[51000, 1], [54000, 1], [55000, 0], [56000, 0]]) {
    await post(env, [noRpm(ms)]);
    assert.deepEqual(await engine(env), { v, ts: T0 + ms / 1000, boot, ms }, `${ms - 49000} ms after the last RPM`);
  }
  env = await fresh();
  await post(env, [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60].map((s) => noRpm(s * 1000)));
  assert.deepEqual(await engine(env), { v: 0, ts: T0 + 60, boot, ms: 60000 });

  // Off at once: a quiet record, a record without the adapter link, an RPM of zero.
  const offAtOnce = {
    quiet: { boot: 12, inst: 173, fw: 2, ms: 50000, epoch: T0 + 50, flags: F.QUIET, adapter_v: 12.6 },
    "no link": noLink({ ms: 50000 }),
    "rpm 0": noRpm(50000, { rpm: 0 }),
  };
  for (const [name, record] of Object.entries(offAtOnce)) {
    env = await fresh();
    await post(env, [record]);
    assert.deepEqual(await engine(env), { v: 0, ts: T0 + 50, boot, ms: 50000 }, name);
  }
  // In one body too, where the last RPM comes from the records before it.
  env = makeEnv();
  await post(env, [...on, offAtOnce.quiet]);
  assert.equal((await engine(env)).v, 0);

  // The RPM of another session bridges nothing.
  env = await fresh();
  await post(env, [noRpm(50000, { boot: 13 })]);
  assert.deepEqual(await engine(env), { v: 0, ts: T0 + 50, boot: sid(13, 173), ms: 50000 });
});

// ------------------------------------------------------------ trips: odometer, firmware, link

test("trips carry odometer ends, firmware build and link-down count across uploads", async () => {
  const env = makeEnv();
  const boot = sid(7, 173);
  const linked1 = drive({ boot: 7, fw: 3, n: 30, ms0: 20000 }); // ms 20000 to 49000
  for (const r of linked1.slice(0, 3)) delete r.odo_km; // the ECU has not answered the odometer yet
  // Link down: a position every 30 s. One of them wrongly carries the engine bit as well.
  const down = [79, 109, 139, 169, 199, 229].map((s, i) => noLink({
    boot: 7, ms: s * 1000, lat: 37.8199 + i * 0.001, lon: -122.4783 + i * 0.001,
    flags: i === 2 ? F.NO_LINK | F.ENGINE_ON : F.NO_LINK,
  }));
  const linked2 = drive({ boot: 7, fw: 3, n: 30, ms0: 232000, odo0: 126800 }); // back 3 s after the last one
  const everything = [...linked1, ...down, ...linked2];
  const ref = referenceTrip(everything);

  setNow(T0 + 140);
  await post(env, [...linked1, ...down.slice(0, 3)]);
  let trip = one(env, "SELECT * FROM trips WHERE boot = ?", boot);
  assert.deepEqual(
    { n: trip.n, nolink_n: trip.nolink_n, engine_n: trip.engine_n, gps_n: trip.gps_n, fw: trip.fw, odo_start: trip.odo_start, odo_end: trip.odo_end, engine_s: trip.engine_s },
    { n: 33, nolink_n: 3, engine_n: 30, gps_n: 33, fw: 3, odo_start: linked1[3].odo_km, odo_end: linked1[29].odo_km, engine_s: 29 },
  );
  let L = await getLatest(env);
  assert.equal(L.link.v, 0);
  assert.equal(L.engine_on.v, 0, "a record without the link never says engine on");
  assert.equal(L.engine_on.ts, T0 + 139);
  assert.equal(L.rpm.ts, T0 + 49);

  setNow(T0 + 265);
  await post(env, [...down.slice(3), ...linked2]);
  trip = one(env, "SELECT * FROM trips WHERE boot = ?", boot);
  assertRowsNear(
    {
      n: trip.n, nolink_n: trip.nolink_n, engine_n: trip.engine_n, gps_n: trip.gps_n, fw: trip.fw, odo_start: trip.odo_start,
      odo_end: trip.odo_end, engine_s: trip.engine_s, moving_s: trip.moving_s, km: trip.km, maf_g: trip.maf_g,
      rpm_n: trip.rpm_n, rpm_sum: trip.rpm_sum, last_ms: trip.last_ms, track_ms: trip.track_ms,
    },
    {
      n: 66, nolink_n: 6, engine_n: 60, gps_n: 66, fw: 3, odo_start: linked1[3].odo_km,
      odo_end: linked2[29].odo_km, engine_s: 29 + 3 + 29, moving_s: ref.moving_s, km: ref.km, maf_g: ref.maf_g,
      rpm_n: 60, rpm_sum: ref.rpm_sum, last_ms: 261000, track_ms: ref.track_ms,
    },
    { label: "trip with a link-down stretch" },
  );
  assert.ok(trip.odo_start < trip.odo_end);
  L = await getLatest(env);
  assert.equal(L.link.v, 1);
  assert.equal(L.engine_on.v, 1);

  // Link-down records add route points, without a speed.
  const track = rows(env, "SELECT ms, mph FROM track WHERE boot = ? ORDER BY ms", boot);
  assert.deepEqual(track.map((p) => [p.ms, p.mph]), ref.track.map((p) => [p.ms, p.mph]));
  const downMs = new Set(down.map((r) => r.ms));
  const downPoints = track.filter((p) => downMs.has(p.ms));
  assert.equal(downPoints.length, 6);
  assert.ok(downPoints.every((p) => p.mph === null));
  assert.ok(track.filter((p) => !downMs.has(p.ms)).every((p) => p.mph !== null));
  // And they are in the minutes as samples, never as engine time.
  assert.deepEqual(one(env, "SELECT SUM(n) AS n, SUM(engine_n) AS engine_n, SUM(gps_n) AS gps_n FROM minutes WHERE boot = ?", boot),
    { n: 66, engine_n: 60, gps_n: 66 });
  assert.ok(near(one(env, "SELECT SUM(engine_s) AS s FROM minutes WHERE boot = ?", boot).s, 61));
});

test("a session of legacy firmware has build 0, no odometer gives NULL ends", async () => {
  const env = makeEnv();
  setNow(T0 + 100);
  await post(env, drive({ boot: 44, inst: 0, fw: 0, n: 10, odo0: null }));
  assert.deepEqual(one(env, "SELECT boot, fw, odo_start, odo_end, nolink_n FROM trips"),
    { boot: 44, fw: 0, odo_start: null, odo_end: null, nolink_n: 0 });
});

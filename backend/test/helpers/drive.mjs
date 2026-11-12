// Test data for the ingest path: made-up drives as record fields, a way to post them to the
// real handleIngest, a fixed clock, and an independent re-computation of a trip's numbers.
import { encodeRecord, F, joinRecords } from "../../scripts/lib/record-encode.mjs";
import { handleIngest } from "../../src/ingest";
import { rows } from "./d1.mjs";

// 2026-11-11 22:40:00 UTC, the start of a minute. Every test time hangs off this.
export const T0 = 1794436800;
// The public landmark used by the golden record in the change contract.
export const LAT_E7 = 378199000;
export const LON_E7 = -1224783000;

// The Worker's session id for a board's boot counter and install id.
export const sid = (boot, inst = 0) => boot + inst * 65536;

// handleIngest takes "now" from Date.now(). Tests pin it, so the future-clock rule and the
// estimated times do not depend on when the tests run.
const realNow = Date.now;
export function setNow(unixSeconds) {
  Date.now = () => unixSeconds * 1000;
}
export function restoreNow() {
  Date.now = realNow;
}

// `n` records of one session, `stepMs` apart, as field objects for encodeRecord().
//   base     unix time at ms 0 of the session. Records carry epoch = base + ms / 1000,
//   clock    unless clock is false (then epoch is 0, as before the modem has the time).
//   odo0     odometer at the first record in 0.1 km units, null for a car without PID A6.
// Every value sits on the record's own grid, so encode then decode gives it back exactly.
export function drive({
  boot = 12, inst = 173, fw = 2, n = 60, ms0 = 20000, stepMs = 1000, base = T0, clock = true,
  odo0 = 126711, gps = true, flags = F.ENGINE_ON,
} = {}) {
  const out = [];
  let lat = LAT_E7, lon = LON_E7, km = 0;
  for (let i = 0; i < n; i++) {
    const ms = ms0 + i * stepMs;
    const kph = i < 5 ? 0 : 40 + ((i * 7) % 61);
    km += (kph * stepMs) / 3600000;
    lat += kph * 13;
    lon += kph * 9;
    out.push({
      boot, inst, fw, ms, epoch: clock ? base + Math.floor(ms / 1000) : 0, flags,
      ...(gps ? { lat: lat / 1e7, lon: lon / 1e7, sats: 9 } : {}),
      rpm: kph === 0 ? 700 : 1200 + kph * 18,
      maf_gs: (450 + kph * 12 + (i % 5)) / 100,
      adapter_v: (14100 + (i % 7) * 10) / 1000,
      coolant_c: Math.min(950, 400 + i * 2) / 10,
      intake_c: (250 + (i % 4)) / 10,
      speed_kph: kph,
      throttle_pct: Math.round(kph / 2),
      fuel_raw: 160 - Math.floor(i / 100),
      csq: 20,
      ecu_v: 13.9,
      ...(odo0 == null ? {} : { odo_km: (odo0 + Math.floor(km * 10)) / 10 }),
    });
  }
  return out;
}

// One record written while the adapter link is down: time, GPS and cell signal only.
export function noLink({ boot = 12, inst = 173, fw = 3, ms, base = T0, clock = true, lat = LAT_E7 / 1e7, lon = LON_E7 / 1e7, flags = F.NO_LINK }) {
  return { boot, inst, fw, ms, epoch: clock ? base + Math.floor(ms / 1000) : 0, flags, lat, lon, sats: 7, csq: 17 };
}

export const encodeAll = (fields) => joinRecords(fields.map(encodeRecord));

// Posts to the real handler. `body` is a list of field objects or ready bytes.
export async function post(env, body, headers = {}) {
  const bytes = Array.isArray(body) ? encodeAll(body) : body;
  const req = new Request("https://logger.test/ingest", { method: "POST", body: bytes, headers });
  const res = await handleIngest(req, env);
  return { status: res.status, json: await res.json() };
}

// Posts `fields` in pieces of the given sizes (the last size repeats), one request each,
// moving the clock forward `everyS` seconds per request like the logger's upload timer.
export async function postChunks(env, fields, sizes, { now, everyS = 15 } = {}) {
  let i = 0, k = 0;
  while (i < fields.length) {
    const size = sizes[Math.min(k, sizes.length - 1)];
    if (now != null) setNow(now + k * everyS);
    const r = await post(env, fields.slice(i, i + size));
    if (r.status !== 200) throw new Error(`upload ${k} answered ${r.status} ${JSON.stringify(r.json)}`);
    i += size;
    k++;
  }
  return k;
}

// Everything an upload writes except the upload log and the `latest` row, in a fixed order.
export function snapshot(env) {
  return {
    samples: rows(env, "SELECT * FROM samples ORDER BY boot, ms"),
    trips: rows(env, "SELECT * FROM trips ORDER BY boot"),
    minutes: rows(env, "SELECT * FROM minutes ORDER BY boot, t"),
    track: rows(env, "SELECT * FROM track ORDER BY boot, ms"),
  };
}

// Collects the results of every batch() from now on, to count what an upload really wrote.
export function watchBatches(env) {
  const seen = [];
  const real = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements) => {
    const out = await real(statements);
    seen.push(out);
    return out;
  };
  return seen;
}

// A trip's numbers worked out from the fields alone, by the rules in the change contract and
// in rollup.ts, without calling any of that code. One session's fields, any order.
export function referenceTrip(fields) {
  const rs = [...fields].sort((a, b) => a.ms - b.ms);
  const t = {
    n: 0, gps_n: 0, engine_n: 0, nolink_n: 0, km: 0, maf_g: 0, engine_s: 0, moving_s: 0,
    max_kph: null, max_rpm: null, max_coolant: null, rpm_sum: 0, rpm_n: 0,
    odo_start: null, odo_end: null, fw: 0, last_ms: -1, track_ms: -1, track: [],
  };
  const up = (a, b) => (b == null ? a : a == null || b > a ? b : a);
  let prev = null;
  for (const r of rs) {
    const noLinkRec = (r.flags & 4) !== 0;
    const on = (r.flags & 1) !== 0 && !noLinkRec;
    const gap = prev == null ? 0 : r.ms - prev;
    if (gap >= 1 && gap <= 5000) {
      if (r.speed_kph != null) t.km += (r.speed_kph * gap) / 3600000;
      if (r.maf_gs != null) t.maf_g += (r.maf_gs * gap) / 1000;
      if (on) t.engine_s += gap / 1000;
      if (r.speed_kph > 0) t.moving_s += gap / 1000;
    }
    prev = r.ms;
    t.n++;
    if (on) t.engine_n++;
    if (noLinkRec) t.nolink_n++;
    if (r.lat != null && r.lon != null) {
      t.gps_n++;
      if (r.ms - t.track_ms >= 15000) {
        t.track.push({ ms: r.ms, mph: r.speed_kph == null ? null : Math.round(r.speed_kph * 0.621371) });
        t.track_ms = r.ms;
      }
    }
    t.max_kph = up(t.max_kph, r.speed_kph);
    t.max_rpm = up(t.max_rpm, r.rpm);
    t.max_coolant = up(t.max_coolant, r.coolant_c);
    if (r.rpm > 0) { t.rpm_sum += r.rpm; t.rpm_n++; }
    if (r.odo_km != null) {
      if (t.odo_start == null) t.odo_start = r.odo_km;
      t.odo_end = r.odo_km;
    }
    t.fw = Math.max(t.fw, r.fw ?? 0);
    t.last_ms = r.ms;
  }
  return t;
}

// Float comparison for sums that were added up in a different order.
export function near(a, b, rel = 1e-9) {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));
}

// Asserts two rows (or lists of rows) are equal, numbers within tolerance. `skip` names
// columns to leave out. Throws with the first difference.
export function assertRowsNear(actual, expected, { skip = [], label = "rows" } = {}) {
  const A = Array.isArray(actual) ? actual : [actual];
  const E = Array.isArray(expected) ? expected : [expected];
  if (A.length !== E.length) throw new Error(`${label}: ${A.length} rows, expected ${E.length}`);
  for (let i = 0; i < E.length; i++) {
    const keys = new Set([...Object.keys(A[i] ?? {}), ...Object.keys(E[i] ?? {})]);
    for (const k of keys) {
      if (skip.includes(k)) continue;
      const a = A[i]?.[k], e = E[i]?.[k];
      const same = typeof a === "number" && typeof e === "number" ? near(a, e) : a === e;
      if (!same) throw new Error(`${label}[${i}].${k}: ${a}, expected ${e}`);
    }
  }
}

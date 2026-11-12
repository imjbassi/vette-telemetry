// Incremental rollups: fold each upload into `trips`, `minutes` and `track` so readers never
// have to re-aggregate `samples`. Must match maintenance/rebuild-rollups.sql.
import { engineOn, F, type Sample } from "./record";

export const MAX_GAP_MS = 5000; // gaps longer than this (quiet mode, BLE drops) are not integrated
const TRACK_EVERY_MS = 15000;
const KM_TO_MI = 0.621371;

export interface TripRow {
  boot: number; start_ts: number | null; end_ts: number | null; last_ms: number; track_ms: number;
  n: number; gps_n: number; engine_n: number; km: number; maf_g: number; engine_s: number; moving_s: number;
  max_kph: number | null; max_rpm: number | null; max_coolant: number | null; rpm_sum: number; rpm_n: number; est: number;
  odo_start: number | null; odo_end: number | null; fw: number; nolink_n: number;
}

export const emptyTrip = (boot: number): TripRow => ({
  boot, start_ts: null, end_ts: null, last_ms: -1, track_ms: -1, n: 0, gps_n: 0, engine_n: 0, km: 0, maf_g: 0,
  engine_s: 0, moving_s: 0, max_kph: null, max_rpm: null, max_coolant: null, rpm_sum: 0, rpm_n: 0, est: 0,
  odo_start: null, odo_end: null, fw: 0, nolink_n: 0,
});

// Column kinds for the per-minute upsert: sums add, max/min keep the extreme.
const SUM = ["n", "engine_n", "gps_n", "km", "maf_g", "engine_s", "moving_s", "spd_sum", "spd_n", "rpm_sum", "rpm_n",
  "cool_sum", "cool_n", "cool_eng_sum", "cool_eng_n", "fuel_sum", "fuel_n", "volt_sum", "volt_n", "thr_sum", "thr_n",
  "iat_sum", "iat_n", "maf_sum", "maf_n"] as const;
const MAX = ["spd_max", "rpm_max", "cool_max", "fuel_max", "volt_max", "thr_max", "iat_max", "maf_max"] as const;
const MIN = ["fuel_min", "volt_min", "iat_min"] as const;
export const MINUTE_COLS = ["t", "boot", ...SUM, ...MAX, ...MIN] as const;
type MinuteRow = { t: number; boot: number } & Record<(typeof SUM)[number], number> &
  Record<(typeof MAX)[number] | (typeof MIN)[number], number | null>;

export const MINUTE_UPSERT_SQL =
  `INSERT INTO minutes (${MINUTE_COLS.join(", ")}) VALUES (${MINUTE_COLS.map(() => "?").join(", ")})
   ON CONFLICT(t, boot) DO UPDATE SET ` +
  [
    ...SUM.map((c) => `${c} = COALESCE(${c}, 0) + excluded.${c}`),
    ...MAX.map((c) => `${c} = CASE WHEN excluded.${c} IS NULL THEN ${c} WHEN ${c} IS NULL OR excluded.${c} > ${c} THEN excluded.${c} ELSE ${c} END`),
    ...MIN.map((c) => `${c} = CASE WHEN excluded.${c} IS NULL THEN ${c} WHEN ${c} IS NULL OR excluded.${c} < ${c} THEN excluded.${c} ELSE ${c} END`),
  ].join(", ");

// INSERT OR REPLACE with a fixed column list: a trips column left out here is reset to its
// default on every upload. Keep this list, tripParams and TripRow in step with schema.sql.
export const TRIP_UPSERT_SQL =
  `INSERT OR REPLACE INTO trips (boot, start_ts, end_ts, last_ms, track_ms, n, gps_n, engine_n, km, maf_g, engine_s,
     moving_s, max_kph, max_rpm, max_coolant, rpm_sum, rpm_n, est, odo_start, odo_end, fw, nolink_n)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
export const tripParams = (t: TripRow) => [t.boot, t.start_ts, t.end_ts, t.last_ms, t.track_ms, t.n, t.gps_n, t.engine_n,
  t.km, t.maf_g, t.engine_s, t.moving_s, t.max_kph, t.max_rpm, t.max_coolant, t.rpm_sum, t.rpm_n, t.est,
  t.odo_start, t.odo_end, t.fw, t.nolink_n];

const hi = (a: number | null, b: number | null) => (b == null ? a : a == null || b > a ? b : a);
const lo = (a: number | null, b: number | null) => (b == null ? a : a == null || b < a ? b : a);

export interface Stamped { s: Sample; ts: number; est: boolean }

// Fold one session's samples (any order, may overlap earlier uploads) into its trip row.
// Returns the updated trip plus the minute rows and track points to write. `changed` is false
// when every sample was a replay, so the caller can skip the trip write.
export function fold(trip: TripRow, items: Stamped[]) {
  const fresh = items.filter((x) => x.s.ms > trip.last_ms).sort((a, b) => a.s.ms - b.s.ms);
  const minutes = new Map<number, MinuteRow>();
  const track: [number, number, number, number, number, number | null][] = [];
  let prev = trip.last_ms >= 0 ? trip.last_ms : null;

  for (const { s, ts, est } of fresh) {
    // The same record twice in one upload must count once, like its single row in `samples`.
    if (s.ms === prev) continue;
    const t = Math.floor(ts / 60) * 60;
    let m = minutes.get(t);
    if (!m) {
      m = { t, boot: trip.boot } as MinuteRow;
      for (const c of SUM) m[c] = 0;
      for (const c of [...MAX, ...MIN]) m[c] = null;
      minutes.set(t, m);
    }
    const on = engineOn(s.flags);
    const dms = prev == null ? 0 : s.ms - prev;
    if (dms >= 1 && dms <= MAX_GAP_MS) {
      const km = s.speed_kph == null ? 0 : (s.speed_kph * dms) / 3600000;
      const g = s.maf_gs == null ? 0 : (s.maf_gs * dms) / 1000;
      const eng = on ? dms / 1000 : 0;
      const mov = s.speed_kph != null && s.speed_kph > 0 ? dms / 1000 : 0;
      trip.km += km; trip.maf_g += g; trip.engine_s += eng; trip.moving_s += mov;
      m.km += km; m.maf_g += g; m.engine_s += eng; m.moving_s += mov;
    }
    prev = s.ms;

    trip.n++; m.n++;
    if (on) { trip.engine_n++; m.engine_n++; }
    if (s.flags & F.NO_LINK) trip.nolink_n++;
    if (s.fw > trip.fw) trip.fw = s.fw;
    if (s.odo_km != null) {
      if (trip.odo_start == null) trip.odo_start = s.odo_km;
      trip.odo_end = s.odo_km;
    }
    if (s.lat != null && s.lon != null) {
      trip.gps_n++; m.gps_n++;
      if (s.ms - trip.track_ms >= TRACK_EVERY_MS) {
        track.push([trip.boot, s.ms, ts, s.lat, s.lon, s.speed_kph == null ? null : Math.round(s.speed_kph * KM_TO_MI)]);
        trip.track_ms = s.ms;
      }
    }
    trip.start_ts = trip.start_ts == null ? ts : Math.min(trip.start_ts, ts);
    trip.end_ts = trip.end_ts == null ? ts : Math.max(trip.end_ts, ts);
    if (est) trip.est = 1;
    trip.max_kph = hi(trip.max_kph, s.speed_kph);
    trip.max_rpm = hi(trip.max_rpm, s.rpm);
    trip.max_coolant = hi(trip.max_coolant, s.coolant_c);
    if (s.rpm != null && s.rpm > 0) { trip.rpm_sum += s.rpm; trip.rpm_n++; m.rpm_sum += s.rpm; m.rpm_n++; }

    if (s.speed_kph != null) { m.spd_sum += s.speed_kph; m.spd_n++; }
    m.spd_max = hi(m.spd_max, s.speed_kph);
    m.rpm_max = hi(m.rpm_max, s.rpm);
    if (s.coolant_c != null) {
      m.cool_sum += s.coolant_c; m.cool_n++;
      if (on) { m.cool_eng_sum += s.coolant_c; m.cool_eng_n++; }
    }
    m.cool_max = hi(m.cool_max, s.coolant_c);
    if (s.fuel_pct != null) { m.fuel_sum += s.fuel_pct; m.fuel_n++; }
    m.fuel_max = hi(m.fuel_max, s.fuel_pct); m.fuel_min = lo(m.fuel_min, s.fuel_pct);
    if (s.adapter_v != null) { m.volt_sum += s.adapter_v; m.volt_n++; }
    m.volt_max = hi(m.volt_max, s.adapter_v); m.volt_min = lo(m.volt_min, s.adapter_v);
    if (s.throttle_pct != null) { m.thr_sum += s.throttle_pct; m.thr_n++; }
    m.thr_max = hi(m.thr_max, s.throttle_pct);
    if (s.intake_c != null) { m.iat_sum += s.intake_c; m.iat_n++; }
    m.iat_max = hi(m.iat_max, s.intake_c); m.iat_min = lo(m.iat_min, s.intake_c);
    if (s.maf_gs != null) { m.maf_sum += s.maf_gs; m.maf_n++; }
    m.maf_max = hi(m.maf_max, s.maf_gs);
  }
  if (fresh.length) trip.last_ms = fresh[fresh.length - 1].s.ms;
  return {
    trip,
    changed: fresh.length > 0,
    minuteParams: [...minutes.values()].map((m) => MINUTE_COLS.map((c) => (m as Record<string, number | null>)[c])),
    track,
  };
}

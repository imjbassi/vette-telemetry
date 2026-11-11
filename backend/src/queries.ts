import { Env, getLatest } from "./ingest";

const AFR = 14.7;
const G_PER_GAL = 2798.7;
const TANK_GAL = 18.5; // C8 Stingray
const EPA_COMBINED_MPG = 19; // 2024 Stingray coupe, fallback when no history
const KM_TO_MI = 0.621371;
const MAX_GAP_MS = 5000; // gaps longer than this (quiet mode, BLE drops) are not integrated

const r1 = (x: number | null | undefined) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x: number | null | undefined) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const cToF = (c: number | null | undefined) => (c == null ? null : r1(c * 1.8 + 32));

export function fmtTime(env: Env, ts: number | null | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: env.LOCAL_TZ || "UTC", weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(d);
  return `${local} (${d.toISOString()})`;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${r1(s / 3600)} h ago`;
  return `${r1(s / 86400)} days ago`;
}

function mapsLink(lat: number, lon: number) {
  return `https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

// ------------------------------------------------------------ status / location

export async function latestStatus(env: Env) {
  const L = await getLatest(env);
  if (!Object.keys(L).length) return { error: "No data received yet." };
  const val = (k: string) => L[k]?.v ?? null;
  const when = (k: string) => (L[k] ? { at: fmtTime(env, L[k].ts), age: ago(L[k].ts) } : null);
  const fuelPct = val("fuel_pct");
  const econ = await fuelEconomy(env, 30);
  const mpg = "combined_mpg" in econ && econ.combined_mpg ? econ.combined_mpg : null;
  const gal = fuelPct == null ? null : (fuelPct / 100) * TANK_GAL;
  return {
    engine_running_at_last_report: val("engine_on") === 1,
    last_upload: when("last_upload"),
    fuel: fuelPct == null ? null : {
      level_pct: fuelPct,
      est_gallons_left: r1(gal),
      est_range_mi: Math.round((gal ?? 0) * (mpg ?? EPA_COMBINED_MPG)),
      range_basis_mpg: mpg ?? `${EPA_COMBINED_MPG} (EPA combined, no logged history yet)`,
      as_of: when("fuel_pct"),
    },
    battery_v: val("adapter_v"),
    battery_as_of: when("adapter_v"),
    ecu_v: val("ecu_v"),
    coolant_f: cToF(val("coolant_c")),
    intake_air_f: cToF(val("intake_c")),
    last_speed_mph: val("speed_kph") == null ? null : Math.round(val("speed_kph")! * KM_TO_MI),
    last_rpm: val("rpm"),
    engine_values_as_of: when("rpm"),
    odometer_mi: val("odo_km") == null ? "not supported by this ECU (PID A6)" : Math.round(val("odo_km")! * KM_TO_MI),
    location: val("lat") == null ? null : {
      lat: val("lat"), lon: val("lon"), map: mapsLink(val("lat")!, val("lon")!), as_of: when("lat"),
    },
    cell_signal_csq: val("csq"),
    note: "Values are the last reported before the car (and logger) powered off if the car is parked.",
  };
}

export async function location(env: Env) {
  const L = await getLatest(env);
  if (L.lat == null) return { error: "No GPS fix has been reported yet." };
  return {
    lat: L.lat.v, lon: L.lon.v, satellites: L.sats?.v ?? null,
    map: mapsLink(L.lat.v, L.lon.v),
    as_of: fmtTime(env, L.lat.ts), age: ago(L.lat.ts),
    parked: L.engine_on?.v !== 1 || Date.now() / 1000 - (L.engine_on?.ts ?? 0) > 120,
  };
}

// ------------------------------------------------------------ trips

export interface TripAgg {
  boot: number; start_ts: number; end_ts: number; km: number | null; maf_g: number | null;
  engine_s: number | null; moving_s: number | null; max_kph: number | null; max_rpm: number | null;
  max_coolant: number | null; avg_rpm: number | null; est: number;
}

// Raw numbers for one trip. The MCP tools format these as text, the dashboard as charts.
export interface TripNums {
  id: number; start_ts: number; end_ts: number; duration_s: number; engine_s: number; moving_s: number;
  miles: number; gallons: number; mpg: number | null; avg_mph: number | null; max_mph: number | null;
  max_rpm: number | null; avg_rpm: number | null; max_coolant_f: number | null; est: boolean;
}

export function tripNumbers(t: TripAgg): TripNums {
  const miles = (t.km ?? 0) * KM_TO_MI;
  const gallons = (t.maf_g ?? 0) / (AFR * G_PER_GAL);
  return {
    id: t.boot,
    start_ts: t.start_ts,
    end_ts: t.end_ts,
    duration_s: t.end_ts - t.start_ts,
    engine_s: t.engine_s ?? 0,
    moving_s: t.moving_s ?? 0,
    miles: r2(miles) ?? 0,
    gallons: r2(gallons) ?? 0,
    mpg: gallons > 0.01 && miles > 0.1 ? r1(miles / gallons) : null,
    avg_mph: t.moving_s ? r1(miles / (t.moving_s / 3600)) : null,
    max_mph: t.max_kph == null ? null : Math.round(t.max_kph * KM_TO_MI),
    max_rpm: t.max_rpm,
    avg_rpm: t.avg_rpm == null ? null : Math.round(t.avg_rpm),
    max_coolant_f: cToF(t.max_coolant),
    est: t.est === 1,
  };
}

export async function recentTripAggs(env: Env, limit: number): Promise<TripAgg[]> {
  // Cheap pass to find recent boots, then aggregate just those.
  const boots = await env.DB.prepare(
    `SELECT boot FROM samples GROUP BY boot HAVING SUM(flags & 1) > 0 ORDER BY MAX(ts) DESC LIMIT ?`,
  ).bind(limit).all<{ boot: number }>();
  const ids = boots.results.map((b) => b.boot);
  if (!ids.length) return [];
  const rows = await env.DB.prepare(TRIP_AGG_SQL(`boot IN (${ids.map(() => "?").join(",")})`))
    .bind(...ids).all<TripAgg>();
  return rows.results.sort((a, b) => b.start_ts - a.start_ts);
}

export async function tripAggsSince(env: Env, since: number): Promise<TripAgg[]> {
  const rows = await env.DB.prepare(TRIP_AGG_SQL("ts >= ?")).bind(since).all<TripAgg>();
  return rows.results.sort((a, b) => b.start_ts - a.start_ts);
}

// Aggregates clipped to [from, to]: distance, fuel and time only count samples inside it.
export async function tripAggsBetween(env: Env, from: number, to: number): Promise<TripAgg[]> {
  const rows = await env.DB.prepare(TRIP_AGG_SQL("ts BETWEEN ? AND ?")).bind(from, to).all<TripAgg>();
  return rows.results.sort((a, b) => b.start_ts - a.start_ts);
}

// Whole trips (not clipped) that have any sample in [from, to].
export async function tripAggsTouching(env: Env, from: number, to: number): Promise<TripAgg[]> {
  const boots = await env.DB.prepare(`SELECT DISTINCT boot FROM samples WHERE ts BETWEEN ? AND ?`)
    .bind(from, to).all<{ boot: number }>();
  const ids = boots.results.map((b) => b.boot);
  if (!ids.length) return [];
  const rows = await env.DB.prepare(TRIP_AGG_SQL(`boot IN (${ids.map(() => "?").join(",")})`))
    .bind(...ids).all<TripAgg>();
  return rows.results.sort((a, b) => b.start_ts - a.start_ts);
}

export async function tripAgg(env: Env, boot: number): Promise<TripAgg | null> {
  return env.DB.prepare(TRIP_AGG_SQL("boot = ?")).bind(boot).first<TripAgg>();
}

export const CAR = { TANK_GAL, EPA: { city: 16, highway: 24, combined: EPA_COMBINED_MPG }, KM_TO_MI };

const TRIP_AGG_SQL = (where: string) => `
  WITH s AS (
    SELECT boot, ms, ts, ts_est, speed_kph, maf_gs, rpm, coolant_c, flags,
           ms - LAG(ms) OVER (PARTITION BY boot ORDER BY ms) AS dms
    FROM samples WHERE ${where}
  )
  SELECT boot, MIN(ts) AS start_ts, MAX(ts) AS end_ts,
    SUM(CASE WHEN dms BETWEEN 1 AND ${MAX_GAP_MS} THEN speed_kph * dms / 3600000.0 END) AS km,
    SUM(CASE WHEN dms BETWEEN 1 AND ${MAX_GAP_MS} THEN maf_gs * dms / 1000.0 END) AS maf_g,
    SUM(CASE WHEN dms BETWEEN 1 AND ${MAX_GAP_MS} AND (flags & 1) THEN dms END) / 1000.0 AS engine_s,
    SUM(CASE WHEN dms BETWEEN 1 AND ${MAX_GAP_MS} AND speed_kph > 0 THEN dms END) / 1000.0 AS moving_s,
    MAX(speed_kph) AS max_kph, MAX(rpm) AS max_rpm, MAX(coolant_c) AS max_coolant,
    AVG(CASE WHEN rpm > 0 THEN rpm END) AS avg_rpm, MAX(ts_est) AS est
  FROM s GROUP BY boot HAVING SUM(flags & 1) > 0`;

function shapeTrip(env: Env, t: TripAgg) {
  const n = tripNumbers(t);
  return {
    trip_id: n.id,
    start: fmtTime(env, n.start_ts),
    end: fmtTime(env, n.end_ts),
    duration_min: r1(n.duration_s / 60),
    engine_on_min: r1(n.engine_s / 60),
    moving_min: r1(n.moving_s / 60),
    distance_mi: n.miles,
    fuel_used_gal: n.gallons,
    mpg: n.mpg,
    avg_moving_speed_mph: n.avg_mph,
    max_speed_mph: n.max_mph,
    max_rpm: n.max_rpm,
    avg_rpm: n.avg_rpm,
    max_coolant_f: n.max_coolant_f,
    times_estimated: n.est,
  };
}

export async function listTrips(env: Env, limit: number) {
  const trips = (await recentTripAggs(env, limit)).map((t) => shapeTrip(env, t));
  return { trips };
}

async function edge(env: Env, boot: number, col: string, dir: "ASC" | "DESC") {
  return env.DB.prepare(`SELECT ${col}, ts FROM samples WHERE boot = ? AND ${col.split(",")[0]} IS NOT NULL ORDER BY ms ${dir} LIMIT 1`)
    .bind(boot).first<Record<string, number>>();
}

export async function tripSummary(env: Env, tripId?: number) {
  let boot = tripId;
  if (boot == null) {
    const last = await env.DB.prepare(
      `SELECT boot FROM samples GROUP BY boot HAVING SUM(flags & 1) > 0 ORDER BY MAX(ts) DESC LIMIT 1`,
    ).first<{ boot: number }>();
    if (!last) return { error: "No trips recorded yet." };
    boot = last.boot;
  }
  const agg = await tripAgg(env, boot);
  if (!agg) return { error: `Trip ${boot} not found.` };
  const [f0, f1, p0, p1, o0, o1] = await Promise.all([
    edge(env, boot, "fuel_pct", "ASC"), edge(env, boot, "fuel_pct", "DESC"),
    edge(env, boot, "lat,lon", "ASC"), edge(env, boot, "lat,lon", "DESC"),
    edge(env, boot, "odo_km", "ASC"), edge(env, boot, "odo_km", "DESC"),
  ]);
  const t = shapeTrip(env, agg);
  return {
    ...t,
    fuel_level_pct: { start: f0?.fuel_pct ?? null, end: f1?.fuel_pct ?? null },
    fuel_used_by_tank_gauge_gal: f0 && f1 && f0.fuel_pct >= f1.fuel_pct ? r2(((f0.fuel_pct - f1.fuel_pct) / 100) * TANK_GAL) : null,
    odometer_mi: o0 && o1 ? { start: Math.round(o0.odo_km * KM_TO_MI), end: Math.round(o1.odo_km * KM_TO_MI) } : null,
    start_location: p0 ? { lat: p0.lat, lon: p0.lon, map: mapsLink(p0.lat, p0.lon) } : null,
    end_location: p1 ? { lat: p1.lat, lon: p1.lon, map: mapsLink(p1.lat, p1.lon) } : null,
    note: "Fuel used is integrated from MAF assuming stoichiometric gasoline. The tank gauge figure is a coarse cross-check.",
  };
}

// ------------------------------------------------------------ fuel economy

export async function fuelEconomy(env: Env, days: number) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const trips = (await tripAggsSince(env, since)).map((t) => shapeTrip(env, t));
  const miles = trips.reduce((a, t) => a + (t.distance_mi ?? 0), 0);
  const gal = trips.reduce((a, t) => a + (t.fuel_used_gal ?? 0), 0);
  return {
    window_days: days,
    trip_count: trips.length,
    total_miles: r1(miles),
    total_gallons: r2(gal),
    combined_mpg: gal > 0.05 ? r1(miles / gal) : null,
    epa_reference_mpg: { city: 16, highway: 24, combined: EPA_COMBINED_MPG },
    best_trip_mpg: trips.reduce<number | null>((m, t) => (t.mpg != null && (m == null || t.mpg > m) ? t.mpg : m), null),
    worst_trip_mpg: trips.reduce<number | null>((m, t) => (t.mpg != null && (m == null || t.mpg < m) ? t.mpg : m), null),
    trips: trips.slice(0, 20).map((t) => ({ trip_id: t.trip_id, start: t.start, distance_mi: t.distance_mi, mpg: t.mpg })),
  };
}

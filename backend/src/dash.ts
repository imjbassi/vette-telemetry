// Dashboard: one HTML page plus a small JSON API, all under /dash/<DASH_SECRET>/.
import page from "./dash.html";
import { Env, getLatest } from "./ingest";
import { CAR, recentTripAggs, tripAgg, tripAggsBetween, tripAggsSince, tripAggsTouching, tripNumbers } from "./queries";

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });

const MAX_POINTS = 600; // per chart series
const MAX_TRACK = 1500; // map polyline points

async function status(env: Env) {
  const latest = await getLatest(env);
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const month = (await tripAggsSince(env, since)).map(tripNumbers);
  const miles = month.reduce((a, t) => a + t.miles, 0);
  const gallons = month.reduce((a, t) => a + t.gallons, 0);
  return {
    now: Math.floor(Date.now() / 1000),
    latest,
    car: { tank_gal: CAR.TANK_GAL, epa: CAR.EPA },
    mpg30: gallons > 0.05 ? Math.round((miles / gallons) * 10) / 10 : null,
  };
}

async function trips(env: Env, limit: number) {
  return { trips: (await recentTripAggs(env, limit)).map(tripNumbers) };
}

interface Row {
  ms: number; ts: number; lat: number | null; lon: number | null; speed_kph: number | null; rpm: number | null;
  coolant_c: number | null; fuel_pct: number | null; throttle_pct: number | null; adapter_v: number | null;
}

async function trip(env: Env, id: number) {
  const agg = await tripAgg(env, id);
  if (!agg) return null;
  const rows = (await env.DB.prepare(
    `SELECT ms, ts, lat, lon, speed_kph, rpm, coolant_c, fuel_pct, throttle_pct, adapter_v
     FROM samples WHERE boot = ? ORDER BY ms`,
  ).bind(id).all<Row>()).results;

  const step = Math.max(1, Math.ceil(rows.length / MAX_POINTS));
  const pick = rows.filter((_, i) => i % step === 0);
  const round = (x: number | null, k = 1) => (x == null ? null : Math.round(x * k) / k);
  const series = {
    t: pick.map((r) => r.ts + (r.ms % 1000) / 1000),
    mph: pick.map((r) => (r.speed_kph == null ? null : Math.round(r.speed_kph * CAR.KM_TO_MI))),
    rpm: pick.map((r) => r.rpm),
    coolant_f: pick.map((r) => (r.coolant_c == null ? null : round(r.coolant_c * 1.8 + 32))),
    throttle: pick.map((r) => r.throttle_pct),
    fuel: pick.map((r) => r.fuel_pct),
    volts: pick.map((r) => round(r.adapter_v, 10)),
  };

  const geo = rows.filter((r) => r.lat != null && r.lon != null);
  const gstep = Math.max(1, Math.ceil(geo.length / MAX_TRACK));
  const track = geo.filter((_, i) => i % gstep === 0 || i === geo.length - 1)
    .map((r) => [round(r.lat, 1e5), round(r.lon, 1e5), r.speed_kph == null ? null : Math.round(r.speed_kph * CAR.KM_TO_MI)]);

  return { trip: tripNumbers(agg), series, track };
}

// Last few minutes of the most recent boot, for the live view.
async function live(env: Env, minutes: number) {
  // Most recent session by time, not by number: two boards each count sessions from 1.
  const head = await env.DB.prepare(
    `SELECT boot, MAX(ms) AS ms FROM samples WHERE boot = (SELECT boot FROM samples ORDER BY ts DESC LIMIT 1)`,
  ).first<{ boot: number | null; ms: number | null }>();
  if (!head || head.boot == null) return { boot: null, rows: [], latest: await getLatest(env), now: Math.floor(Date.now() / 1000) };
  const rows = (await env.DB.prepare(
    `SELECT ms, ts, speed_kph, rpm, throttle_pct, coolant_c, intake_c, maf_gs, adapter_v, ecu_v, fuel_pct, sats, csq, flags
     FROM samples WHERE boot = ? AND ms >= ? ORDER BY ms`,
  ).bind(head.boot, (head.ms ?? 0) - minutes * 60000).all<Record<string, number | null>>()).results;
  const step = Math.max(1, Math.ceil(rows.length / MAX_POINTS));
  const pick = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  const mph = (k: number | null) => (k == null ? null : Math.round(k * CAR.KM_TO_MI));
  return {
    now: Math.floor(Date.now() / 1000),
    boot: head.boot,
    latest: await getLatest(env),
    series: {
      t: pick.map((r) => (r.ts as number) + ((r.ms as number) % 1000) / 1000),
      mph: pick.map((r) => mph(r.speed_kph)),
      rpm: pick.map((r) => r.rpm),
      throttle: pick.map((r) => r.throttle_pct),
      coolant_f: pick.map((r) => (r.coolant_c == null ? null : Math.round(r.coolant_c * 1.8 + 32))),
      maf: pick.map((r) => r.maf_gs),
      volts: pick.map((r) => r.adapter_v),
    },
  };
}

// Raw material for the logging view: upload history, newest samples, per-boot summary.
async function logs(env: Env, limit: number) {
  const now = Math.floor(Date.now() / 1000);
  const [ingests, samples, boots, hour, day] = await Promise.all([
    env.DB.prepare(`SELECT received_at, bytes, records, rejected FROM ingests ORDER BY received_at DESC LIMIT 100`).all(),
    env.DB.prepare(
      `SELECT boot, ms, ts, ts_est, lat, lon, sats, rpm, speed_kph, coolant_c, intake_c, maf_gs, throttle_pct, fuel_pct,
              adapter_v, ecu_v, odo_km, csq, flags
       FROM samples ORDER BY boot DESC, ms DESC LIMIT ?`,
    ).bind(limit).all(),
    env.DB.prepare(
      `SELECT boot, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts, SUM(lat IS NOT NULL) AS gps,
              SUM(flags & 1) AS engine, SUM(ts_est) AS est
       FROM samples GROUP BY boot ORDER BY boot DESC LIMIT 30`,
    ).all(),
    env.DB.prepare(`SELECT COUNT(*) AS uploads, COALESCE(SUM(records),0) AS records, COALESCE(SUM(bytes),0) AS bytes,
                           COALESCE(SUM(rejected),0) AS rejected FROM ingests WHERE received_at >= ?`).bind(now - 3600).first(),
    env.DB.prepare(`SELECT COUNT(*) AS uploads, COALESCE(SUM(records),0) AS records, COALESCE(SUM(bytes),0) AS bytes,
                           COALESCE(SUM(rejected),0) AS rejected FROM ingests WHERE received_at >= ?`).bind(now - 86400).first(),
  ]);
  return {
    now,
    latest: await getLatest(env),
    stats: { hour, day },
    ingests: ingests.results,
    samples: samples.results,
    boots: boots.results,
  };
}

// Everything about an arbitrary time window: totals, bucketed metric series, trips, routes.
const BUCKETS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
const MAX_BUCKETS = 400;

async function history(env: Env, from: number, to: number) {
  const span = Math.max(1, to - from);
  const bucket = BUCKETS.find((b) => span / b <= MAX_BUCKETS) ?? 86400;

  const [series, extremes, clipped, touching, geo] = await Promise.all([
    // D1 binds JS numbers as REAL, so a bound divisor would not truncate. `bucket` always comes
    // from the BUCKETS list above, so it is safe to inline as an integer literal.
    env.DB.prepare(
      `SELECT (ts / ${bucket | 0}) * ${bucket | 0} AS t,
              AVG(speed_kph) AS spd, MAX(speed_kph) AS spd_max,
              AVG(CASE WHEN rpm > 0 THEN rpm END) AS rpm, MAX(rpm) AS rpm_max,
              AVG(coolant_c) AS cool, MAX(coolant_c) AS cool_max,
              AVG(fuel_pct) AS fuel, AVG(adapter_v) AS volt, MIN(adapter_v) AS volt_min,
              AVG(throttle_pct) AS thr, MAX(throttle_pct) AS thr_max,
              AVG(intake_c) AS iat, AVG(maf_gs) AS maf, MAX(maf_gs) AS maf_max,
              COUNT(*) AS n
       FROM samples WHERE ts BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`,
    ).bind(from, to).all<Record<string, number | null>>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(speed_kph) AS spd_max, MAX(rpm) AS rpm_max, MAX(coolant_c) AS cool_max,
              AVG(CASE WHEN flags & 1 THEN coolant_c END) AS cool_avg, MIN(fuel_pct) AS fuel_min, MAX(fuel_pct) AS fuel_max,
              MIN(adapter_v) AS volt_min, MAX(adapter_v) AS volt_max, MAX(throttle_pct) AS thr_max,
              MIN(intake_c) AS iat_min, MAX(intake_c) AS iat_max, SUM(lat IS NOT NULL) AS gps
       FROM samples WHERE ts BETWEEN ? AND ?`,
    ).bind(from, to).first<Record<string, number | null>>(),
    tripAggsBetween(env, from, to),
    tripAggsTouching(env, from, to),
    env.DB.prepare(
      `SELECT boot, lat, lon, speed_kph FROM samples
       WHERE ts BETWEEN ? AND ? AND lat IS NOT NULL ORDER BY boot, ms`,
    ).bind(from, to).all<{ boot: number; lat: number; lon: number; speed_kph: number | null }>(),
  ]);

  // Clipped totals for exactly this window.
  const parts = clipped.map(tripNumbers);
  const sum = (k: "miles" | "gallons" | "engine_s" | "moving_s") => parts.reduce((a, t) => a + t[k], 0);
  const miles = sum("miles"), gallons = sum("gallons");

  const mph = (k: number | null) => (k == null ? null : Math.round(k * CAR.KM_TO_MI * 10) / 10);
  const fF = (c: number | null) => (c == null ? null : Math.round((c * 1.8 + 32) * 10) / 10);
  const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  const rows = series.results;

  // Routes, one polyline per session, thinned to keep the payload small.
  const step = Math.max(1, Math.ceil(geo.results.length / 2500));
  const routes: Record<number, [number, number, number | null][]> = {};
  geo.results.forEach((r, i) => {
    if (i % step && i !== geo.results.length - 1) return;
    (routes[r.boot] ??= []).push([Math.round(r.lat * 1e5) / 1e5, Math.round(r.lon * 1e5) / 1e5, mph(r.speed_kph)]);
  });

  const e = extremes ?? {};
  return {
    from, to, bucket,
    totals: {
      samples: e.n ?? 0,
      miles: Math.round(miles * 10) / 10,
      gallons: Math.round(gallons * 100) / 100,
      mpg: gallons > 0.05 ? Math.round((miles / gallons) * 10) / 10 : null,
      engine_s: Math.round(sum("engine_s")),
      moving_s: Math.round(sum("moving_s")),
      idle_s: Math.max(0, Math.round(sum("engine_s") - sum("moving_s"))),
      max_mph: e.spd_max == null ? null : Math.round(e.spd_max * CAR.KM_TO_MI),
      max_rpm: e.rpm_max ?? null,
      max_coolant_f: fF(e.cool_max ?? null),
      avg_coolant_f: fF(e.cool_avg ?? null),
      fuel_min: e.fuel_min ?? null, fuel_max: e.fuel_max ?? null,
      volt_min: r1(e.volt_min ?? null), volt_max: r1(e.volt_max ?? null),
      max_throttle: e.thr_max ?? null,
      iat_min_f: fF(e.iat_min ?? null), iat_max_f: fF(e.iat_max ?? null),
      gps_points: e.gps ?? 0,
    },
    series: {
      t: rows.map((r) => r.t),
      speed: rows.map((r) => mph(r.spd)), speed_max: rows.map((r) => mph(r.spd_max)),
      rpm: rows.map((r) => (r.rpm == null ? null : Math.round(r.rpm))), rpm_max: rows.map((r) => r.rpm_max),
      coolant: rows.map((r) => fF(r.cool)), coolant_max: rows.map((r) => fF(r.cool_max)),
      fuel: rows.map((r) => r1(r.fuel)),
      battery: rows.map((r) => (r.volt == null ? null : Math.round(r.volt * 100) / 100)),
      throttle: rows.map((r) => r1(r.thr)), throttle_max: rows.map((r) => r.thr_max),
      intake: rows.map((r) => fF(r.iat)),
      airflow: rows.map((r) => (r.maf == null ? null : Math.round(r.maf * 100) / 100)), airflow_max: rows.map((r) => r.maf_max),
    },
    trips: touching.map(tripNumbers),
    routes,
  };
}

// Every column of one trip as CSV, times in ISO UTC.
async function tripCsv(env: Env, id: number) {
  const rows = (await env.DB.prepare(
    `SELECT ts, ms, ts_est, lat, lon, sats, rpm, speed_kph, throttle_pct, maf_gs, coolant_c, intake_c, fuel_pct,
            adapter_v, ecu_v, odo_km, csq, flags FROM samples WHERE boot = ? ORDER BY ms`,
  ).bind(id).all<Record<string, number | null>>()).results;
  if (!rows.length) return null;
  const cols = ["time_utc", ...Object.keys(rows[0])];
  const lines = [cols.join(",")];
  for (const r of rows) {
    const t = new Date(((r.ts as number) + ((r.ms as number) % 1000) / 1000) * 1000).toISOString();
    lines.push([t, ...Object.values(r).map((v) => (v == null ? "" : String(v)))].join(","));
  }
  return lines.join("\n") + "\n";
}

async function economy(env: Env, days: number) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const list = (await tripAggsSince(env, since)).map(tripNumbers);
  const miles = list.reduce((a, t) => a + t.miles, 0);
  const gallons = list.reduce((a, t) => a + t.gallons, 0);
  return {
    days,
    miles: Math.round(miles * 10) / 10,
    gallons: Math.round(gallons * 100) / 100,
    mpg: gallons > 0.05 ? Math.round((miles / gallons) * 10) / 10 : null,
    epa: CAR.EPA,
    trips: list.map((t) => ({ id: t.id, start_ts: t.start_ts, miles: t.miles, mpg: t.mpg })),
  };
}

// `rest` is the path after /dash/<secret>, e.g. "", "/", "/api/status".
export async function handleDash(req: Request, env: Env, rest: string, base: string): Promise<Response> {
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  if (rest === "") return Response.redirect(new URL(base + "/", req.url).toString(), 301);
  if (rest === "/") {
    return new Response(page, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // Tile and CDN requests then carry only the origin, never the secret path.
        "Referrer-Policy": "strict-origin",
        "X-Robots-Tag": "noindex",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const url = new URL(req.url);
  const num = (name: string, def: number, max: number) =>
    Math.min(Math.max(parseInt(url.searchParams.get(name) ?? "", 10) || def, 1), max);

  if (rest === "/api/status") return json(await status(env));
  if (rest === "/api/trips") return json(await trips(env, num("limit", 25, 100)));
  if (rest === "/api/economy") return json(await economy(env, num("days", 30, 365)));
  if (rest === "/api/live") return json(await live(env, num("minutes", 10, 60)));
  if (rest === "/api/history") {
    const nowS = Math.floor(Date.now() / 1000);
    let to = parseInt(url.searchParams.get("to") ?? "", 10);
    let from = parseInt(url.searchParams.get("from") ?? "", 10);
    if (!Number.isFinite(to)) to = nowS;
    if (!Number.isFinite(from)) from = to - 86400;
    if (from > to) [from, to] = [to, from];
    if (to - from > 366 * 86400) from = to - 366 * 86400;
    return json(await history(env, from, to));
  }
  if (rest === "/api/logs") return json(await logs(env, num("limit", 150, 500)));
  const csv = rest.match(/^\/api\/trip\/(\d+)\.csv$/);
  if (csv) {
    const body = await tripCsv(env, parseInt(csv[1], 10));
    if (!body) return json({ error: "not found" }, 404);
    return new Response(body, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="corvette-trip-${csv[1]}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  const m = rest.match(/^\/api\/trip\/(\d+)$/);
  if (m) {
    const data = await trip(env, parseInt(m[1], 10));
    return data ? json(data) : json({ error: "not found" }, 404);
  }
  return new Response("not found", { status: 404 });
}

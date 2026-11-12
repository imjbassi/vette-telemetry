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

// `coarse`: per-minute series from the rollup (a few dozen rows) for overview charts that
// refresh. The full-resolution path reads every sample of the trip, so only on demand.
async function trip(env: Env, id: number, coarse = false) {
  const agg = await tripAgg(env, id);
  if (!agg) return null;
  if (coarse) {
    const rows = (await env.DB.prepare(
      `SELECT t, spd_sum / NULLIF(spd_n, 0) AS spd, rpm_sum / NULLIF(rpm_n, 0) AS rpm, cool_sum / NULLIF(cool_n, 0) AS cool,
              thr_sum / NULLIF(thr_n, 0) AS thr FROM minutes WHERE t BETWEEN ? AND ? AND boot = ? ORDER BY t`,
    ).bind(Math.floor(agg.start_ts / 60) * 60, agg.end_ts, id).all<Record<string, number | null>>()).results;
    return {
      trip: tripNumbers(agg),
      series: {
        t: rows.map((r) => (r.t as number) + 30),
        mph: rows.map((r) => (r.spd == null ? null : Math.round(r.spd * CAR.KM_TO_MI))),
        rpm: rows.map((r) => (r.rpm == null ? null : Math.round(r.rpm))),
        coolant_f: rows.map((r) => (r.cool == null ? null : Math.round(r.cool * 1.8 + 32))),
        throttle: rows.map((r) => (r.thr == null ? null : Math.round(r.thr))),
      },
      track: [],
      coarse: true,
    };
  }
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

// Last few minutes of the most recent session, for the live view. With `since` (the newest ms
// the page already has for that session) only newer rows are read, so polling stays cheap.
async function live(env: Env, minutes: number, sinceBoot: number | null, sinceMs: number | null) {
  // Most recent session by time, not by number: two boards each count sessions from 1.
  const head = await env.DB.prepare(`SELECT boot, last_ms AS ms FROM trips ORDER BY end_ts DESC LIMIT 1`)
    .first<{ boot: number | null; ms: number | null }>();
  if (!head || head.boot == null) return { boot: null, rows: [], latest: await getLatest(env), now: Math.floor(Date.now() / 1000) };
  const incremental = sinceBoot === head.boot && sinceMs != null && sinceMs >= (head.ms ?? 0) - minutes * 60000;
  const rows = (await env.DB.prepare(
    `SELECT ms, ts, speed_kph, rpm, throttle_pct, coolant_c, intake_c, maf_gs, adapter_v, ecu_v, fuel_pct, sats, csq, flags
     FROM samples WHERE boot = ? AND ms > ? ORDER BY ms`,
  ).bind(head.boot, incremental ? sinceMs : (head.ms ?? 0) - minutes * 60000 - 1).all<Record<string, number | null>>()).results;
  const pick = rows;
  const mph = (k: number | null) => (k == null ? null : Math.round(k * CAR.KM_TO_MI));
  return {
    now: Math.floor(Date.now() / 1000),
    boot: head.boot,
    incremental,
    last_ms: rows.length ? rows[rows.length - 1].ms : sinceMs,
    window_s: minutes * 60,
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
  // Every query here is bounded by an index and a LIMIT, so each poll reads a few hundred rows.
  const [ingests, samples, boots, hour] = await Promise.all([
    env.DB.prepare(`SELECT received_at, bytes, records, rejected FROM ingests ORDER BY received_at DESC LIMIT 100`).all(),
    env.DB.prepare(
      `SELECT boot, ms, ts, ts_est, lat, lon, sats, rpm, speed_kph, coolant_c, intake_c, maf_gs, throttle_pct, fuel_pct,
              adapter_v, ecu_v, odo_km, csq, flags
       FROM samples ORDER BY ts DESC LIMIT ?`,
    ).bind(limit).all(),
    env.DB.prepare(
      `SELECT boot, n, start_ts AS first_ts, end_ts AS last_ts, gps_n AS gps, engine_n AS engine, est
       FROM trips ORDER BY end_ts DESC LIMIT 30`,
    ).all(),
    env.DB.prepare(`SELECT COUNT(*) AS uploads, COALESCE(SUM(records),0) AS records, COALESCE(SUM(bytes),0) AS bytes,
                           COALESCE(SUM(rejected),0) AS rejected FROM ingests WHERE received_at >= ?`).bind(now - 3600).first(),
  ]);
  return {
    now,
    latest: await getLatest(env),
    stats: { hour },
    ingests: ingests.results,
    samples: samples.results,
    boots: boots.results,
  };
}

// Everything about an arbitrary time window: totals, bucketed metric series, trips, routes.
const BUCKETS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
const MAX_BUCKETS = 400;

// Windows up to an hour read raw samples (at most ~3600 rows). Longer ones read the per-minute
// rollup and the 15 s route table, so a month costs thousands of rows instead of millions.
const RAW_MAX_SPAN = 3600;
const MAX_ROUTE_POINTS = 15000;

async function history(env: Env, from: number, to: number) {
  const span = Math.max(1, to - from);
  const raw = span <= RAW_MAX_SPAN;
  const bucket = BUCKETS.filter((b) => raw || b >= 60).find((b) => span / b <= MAX_BUCKETS) ?? 86400;
  // D1 binds JS numbers as REAL, so a bound divisor would not truncate. `bucket` always comes
  // from the BUCKETS list above, so it is safe to inline as an integer literal.
  const B = bucket | 0;
  const m0 = Math.floor(from / 60) * 60;

  const seriesSql = raw
    ? `SELECT (ts / ${B}) * ${B} AS t,
              AVG(speed_kph) AS spd, MAX(speed_kph) AS spd_max,
              AVG(CASE WHEN rpm > 0 THEN rpm END) AS rpm, MAX(rpm) AS rpm_max,
              AVG(coolant_c) AS cool, MAX(coolant_c) AS cool_max,
              AVG(fuel_pct) AS fuel, AVG(adapter_v) AS volt,
              AVG(throttle_pct) AS thr, MAX(throttle_pct) AS thr_max,
              AVG(intake_c) AS iat, AVG(maf_gs) AS maf, MAX(maf_gs) AS maf_max
       FROM samples WHERE ts BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`
    : `SELECT (t / ${B}) * ${B} AS t,
              SUM(spd_sum) / NULLIF(SUM(spd_n), 0) AS spd, MAX(spd_max) AS spd_max,
              SUM(rpm_sum) / NULLIF(SUM(rpm_n), 0) AS rpm, MAX(rpm_max) AS rpm_max,
              SUM(cool_sum) / NULLIF(SUM(cool_n), 0) AS cool, MAX(cool_max) AS cool_max,
              SUM(fuel_sum) / NULLIF(SUM(fuel_n), 0) AS fuel, SUM(volt_sum) / NULLIF(SUM(volt_n), 0) AS volt,
              SUM(thr_sum) / NULLIF(SUM(thr_n), 0) AS thr, MAX(thr_max) AS thr_max,
              SUM(iat_sum) / NULLIF(SUM(iat_n), 0) AS iat,
              SUM(maf_sum) / NULLIF(SUM(maf_n), 0) AS maf, MAX(maf_max) AS maf_max
       FROM minutes WHERE t BETWEEN ? AND ? GROUP BY 1 ORDER BY 1`;
  const extremesSql = raw
    ? `SELECT COUNT(*) AS n, MAX(speed_kph) AS spd_max, MAX(rpm) AS rpm_max, MAX(coolant_c) AS cool_max,
              AVG(CASE WHEN flags & 1 THEN coolant_c END) AS cool_avg, MIN(fuel_pct) AS fuel_min, MAX(fuel_pct) AS fuel_max,
              MIN(adapter_v) AS volt_min, MAX(adapter_v) AS volt_max, MAX(throttle_pct) AS thr_max,
              MIN(intake_c) AS iat_min, MAX(intake_c) AS iat_max, SUM(lat IS NOT NULL) AS gps
       FROM samples WHERE ts BETWEEN ? AND ?`
    : `SELECT SUM(n) AS n, MAX(spd_max) AS spd_max, MAX(rpm_max) AS rpm_max, MAX(cool_max) AS cool_max,
              SUM(cool_eng_sum) / NULLIF(SUM(cool_eng_n), 0) AS cool_avg, MIN(fuel_min) AS fuel_min, MAX(fuel_max) AS fuel_max,
              MIN(volt_min) AS volt_min, MAX(volt_max) AS volt_max, MAX(thr_max) AS thr_max,
              MIN(iat_min) AS iat_min, MAX(iat_max) AS iat_max, SUM(gps_n) AS gps
       FROM minutes WHERE t BETWEEN ? AND ?`;
  const geoSql = raw
    ? `SELECT boot, ms, lat, lon, speed_kph * 0.621371 AS mph FROM samples
       WHERE ts BETWEEN ? AND ? AND lat IS NOT NULL ORDER BY boot, ms`
    : `SELECT boot, ms, lat, lon, mph FROM track WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT ${MAX_ROUTE_POINTS}`;
  const lo = raw ? from : m0;

  const [series, extremes, clipped, touching, geo] = await Promise.all([
    env.DB.prepare(seriesSql).bind(lo, to).all<Record<string, number | null>>(),
    env.DB.prepare(extremesSql).bind(lo, to).first<Record<string, number | null>>(),
    tripAggsBetween(env, from, to),
    tripAggsTouching(env, from, to),
    env.DB.prepare(geoSql).bind(from, to).all<{ boot: number; ms: number; lat: number; lon: number; mph: number | null }>(),
  ]);
  if (!raw) geo.results.sort((a, b) => a.boot - b.boot || a.ms - b.ms);

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
    (routes[r.boot] ??= []).push([Math.round(r.lat * 1e5) / 1e5, Math.round(r.lon * 1e5) / 1e5, r.mph == null ? null : Math.round(r.mph)]);
  });

  const e = extremes ?? {};
  return {
    from, to, bucket, source: raw ? "raw" : "minutes",
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
  if (rest === "/api/live") {
    const sb = url.searchParams.get("boot"), sm = url.searchParams.get("since");
    return json(await live(env, num("minutes", 10, 60), sb == null ? null : +sb, sm == null ? null : +sm));
  }
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
    const data = await trip(env, parseInt(m[1], 10), url.searchParams.get("res") === "minute");
    return data ? json(data) : json({ error: "not found" }, 404);
  }
  return new Response("not found", { status: 404 });
}

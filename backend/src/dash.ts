// Dashboard: one HTML page plus a small JSON API, all under /dash/<DASH_SECRET>/.
import page from "./dash.html";
import { Env, getLatest } from "./ingest";
import { CAR, recentTripAggs, tripAgg, tripAggsSince, tripNumbers } from "./queries";

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

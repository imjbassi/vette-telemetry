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
  const m = rest.match(/^\/api\/trip\/(\d+)$/);
  if (m) {
    const data = await trip(env, parseInt(m[1], 10));
    return data ? json(data) : json({ error: "not found" }, 404);
  }
  return new Response("not found", { status: 404 });
}

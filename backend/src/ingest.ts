import { decode, Sample } from "./record";

export interface Env {
  DB: D1Database;
  DEVICE_TOKEN: string;
  MCP_SECRET: string;
  LOCAL_TZ: string;
}

// Fields tracked in the `latest` row: last known value and when it was seen.
const LATEST_FIELDS = [
  "rpm", "speed_kph", "coolant_c", "intake_c", "maf_gs", "throttle_pct", "fuel_pct",
  "adapter_v", "ecu_v", "odo_km", "csq",
] as const;
// Ordered by (boot, ms), which is monotonic on the device even before its clock is known.
export type LatestEntry = { v: number; ts: number; boot: number; ms: number; est?: boolean };
export type Latest = Record<string, LatestEntry>;
const newer = (a: LatestEntry, b?: LatestEntry) => !b || a.boot > b.boot || (a.boot === b.boot && a.ms >= b.ms);

export async function handleIngest(req: Request, env: Env): Promise<Response> {
  const buf = await req.arrayBuffer();
  const now = Math.floor(Date.now() / 1000);
  const { samples, rejected } = decode(buf);

  // Resolve timestamps. Each boot has a fixed epoch base (unix time at millis 0).
  const boots = [...new Set(samples.map((s) => s.boot))];
  const known = new Map<number, number>();
  if (boots.length) {
    const rows = await env.DB.prepare(
      `SELECT boot, epoch_base FROM boots WHERE boot IN (${boots.map(() => "?").join(",")})`,
    ).bind(...boots).all<{ boot: number; epoch_base: number | null }>();
    for (const r of rows.results) if (r.epoch_base) known.set(r.boot, r.epoch_base);
  }
  const learned = new Map<number, number>();
  for (const s of samples) {
    if (s.epoch && !known.has(s.boot) && !learned.has(s.boot)) learned.set(s.boot, s.epoch - Math.floor(s.ms / 1000));
  }
  // Fallback for boots with no clock yet: assume the newest sample in this batch was just recorded.
  const maxMs = new Map<number, number>();
  for (const s of samples) maxMs.set(s.boot, Math.max(maxMs.get(s.boot) ?? 0, s.ms));

  const tsOf = (s: Sample): { ts: number; est: boolean } => {
    if (s.epoch) return { ts: s.epoch, est: false };
    const base = known.get(s.boot) ?? learned.get(s.boot);
    if (base) return { ts: base + Math.floor(s.ms / 1000), est: false };
    return { ts: now - Math.round(((maxMs.get(s.boot) ?? s.ms) - s.ms) / 1000), est: true };
  };

  const stmts: D1PreparedStatement[] = [];
  const ins = env.DB.prepare(
    `INSERT OR REPLACE INTO samples (boot, ms, ts, ts_est, lat, lon, sats, rpm, speed_kph, coolant_c, intake_c,
       maf_gs, throttle_pct, fuel_pct, adapter_v, ecu_v, odo_km, csq, flags)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const latestPatch: Latest = {};
  const put = (k: string, e: LatestEntry) => { if (newer(e, latestPatch[k])) latestPatch[k] = e; };
  for (const s of samples) {
    const { ts, est } = tsOf(s);
    stmts.push(ins.bind(s.boot, s.ms, ts, est ? 1 : 0, s.lat, s.lon, s.sats, s.rpm, s.speed_kph, s.coolant_c,
      s.intake_c, s.maf_gs, s.throttle_pct, s.fuel_pct, s.adapter_v, s.ecu_v, s.odo_km, s.csq, s.flags));
    const at = { ts, boot: s.boot, ms: s.ms, ...(est ? { est } : {}) };
    for (const f of LATEST_FIELDS) {
      const v = s[f];
      if (v !== null) put(f, { v, ...at });
    }
    if (s.lat !== null && s.lon !== null) {
      put("lat", { v: s.lat, ...at });
      put("lon", { v: s.lon, ...at });
      if (s.sats !== null) put("sats", { v: s.sats, ...at });
    }
    put("engine_on", { v: s.flags & 1 ? 1 : 0, ...at });
  }
  for (const [boot, base] of learned) {
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO boots (boot, epoch_base) VALUES (?, ?)`).bind(boot, base));
    // Earlier uploads from this boot were stored with estimated times. Fix them.
    stmts.push(env.DB.prepare(`UPDATE samples SET ts = ? + ms / 1000, ts_est = 0 WHERE boot = ? AND ts_est = 1`).bind(base, boot));
  }
  stmts.push(env.DB.prepare(`INSERT INTO ingests (received_at, bytes, records, rejected) VALUES (?,?,?,?)`)
    .bind(now, buf.byteLength, samples.length, rejected));

  // D1 batches run as a single transaction.
  for (let i = 0; i < stmts.length; i += 400) await env.DB.batch(stmts.slice(i, i + 400));
  await mergeLatest(env, latestPatch, learned, now);

  return Response.json({ ok: true, records: samples.length, rejected });
}

async function mergeLatest(env: Env, patch: Latest, learned: Map<number, number>, now: number) {
  const row = await env.DB.prepare(`SELECT json FROM latest WHERE id = 1`).first<{ json: string }>();
  const cur: Latest = row ? JSON.parse(row.json) : {};
  for (const [k, v] of Object.entries(patch)) if (k !== "last_upload" && newer(v, cur[k])) cur[k] = v;
  // Correct estimated times once the boot's clock is learned.
  for (const e of Object.values(cur)) {
    const base = learned.get(e.boot);
    if (e.est && base) { e.ts = base + Math.floor(e.ms / 1000); delete e.est; }
  }
  cur.last_upload = { v: now, ts: now, boot: 0, ms: 0 };
  await env.DB.prepare(`INSERT OR REPLACE INTO latest (id, json) VALUES (1, ?)`).bind(JSON.stringify(cur)).run();
}

export async function getLatest(env: Env): Promise<Latest> {
  const row = await env.DB.prepare(`SELECT json FROM latest WHERE id = 1`).first<{ json: string }>();
  return row ? JSON.parse(row.json) : {};
}

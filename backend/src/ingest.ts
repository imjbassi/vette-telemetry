import { decode, engineOn, F, Sample } from "./record";
import { emptyTrip, fold, MINUTE_UPSERT_SQL, Stamped, TRIP_UPSERT_SQL, tripParams, TripRow } from "./rollup";

export interface Env {
  DB: D1Database;
  DEVICE_TOKEN: string;
  MCP_SECRET: string;
  DASH_SECRET: string;
  LOCAL_TZ: string;
}

// The logger never sends more than 341 records (16,368 bytes) in one request.
export const MAX_BODY_BYTES = 65536;
// D1 allows 100 bound values per statement.
const MAX_IN_LIST = 90;

// Fields tracked in the `latest` row: last known value and when it was seen.
const LATEST_FIELDS = [
  "rpm", "speed_kph", "coolant_c", "intake_c", "maf_gs", "throttle_pct", "fuel_pct",
  "adapter_v", "ecu_v", "odo_km", "csq",
] as const;
export type LatestEntry = { v: number; ts: number; boot: number; ms: number; est?: boolean };
export type Latest = Record<string, LatestEntry>;
// Inside one session ms is monotonic even before the clock is known. Across sessions only
// time can order records, because boot numbers of two boards are unrelated.
const newer = (a: LatestEntry, b?: LatestEntry) => !b || (a.boot === b.boot ? a.ms >= b.ms : a.ts >= b.ts);

// The engine counts as on for this long after the last RPM above zero of the same session.
const ENGINE_BRIDGE_MS = 5000;

// The row is a cache of the newest values. A damaged one must not block uploads.
// Entries that are not whole (a hand edit that left null, a bare number or a missing field)
// are dropped: the merge reads boot, ms and ts of every entry, and newer() could never
// replace one without them.
const isEntry = (e: unknown): e is LatestEntry =>
  !!e && typeof e === "object" && (["v", "ts", "boot", "ms"] as const).every((k) => Number.isFinite((e as LatestEntry)[k]));

function parseLatest(json: string | undefined): Latest {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, e]) => isEntry(e)));
  } catch {
    return {};
  }
}

async function readByBoot<T>(env: Env, table: string, cols: string, boots: number[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < boots.length; i += MAX_IN_LIST) {
    const part = boots.slice(i, i + MAX_IN_LIST);
    const rows = await env.DB.prepare(`SELECT ${cols} FROM ${table} WHERE boot IN (${part.map(() => "?").join(",")})`)
      .bind(...part).all<T>();
    out.push(...rows.results);
  }
  return out;
}

// Any answer in the 2xx range makes the logger delete what it sent. So nothing here may
// answer 2xx unless the whole upload is committed, and a failure must throw (index.ts turns
// that into a 503) instead of being swallowed.
export async function handleIngest(req: Request, env: Env): Promise<Response> {
  const tooLarge = () => Response.json({ ok: false, error: "too large" }, { status: 413 });
  if (Number(req.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return tooLarge();
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) return tooLarge();

  const now = Math.floor(Date.now() / 1000);
  const { samples, rejected, unknownVersion } = decode(buf);
  // Intact records in a layout this Worker does not know. Refuse before touching the database
  // so the logger keeps them until a Worker that can read them is deployed.
  if (unknownVersion > 0) {
    console.warn(`ingest: ${unknownVersion} records with an unknown version, upload refused`);
    return Response.json({ ok: false, error: "unknown record version", unknown: unknownVersion }, { status: 422 });
  }

  for (const s of samples) {
    // Firmware before the 2026-11-11 GPS and clock fix parsed the SIM7670G's decimal degrees as NMEA ddmm.mmmm, which
    // squeezes every location into |lat| < 1.5, |lon| < 3: open ocean in the Gulf of Guinea.
    // Undo it: stored = d + (raw - 100 d) / 60 with d = floor(raw / 100).
    // Only firmware without a build byte can have the bug, so newer builds are never touched.
    if (s.fw === 0 && s.lat != null && s.lon != null && Math.abs(s.lat) < 1.5 && Math.abs(s.lon) < 3 && (s.lat !== 0 || s.lon !== 0)) {
      const a = Math.abs(s.lon);
      s.lat = s.lat * 60;
      s.lon = Math.sign(s.lon) * (a >= 1 ? 100 + (a - 1) * 60 : a * 60);
    }
  }

  // Everything is read first, then written in one batch. D1 runs a batch as one transaction,
  // so an upload is either stored completely (samples, rollups, latest) or not at all.
  // An empty or fully rejected upload must not count as "the car just reported in", so the
  // `latest` row is only read and written when there are samples.
  const boots = [...new Set(samples.map((s) => s.boot))];
  const [baseRows, latest, tripRows] = await Promise.all([
    readByBoot<{ boot: number; epoch_base: number | null }>(env, "boots", "boot, epoch_base", boots),
    samples.length ? getLatest(env) : Promise.resolve<Latest>({}),
    readByBoot<TripRow>(env, "trips", "*", boots),
  ]);
  const trips = new Map(tripRows.map((r) => [r.boot, r]));

  // The latest time a record can have. Normally that is the upload time. A session whose
  // stored times are still estimates gives a tighter limit: its stored end plus what the
  // logger's own counter says has passed since. Without it, the last records of such a
  // session, arriving hours later with the next drive, would be dated at that upload.
  // Copied out of the trip rows here because fold() changes them further down.
  const anchors = new Map<number, { end: number; ms: number }>();
  for (const t of tripRows) if (t.est && t.end_ts != null) anchors.set(t.boot, { end: t.end_ts, ms: t.last_ms });
  const bound = (s: Sample) => {
    const a = anchors.get(s.boot);
    return a ? Math.min(now, a.end + Math.ceil((s.ms - a.ms) / 1000)) : now;
  };
  // A device clock past that limit is wrong (firmware before the 2026-11-11 GPS and clock fix added the zone offset to
  // the modem's UTC clock). Treat it as unknown so the time is estimated instead. This holds
  // for resent records too: taken as the session clock, it would move every stored time of
  // the session by the same error and mark them exact.
  for (const s of samples) if (s.epoch > bound(s) + 300) s.epoch = 0;

  // Resolve timestamps. Each boot has a fixed epoch base (unix time at millis 0).
  const known = new Map<number, number>();
  for (const r of baseRows) if (r.epoch_base) known.set(r.boot, r.epoch_base);
  const learned = new Map<number, number>();
  for (const s of samples) {
    if (s.epoch && !known.has(s.boot) && !learned.has(s.boot)) learned.set(s.boot, s.epoch - Math.floor(s.ms / 1000));
  }
  // Fallback for boots with no clock yet: assume the newest sample in this batch was just
  // recorded, but never date a sample past the limit above.
  const maxMs = new Map<number, number>();
  for (const s of samples) maxMs.set(s.boot, Math.max(maxMs.get(s.boot) ?? 0, s.ms));

  const tsOf = (s: Sample): { ts: number; est: boolean } => {
    if (s.epoch) return { ts: s.epoch, est: false };
    const base = known.get(s.boot) ?? learned.get(s.boot);
    if (base) return { ts: base + Math.floor(s.ms / 1000), est: false };
    return { ts: Math.min(now - Math.round(((maxMs.get(s.boot) ?? s.ms) - s.ms) / 1000), bound(s)), est: true };
  };

  const stmts: D1PreparedStatement[] = [];
  // A replayed record leaves its row alone. Rewriting it would spend a row write per record on
  // every resend, and the rollups already skip replays.
  const ins = env.DB.prepare(
    `INSERT INTO samples (boot, ms, ts, ts_est, lat, lon, sats, rpm, speed_kph, coolant_c, intake_c,
       maf_gs, throttle_pct, fuel_pct, adapter_v, ecu_v, odo_km, csq, flags)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(boot, ms) DO NOTHING`,
  );
  const latestPatch: Latest = {};
  // Inside one session the higher ms wins. Between sessions the later record in the body
  // wins: the logger sends its segments oldest first, and the estimated time of a session
  // without a clock says nothing about which one is newer.
  const put = (k: string, e: LatestEntry) => {
    const cur = latestPatch[k];
    if (!cur || cur.boot !== e.boot || e.ms >= cur.ms) latestPatch[k] = e;
  };
  const byBoot = new Map<number, Stamped[]>();
  for (const s of samples) {
    const { ts, est } = tsOf(s);
    if (!byBoot.has(s.boot)) byBoot.set(s.boot, []);
    byBoot.get(s.boot)!.push({ s, ts, est });
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
    // Written for every record, so their ts is the time of the newest record for all readers.
    // The firmware sets the engine bit only on a record that holds an RPM above zero. One
    // missed RPM reply must not show a driving car as parked, so the last RPM above zero of
    // the same session still counts for a few seconds. A quiet or no-link record is off at once.
    const lastRpm = latestPatch.rpm ?? latest.rpm;
    const bridged = !(s.flags & (F.QUIET | F.NO_LINK)) && !!lastRpm && lastRpm.boot === s.boot && lastRpm.v > 0 &&
      s.ms >= lastRpm.ms && s.ms - lastRpm.ms <= ENGINE_BRIDGE_MS;
    put("engine_on", { v: engineOn(s.flags) || bridged ? 1 : 0, ...at });
    put("link", { v: s.flags & F.NO_LINK ? 0 : 1, ...at });
    put("fw", { v: s.fw, ...at });
  }

  // Fold this upload into the rollups.
  const upMinute = env.DB.prepare(MINUTE_UPSERT_SQL);
  const upTrip = env.DB.prepare(TRIP_UPSERT_SQL);
  const insTrack = env.DB.prepare(`INSERT OR REPLACE INTO track (boot, ms, ts, lat, lon, mph) VALUES (?,?,?,?,?,?)`);
  // The trip rows were read before the batch. If another copy of this upload committed in
  // between (the logger resent after a stall), folding again would double the minutes, which
  // add up, and write a stale trip row. This statement fails in that case: it then inserts a
  // NULL into a NOT NULL column. The batch rolls back, the logger gets a 503 and its resend
  // takes the normal replay path. A body made only of replays needs the guard too: it still
  // writes `latest` from the copy read before the batch, and would roll it back.
  const unmoved = env.DB.prepare(
    `INSERT INTO ingests (received_at, bytes, records, rejected)
     SELECT NULL, 0, 0, 0 WHERE COALESCE((SELECT last_ms FROM trips WHERE boot = ?), -1) <> ?`,
  );
  for (const [boot, items] of byBoot) {
    const trip = trips.get(boot) ?? emptyTrip(boot);
    const readMs = trip.last_ms; // fold() moves it
    const r = fold(trip, items);
    stmts.push(unmoved.bind(boot, readMs));
    if (r.changed) stmts.push(upTrip.bind(...tripParams(r.trip)));
    for (const p of r.minuteParams) stmts.push(upMinute.bind(...p));
    for (const p of r.track) stmts.push(insTrack.bind(...p));
  }
  for (const [boot, base] of learned) {
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO boots (boot, epoch_base) VALUES (?, ?)`).bind(boot, base));
    // Earlier uploads from this boot were stored with estimated times. Fix them, and the
    // trip's start/end and route times with them. Minute buckets keep their estimated slot,
    // which is off by at most one upload interval.
    stmts.push(env.DB.prepare(`UPDATE samples SET ts = ? + ms / 1000, ts_est = 0 WHERE boot = ? AND ts_est = 1`).bind(base, boot));
    stmts.push(env.DB.prepare(`UPDATE track SET ts = ? + ms / 1000 WHERE boot = ?`).bind(base, boot));
    stmts.push(env.DB.prepare(
      `UPDATE trips SET start_ts = (SELECT MIN(ts) FROM samples WHERE boot = ?1),
                        end_ts = (SELECT MAX(ts) FROM samples WHERE boot = ?1), est = 0 WHERE boot = ?1`,
    ).bind(boot));
  }

  if (samples.length) {
    // Correct estimated times once the boot's clock is learned, before comparing by time.
    for (const e of Object.values(latest)) {
      const base = learned.get(e.boot);
      if (e.est && base) { e.ts = base + Math.floor(e.ms / 1000); delete e.est; }
    }
    for (const [k, v] of Object.entries(latestPatch)) if (newer(v, latest[k])) latest[k] = v;
    latest.last_upload = { v: now, ts: now, boot: 0, ms: 0 };
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO latest (id, json) VALUES (1, ?)`).bind(JSON.stringify(latest)));
  }

  stmts.push(env.DB.prepare(`INSERT INTO ingests (received_at, bytes, records, rejected) VALUES (?,?,?,?)`)
    .bind(now, buf.byteLength, samples.length, rejected));
  stmts.push(env.DB.prepare(`DELETE FROM ingests WHERE received_at < ?`).bind(now - 30 * 86400));

  // One batch, never sliced: a slice that fails after an earlier one committed would leave
  // samples without their rollups, and fold() skips those samples on the retry.
  await env.DB.batch(stmts);

  return Response.json({ ok: true, records: samples.length, rejected });
}

export async function getLatest(env: Env): Promise<Latest> {
  const row = await env.DB.prepare(`SELECT json FROM latest WHERE id = 1`).first<{ json: string }>();
  return parseLatest(row?.json);
}

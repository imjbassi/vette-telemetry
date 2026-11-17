import { Env, getLatest, Latest, LatestEntry } from "./ingest";
import { F } from "./record";

// Pump gasoline is E10, which burns about 14.1 parts air per part fuel. 14.7 is pure gasoline.
const AFR = 14.1;
const G_PER_GAL = 2798.7;
const TANK_GAL = 18.5; // C8 Stingray
const EPA = { city: 16, highway: 24, combined: 19 }; // 2024 Stingray coupe. Combined is the fallback when history is thin.
const KM_TO_MI = 0.621371;
export const MPG30_MIN_MILES = 25; // logged miles needed before the 30-day MPG replaces the EPA figure
const RANKED_TRIP_MIN_MILES = 2; // shorter trips are too noisy to be a best or worst MPG
const UNLOGGED_MIN_KM = 0.3; // the odometer steps in 0.1 km, so smaller gaps are rounding
const CHARGING_V = 13.0;
const LOW_V = 11.8;

export const CAR = { TANK_GAL, EPA, KM_TO_MI, AFR, G_PER_GAL };

const r1 = (x: number | null | undefined) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x: number | null | undefined) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const cToF = (c: number | null | undefined) => (c == null ? null : r1(c * 1.8 + 32));
const nowS = () => Math.floor(Date.now() / 1000);
const gallonsOf = (mafG: number | null | undefined) => (mafG ?? 0) / (AFR * G_PER_GAL);

// An answer that tells the model its arguments were wrong. mcp.ts sends it as an error text.
export const badInput = (error: string) => ({ error, bad_input: true as const });
export type BadInput = ReturnType<typeof badInput>;

// Models sometimes send numbers as strings. Anything else unusable falls back to the default.
export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Math.min(Math.max(Number.isFinite(n) ? Math.floor(n) : def, min), max);
}

function wholeNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// Session id as shown to people. Legacy firmware: the plain boot counter. Newer firmware:
// install id, a dash, then the counter (for example 173-12). The dashboard shows the same.
export const tripLabel = (boot: number) => (boot < 65536 ? String(boot) : `${Math.floor(boot / 65536)}-${boot % 65536}`);

// A trip id in either form: the full number, or the label. Null for anything else.
export function parseTripId(v: unknown): number | null {
  const n = wholeNumber(v);
  if (n != null) return n;
  const m = typeof v === "string" ? /^(\d{1,3})-(\d{1,5})$/.exec(v.trim()) : null;
  if (!m) return null;
  // Only what a real label can hold, so a mistyped one cannot land on some other trip.
  const inst = Number(m[1]), counter = Number(m[2]);
  return inst >= 1 && inst <= 255 && counter <= 65535 ? inst * 65536 + counter : null;
}

// ------------------------------------------------------------ local time

// An unknown zone name makes Intl throw. Fall back to UTC so one bad setting cannot break every reader.
const zones = new Map<string, string>();
export function zoneOf(env: Pick<Env, "LOCAL_TZ">): string {
  const want = env.LOCAL_TZ || "UTC";
  let z = zones.get(want);
  if (!z) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: want });
      z = want;
    } catch {
      z = "UTC";
    }
    zones.set(want, z);
  }
  return z;
}

// Building an Intl.DateTimeFormat is slow, so there is one per zone and it is reused.
const longFmt = new Map<string, Intl.DateTimeFormat>();
export function fmtTime(env: Pick<Env, "LOCAL_TZ">, ts: number | null | undefined): string | null {
  if (!ts) return null;
  const tz = zoneOf(env);
  let f = longFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    });
    longFmt.set(tz, f);
  }
  const d = new Date(ts * 1000);
  return `${f.format(d)} (${d.toISOString()})`;
}

// The zone's wall clock at `ts`, read as if it were UTC. Unix seconds.
const partsFmt = new Map<string, Intl.DateTimeFormat>();
function wallClock(tz: string, ts: number): number {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partsFmt.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ts * 1000))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000;
}

// Seconds to add to UTC to get local time at `ts`.
export const tzOffset = (tz: string, ts: number) => wallClock(tz, ts) - ts;

// Calendar dates are handled as day numbers (days since 1970-01-01), so the next day is +1.
export const localDay = (tz: string, ts: number) => Math.floor(wallClock(tz, ts) / 86400);
export const dateOfDay = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10);

// "YYYY-MM-DD" to a day number. Null for anything else, including dates that do not exist.
export function parseDay(v: unknown): number | null {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim()) : null;
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return ms / 86400000;
}

// Unix time at which local day `day` starts in `tz`.
export function dayStart(tz: string, day: number): number {
  const wall = day * 86400;
  const a = wall - tzOffset(tz, wall);
  const b = wall - tzOffset(tz, a);
  // a and b differ only when a clock change lies between them, and then b is the right one.
  // If the clocks jump over midnight neither fits, and the day starts at the later of the two.
  return tzOffset(tz, b) === wall - b ? b : Math.max(a, b);
}

export interface OffsetSpan { from: number; to: number; offset: number }

// Cuts [from, to) wherever the zone's UTC offset changes (daylight saving). Inside one span the
// offset is constant, so SQL can turn a timestamp into a local day with plain integer arithmetic.
export function offsetSpans(tz: string, from: number, to: number): OffsetSpan[] {
  const out: OffsetSpan[] = [];
  let start = from, off = tzOffset(tz, from);
  for (let at = from; at < to;) {
    // Clock changes are months apart, so a one-day step holds at most one.
    const next = Math.min(at + 86400, to);
    const o = tzOffset(tz, next);
    if (o !== off) {
      let lo = at, hi = next; // the old offset holds at lo, the new one at hi
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (tzOffset(tz, mid) === off) lo = mid; else hi = mid;
      }
      if (hi >= to) break; // the change is exactly at the open end of the window
      out.push({ from: start, to: hi, offset: off });
      start = hi;
      off = o;
    }
    at = next;
  }
  out.push({ from: start, to, offset: off });
  return out;
}

// SQL for the local day number of the integer column `col`. D1 binds JS numbers as REAL, and a
// REAL offset or divisor would make this a float division, so every number is inlined as a
// checked integer literal instead of bound.
export function dayExpr(col: string, spans: OffsetSpan[]): string {
  const lit = (n: number) => {
    if (!Number.isSafeInteger(n)) throw new Error(`not an integer: ${n}`);
    return String(n);
  };
  const one = (offset: number) => `(${col} + ${lit(offset)}) / 86400`;
  const last = spans[spans.length - 1];
  if (spans.length === 1) return one(last.offset);
  return "CASE " + spans.slice(0, -1).map((s) => `WHEN ${col} < ${lit(s.to)} THEN ${one(s.offset)} `).join("") +
    `ELSE ${one(last.offset)} END`;
}

export const HISTORY_PERIODS = ["today", "yesterday", "last_7_days", "last_30_days", "this_month", "last_month", "this_year"] as const;
export type HistoryPeriod = (typeof HISTORY_PERIODS)[number];
export const MAX_HISTORY_DAYS = 366;

// Whole local days from_day..to_day (both included), and the same window as unix time [start, end).
export interface DayWindow { from_day: number; to_day: number; start: number; end: number }

export function resolveWindow(
  tz: string, now: number, a: { period?: unknown; from?: unknown; to?: unknown },
): DayWindow | BadInput {
  const today = localDay(tz, now);
  let from: number, to: number;
  if (a.from != null || a.to != null) {
    if (a.period != null) return badInput("Give either period, or from and to, not both.");
    if (a.from == null) return badInput("to needs a from date as well. Dates look like 2026-11-05.");
    const f = parseDay(a.from);
    if (f == null) return badInput(`from is not a calendar date: ${JSON.stringify(a.from)}. Use YYYY-MM-DD, for example 2026-11-05.`);
    const t = a.to == null ? today : parseDay(a.to);
    if (t == null) return badInput(`to is not a calendar date: ${JSON.stringify(a.to)}. Use YYYY-MM-DD, for example 2026-11-05.`);
    if (f > t) {
      return badInput(a.to == null
        ? `from (${dateOfDay(f)}) is in the future. Today is ${dateOfDay(today)} in ${tz}.`
        : `from (${dateOfDay(f)}) is after to (${dateOfDay(t)}).`);
    }
    from = f;
    to = t;
  } else {
    const period = a.period ?? "last_7_days";
    const d = new Date(today * 86400000);
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    const first = (yy: number, mm: number) => Date.UTC(yy, mm, 1) / 86400000;
    to = today;
    switch (period) {
      case "today": from = today; break;
      case "yesterday": from = to = today - 1; break;
      case "last_7_days": from = today - 6; break;
      case "last_30_days": from = today - 29; break;
      case "this_month": from = first(y, m); break;
      case "last_month": from = first(y, m - 1); to = first(y, m) - 1; break;
      case "this_year": from = first(y, 0); break;
      default:
        return badInput(`Unknown period ${JSON.stringify(period)}. Use one of: ${HISTORY_PERIODS.join(", ")}. Or give from and to dates.`);
    }
  }
  const days = to - from + 1;
  if (days > MAX_HISTORY_DAYS) {
    return badInput(`That window is ${days} days. The limit is ${MAX_HISTORY_DAYS}. Ask for a shorter range, or make several calls and add them up.`);
  }
  return { from_day: from, to_day: to, start: dayStart(tz, from), end: dayStart(tz, to + 1) };
}

// ------------------------------------------------------------ car state

// One rule for "is it running" shared by the Claude tools and the dashboard.
export const STATE_RULES = { running_s: 90, lost_s: 600 } as const;

export interface CarState {
  state: "running" | "no_signal" | "parked" | "unknown";
  last_seen_ts: number | null; // ts of the newest record (latest.engine_on.ts)
  age_s: number | null;
  ended_mid_drive: boolean; // last record had the engine on and is older than lost_s
  link_down: boolean; // latest.link.v === 0 and age_s < lost_s
}

export function carState(latest: Latest, now: number): CarState {
  const e = latest.engine_on;
  if (!e) return { state: "unknown", last_seen_ts: null, age_s: null, ended_mid_drive: false, link_down: false };
  // A device clock slightly ahead of ours must not give a negative age.
  const age = Math.max(0, now - e.ts);
  const on = e.v === 1;
  const lost = age > STATE_RULES.lost_s;
  return {
    state: !on || lost ? "parked" : age < STATE_RULES.running_s ? "running" : "no_signal",
    last_seen_ts: e.ts,
    age_s: age,
    ended_mid_drive: on && lost,
    link_down: latest.link?.v === 0 && age < STATE_RULES.lost_s,
  };
}

// Boot of the session that is still going, or null. Used to mark a trip as in progress.
export function liveBoot(latest: Latest, now: number): number | null {
  const s = carState(latest, now).state;
  return s === "running" || s === "no_signal" ? latest.engine_on.boot : null;
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, now - ts);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${r1(s / 3600)} h ago`;
  return `${r1(s / 86400)} days ago`;
}

const uploadingNow = (latest: Latest, now: number) =>
  latest.last_upload != null && now - latest.last_upload.ts < STATE_RULES.running_s;

// The logger sends stored records oldest first. While uploads are still arriving, an old
// newest record does not mean that the end of the drive was lost.
const catchingUp = (cs: CarState, latest: Latest, now: number) => cs.ended_mid_drive && uploadingNow(latest, now);

// Boot of the session whose end has not arrived: its newest record had the engine on, is
// older than lost_s, and no stored records are uploading. Null for every other case. Used to
// mark that trip as cut off.
export function cutOffBoot(latest: Latest, now: number): number | null {
  const cs = carState(latest, now);
  return cs.ended_mid_drive && !catchingUp(cs, latest, now) ? latest.engine_on.boot : null;
}

// The same during a shorter gap. Only the sentence changes, the car still counts as driving.
// The upload has to be well after the newest record, or it was just the last post before the
// car went quiet.
const drainingGap = (cs: CarState, latest: Latest, now: number) =>
  cs.state === "no_signal" && cs.last_seen_ts != null && uploadingNow(latest, now) &&
  latest.last_upload.ts - cs.last_seen_ts > STATE_RULES.running_s;

// The state word plus one plain sentence, for the Claude tools.
function describeState(env: Env, cs: CarState, latest: Latest, now: number) {
  const seen = cs.last_seen_ts == null ? "" : ago(cs.last_seen_ts, now);
  const backlog = catchingUp(cs, latest, now) || drainingGap(cs, latest, now);
  let summary: string;
  if (cs.state === "unknown") summary = "The logger has not reported yet.";
  else if (cs.state === "running") summary = `The engine is running, last report ${seen}.`;
  else if (cs.state === "no_signal" && !backlog) {
    summary = `No report since ${seen} and the engine was on then, so the car is probably driving without cell coverage or was just switched off.`;
  } else if (backlog) {
    summary = `The logger is uploading stored records right now (last upload ${ago(latest.last_upload.ts, now)}). The newest one so far is from ${seen} ` +
      "and had the engine on, so the current state is not known until it has caught up.";
  } else if (cs.ended_mid_drive) {
    summary = `Treated as parked. The last report (${seen}) still had the engine on, and the end of that drive has not arrived. ` +
      "Records the logger still holds are sent after its next start.";
  } else if (cs.link_down) {
    summary = `The logger is reporting (last ${seen}) but has no Bluetooth link to the OBD adapter, so the engine state is not known.`;
  } else summary = `Parked, the engine was off at the last report ${seen}.`;
  return {
    state: cs.state,
    summary,
    last_report: cs.last_seen_ts == null ? null : { at: fmtTime(env, cs.last_seen_ts), age: seen },
    ended_mid_drive: cs.ended_mid_drive && !backlog,
    link_down: cs.link_down,
  };
}

// A word that says how to read the battery voltage. 12.0 V is normal with the engine on in this
// car, so the engine state has to be known. Voltage alone cannot tell.
export function batteryContext(volts: number, engineOn: boolean): "charging" | "engine off" | "low" | "engine on, not charging" {
  if (volts < LOW_V) return "low";
  if (volts >= CHARGING_V) return "charging";
  return engineOn ? "engine on, not charging" : "engine off";
}

export const sameRecord = (a?: LatestEntry, b?: LatestEntry) => !!a && !!b && a.boot === b.boot && a.ms === b.ms;

// Was the engine on in the record the newest voltage came from? A newer record without a
// voltage can hold the engine flag, so only the voltage's own record counts. False without one.
export function batteryEngineOn(latest: Latest): boolean {
  const volts = latest.adapter_v;
  if (!volts) return false;
  return sameRecord(volts, latest.engine_on) ? latest.engine_on.v === 1
    : sameRecord(volts, latest.rpm) && latest.rpm.v > 0;
}

// The context word for the newest battery voltage, or null when no voltage was reported yet.
export function latestBattery(latest: Latest): ReturnType<typeof batteryContext> | null {
  const volts = latest.adapter_v;
  return volts ? batteryContext(volts.v, batteryEngineOn(latest)) : null;
}

// The battery as the car stood, from the first reading of a session: no RPM, neither the
// engine nor the no-link flag, and under CHARGING_V (13.0 V or more is a charger or an engine
// that already runs). Null for anything else. The car is awake and under some load when it is
// read, so it is not quite the resting voltage.
export function powerUpBattery(row: { adapter_v: number | null; rpm: number | null; flags: number }): number | null {
  const quiet = !row.rpm && (row.flags & (F.ENGINE_ON | F.NO_LINK)) === 0;
  return quiet && row.adapter_v != null && row.adapter_v < CHARGING_V ? row.adapter_v : null;
}

// ------------------------------------------------------------ status / location

function mapsLink(lat: number, lon: number) {
  return `https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
}

// The engine values of the status answer, each with the `latest` entry it comes from. The
// order is the order of engine_values_stale.
const ENGINE_VALUES = [["rpm", "last_rpm"], ["speed_kph", "last_speed_mph"], ["coolant_c", "coolant_f"], ["intake_c", "intake_air_f"]] as const;
// `latest` keeps a value that stopped arriving for good. One from another session, or this much
// older than the newest engine value, is not current. Two minutes, so build 2's once-a-minute
// retry of a skipped PID does not make a value come and go.
const ENGINE_VALUE_STALE_S = 120;
// An odometer reading this much older than the newest record says how old it is.
const ODOMETER_LAG_S = 600;

export async function latestStatus(env: Env, now = nowS()) {
  const L = await getLatest(env);
  if (!Object.keys(L).length) return { error: "No data received yet." };
  const val = (k: string) => L[k]?.v ?? null;
  const at = (e: LatestEntry | null | undefined) => (e ? { at: fmtTime(env, e.ts), age: ago(e.ts, now) } : null);
  const when = (k: string) => at(L[k]);
  const cs = carState(L, now);
  const fuelPct = val("fuel_pct");
  const gal = fuelPct == null ? null : (fuelPct / 100) * TANK_GAL;
  const econ = fuelPct == null ? null : await mpg30(env, now);
  // Under the minimum of logged miles the car's own rough figure is used when it is below the
  // EPA rating. A rough figure above it would stretch the range, so EPA stays then.
  const rough = econ ? roughMpg(econ) : null;
  const useRough = econ?.mpg == null && rough != null && rough < EPA.combined;
  const basis = econ?.mpg ?? (useRough ? rough! : EPA.combined);

  // The newest engine value anchors the others. A value that stopped arriving is null here and
  // listed with its own age, so an old speed is never dated by a fresh RPM.
  const anchor = ENGINE_VALUES.map(([k]) => L[k]).reduce<LatestEntry | null>((a, e) => (e && (!a || e.ts > a.ts) ? e : a), null);
  const engine: Record<string, number | null> = {};
  const stale: Record<string, string> = {};
  for (const [k, field] of ENGINE_VALUES) {
    const e = L[k];
    const current = !!e && !!anchor && e.boot === anchor.boot && anchor.ts - e.ts <= ENGINE_VALUE_STALE_S;
    if (e && !current) stale[field] = `last read ${ago(e.ts, now)}`;
    engine[field] = current ? e.v : null;
  }
  const csq = val("csq");
  const odoLags = !!L.odo_km && !!L.engine_on && L.engine_on.ts - L.odo_km.ts > ODOMETER_LAG_S;
  const battery = L.adapter_v;
  return {
    car_state: describeState(env, cs, L, now),
    // Without the adapter link the logger cannot see the engine, so this is not known.
    engine_running_at_last_report: cs.link_down ? null : val("engine_on") === 1,
    fuel: fuelPct == null ? null : {
      level_pct: fuelPct,
      est_gallons_left: r1(gal),
      est_range_mi: Math.round((gal ?? 0) * basis),
      range_basis_mpg: basis,
      range_basis: econ?.mpg != null
        ? "estimated MPG of the last 30 days"
        : useRough
          ? `rough MPG of the ${econ!.miles} logged miles of the last 30 days, fewer than ${MPG30_MIN_MILES} and lower than the EPA rating`
          : `EPA combined rating (fewer than ${MPG30_MIN_MILES} logged miles in the last 30 days)`,
      as_of: when("fuel_pct"),
    },
    battery_v: val("adapter_v"),
    battery_context: latestBattery(L),
    battery_as_of: when("adapter_v"),
    // The word describes the moment of the reading. For an old one, say so.
    ...(battery && now - battery.ts > STATE_RULES.lost_s ? {
      battery_note: `Measured ${ago(battery.ts, now)} with the engine ${batteryEngineOn(L) ? "running" : "off"}. ` +
        "The logger cannot measure a parked car, so the voltage now is not known.",
    } : {}),
    // The ECU's own voltage reading only means something while the engine runs.
    ...(cs.state === "running" ? { ecu_v: val("ecu_v") } : {}),
    coolant_f: cToF(engine.coolant_f),
    intake_air_f: cToF(engine.intake_air_f),
    last_speed_mph: engine.last_speed_mph == null ? null : Math.round(engine.last_speed_mph * KM_TO_MI),
    last_rpm: engine.last_rpm,
    engine_values_as_of: at(anchor),
    ...(Object.keys(stale).length ? { engine_values_stale: stale } : {}),
    odometer_mi: val("odo_km") == null ? null : Math.round(val("odo_km")! * KM_TO_MI),
    ...(odoLags ? { odometer_as_of: when("odo_km") } : {}),
    cell_signal_csq: csq,
    // 99 is the modem's "not known".
    cell_signal_dbm: csq == null || csq === 99 ? null : -113 + 2 * csq,
    logger: {
      firmware_build: val("fw"),
      adapter_link: L.link ? (L.link.v === 1 ? "up" : "down") : null,
      last_upload: when("last_upload"),
    },
    note: "When the car is parked the logger has no power, so these are the last values it reported. " +
      "Range is an estimate.",
  };
}

export async function location(env: Env, now = nowS()) {
  const L = await getLatest(env);
  if (L.lat == null || L.lon == null) return { error: "No GPS fix has been reported yet." };
  const cs = carState(L, now);
  // `latest` keeps the last fix for good. Records after it that had no fix (no view of the sky,
  // or a power-up that never got one) make it older than the last report by this much.
  const lag = L.engine_on ? L.engine_on.ts - L.lat.ts : 0;
  return {
    lat: L.lat.v, lon: L.lon.v, satellites: L.sats?.v ?? null,
    map: mapsLink(L.lat.v, L.lon.v),
    as_of: fmtTime(env, L.lat.ts), age: ago(L.lat.ts, now),
    fix_before_last_report_min: lag > 60 ? r1(lag / 60) : null,
    // Null when it is not known whether the car stands there: the adapter link is down, stored
    // records are still uploading, or the newest record had the engine on and nothing came after.
    parked: cs.link_down || cs.ended_mid_drive ? null : cs.state === "parked",
    car_state: describeState(env, cs, L, now),
  };
}

// ------------------------------------------------------------ trips

export interface TripAgg {
  boot: number; start_ts: number; end_ts: number; km: number | null; maf_g: number | null;
  engine_s: number | null; moving_s: number | null; max_kph: number | null; max_rpm: number | null;
  max_coolant: number | null; avg_rpm: number | null; est: number;
  // Odometer at the first and last reading of the session, km. Null when the car never answered
  // (and always null for aggregates built from `minutes`).
  odo_start: number | null; odo_end: number | null;
  fw: number; // highest firmware build seen in the session, 0 = legacy
  nolink_n: number; // records written while the adapter link was down
}

// Raw numbers for one trip. The MCP tools format these as text, the dashboard as charts.
export interface TripNums {
  id: number; start_ts: number; end_ts: number; duration_s: number; engine_s: number; moving_s: number;
  miles: number; gallons: number; mpg: number | null; avg_mph: number | null; max_mph: number | null;
  max_rpm: number | null; avg_rpm: number | null; max_coolant_f: number | null; est: boolean;
  odo_miles: number | null; // distance by the car's odometer, one decimal
  // Miles the odometer moved between the previous trip's end and this trip's start, so driving
  // the logger missed. Null when there is no gap, or when either reading is unknown.
  unlogged_before_mi: number | null;
  // True when both of those readings exist, or when no trip came before this one. Tells a
  // null that means "no gap" from a null that means "not known".
  unlogged_known: boolean;
  fw: number; nolink_n: number;
  // Distance along the route points, filled by withGpsMiles only for a trip whose speed
  // readings gave almost nothing. Null otherwise.
  gps_miles: number | null;
}

// One trip on its own. `unlogged_before_mi` needs the previous trip, so it is null and not
// known here. Use tripNumbersList for lists.
export function tripNumbers(t: TripAgg): TripNums {
  const miles = (t.km ?? 0) * KM_TO_MI;
  const gallons = gallonsOf(t.maf_g);
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
    odo_miles: t.odo_start != null && t.odo_end != null && t.odo_end >= t.odo_start
      ? r1((t.odo_end - t.odo_start) * KM_TO_MI) : null,
    unlogged_before_mi: null,
    unlogged_known: false,
    fw: t.fw ?? 0,
    nolink_n: t.nolink_n ?? 0,
    gps_miles: null,
  };
}

// ---- distance from GPS, for drives whose speed readings failed

// Below this logged distance a trip gets a GPS figure, if its route says it moved.
export const GPS_FALLBACK_BELOW_MI = 0.1;
// A trip moved when its speed readings logged that much, or when its route gave a GPS distance
// because they failed. Anything else was an idle session: a start without driving.
export const tripMoved = (n: Pick<TripNums, "miles" | "gps_miles">) => n.miles >= GPS_FALLBACK_BELOW_MI || n.gps_miles != null;
// Steps between route points (15 s apart) that count as driving: slower is GPS drift while
// standing, faster or longer apart is a jump or a gap that says nothing about the path.
const GPS_MIN_MPS = 2, GPS_MAX_MPS = 70, GPS_MAX_GAP_MS = 60000;

// Kilometres along a route of one session, points in ms order.
export function routeKm(points: { ms: number; lat: number; lon: number }[]): number {
  let km = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dt = b.ms - a.ms;
    if (dt <= 0 || dt > GPS_MAX_GAP_MS) continue;
    const mid = ((a.lat + b.lat) / 2) * (Math.PI / 180);
    const dx = (b.lon - a.lon) * 111.32 * Math.cos(mid);
    const dy = (b.lat - a.lat) * 110.574;
    const d = Math.hypot(dx, dy);
    const mps = (d * 1000) / (dt / 1000);
    if (mps >= GPS_MIN_MPS && mps <= GPS_MAX_MPS) km += d;
  }
  return km;
}

// Fills gps_miles for the trips that logged under GPS_FALLBACK_BELOW_MI. Reads only the
// route points of those trips, which are rare, so lists of normal drives cost nothing extra.
export async function withGpsMiles(env: Env, nums: TripNums[]): Promise<TripNums[]> {
  const want = [...new Set(nums.filter((n) => n.miles < GPS_FALLBACK_BELOW_MI).map((n) => n.id))];
  if (!want.length) return nums;
  const byBoot = new Map<number, { ms: number; lat: number; lon: number }[]>();
  for (let i = 0; i < want.length; i += 90) {
    const part = want.slice(i, i + 90);
    const rows = await env.DB.prepare(
      `SELECT boot, ms, lat, lon FROM track WHERE boot IN (${part.map(() => "?").join(",")}) ORDER BY boot, ms`,
    ).bind(...part).all<{ boot: number; ms: number; lat: number; lon: number }>();
    for (const r of rows.results) {
      if (!byBoot.has(r.boot)) byBoot.set(r.boot, []);
      byBoot.get(r.boot)!.push(r);
    }
  }
  return nums.map((n) => {
    const pts = byBoot.get(n.id);
    if (!pts || n.miles >= GPS_FALLBACK_BELOW_MI) return n;
    const mi = r1(routeKm(pts) * KM_TO_MI);
    return mi != null && mi >= GPS_FALLBACK_BELOW_MI ? { ...n, gps_miles: mi } : n;
  });
}

// Odometer miles between the end of `prev` and the start of `cur`.
export function unloggedMiles(
  prev: Pick<TripAgg, "odo_end"> | null | undefined, cur: Pick<TripAgg, "odo_start">,
): number | null {
  if (!prev || prev.odo_end == null || cur.odo_start == null) return null;
  // Round to the odometer's 0.1 km step first so float noise cannot cross the threshold.
  const gapKm = Math.round((cur.odo_start - prev.odo_end) * 10) / 10;
  return gapKm > UNLOGGED_MIN_KM ? r1(gapKm * KM_TO_MI) : null;
}

// tripNumbers for a list in any time order, with `unlogged_before_mi` filled from the trip just
// before each one in the list. The oldest trip has no predecessor in the list and stays null.
export function tripNumbersList(aggs: TripAgg[]): TripNums[] {
  const byTime = [...aggs].sort((a, b) => a.start_ts - b.start_ts);
  const prev = new Map<TripAgg, TripAgg>();
  byTime.forEach((t, i) => { if (i) prev.set(t, byTime[i - 1]); });
  return aggs.map((t) => {
    const p = prev.get(t);
    return {
      ...tripNumbers(t),
      unlogged_before_mi: unloggedMiles(p, t),
      unlogged_known: p != null && p.odo_end != null && t.odo_start != null,
    };
  });
}

// Total of `unlogged_before_mi` over `trips`. Null when the gap before one of them is not
// known, because a wrong 0 would say that nothing was missed.
export function unloggedTotal(trips: TripNums[]): number | null {
  return trips.every((t) => t.unlogged_known) ? r1(trips.reduce((a, t) => a + (t.unlogged_before_mi ?? 0), 0)) : null;
}

// A floor for unloggedTotal when it is null: the gaps that are known, added up. Null when
// unloggedTotal has the figure, or when the known gaps add up to nothing. The dashboard and
// get_history both take it from here.
export function unloggedAtLeast(trips: TripNums[]): number | null {
  if (unloggedTotal(trips) != null) return null;
  const sum = r1(trips.reduce((a, t) => a + (t.unlogged_before_mi ?? 0), 0)) ?? 0;
  return sum > 0 ? sum : null;
}

// How far the odometer moved over a set of trips: from the first reading to the last, in time
// order, so driving the logger missed between them counts too. Null when either end is missing,
// or when it went backwards.
export function odometerSpanMiles(aggs: Pick<TripAgg, "start_ts" | "odo_start" | "odo_end">[]): number | null {
  const byTime = [...aggs].sort((a, b) => a.start_ts - b.start_ts);
  const first = byTime.find((t) => t.odo_start != null)?.odo_start;
  const last = byTime.reverse().find((t) => t.odo_end != null)?.odo_end;
  return first == null || last == null || last < first ? null : r1((last - first) * KM_TO_MI);
}

// All trip reads go through the `trips` rollup (one row per session, maintained on upload),
// never a scan of `samples`. D1 bills every row scanned. A trip is a session with the engine on.
export const TRIP_COLS = `boot, start_ts, end_ts, km, maf_g, engine_s, moving_s, max_kph, max_rpm, max_coolant,
  CASE WHEN rpm_n > 0 THEN rpm_sum / rpm_n END AS avg_rpm, est, odo_start, odo_end, fw, nolink_n`;

export async function recentTripAggs(env: Env, limit: number): Promise<TripAgg[]> {
  const rows = await env.DB.prepare(
    `SELECT ${TRIP_COLS} FROM trips WHERE engine_n > 0 ORDER BY end_ts DESC LIMIT ?`,
  ).bind(limit).all<TripAgg>();
  return rows.results.sort((a, b) => b.start_ts - a.start_ts);
}

// Whole trips that were active at some point since `since`.
export async function tripAggsSince(env: Env, since: number): Promise<TripAgg[]> {
  const rows = await env.DB.prepare(`SELECT ${TRIP_COLS} FROM trips WHERE engine_n > 0 AND end_ts >= ?`)
    .bind(since).all<TripAgg>();
  return rows.results.sort((a, b) => b.start_ts - a.start_ts);
}

// Per-trip aggregates clipped to [from, to] at one-minute resolution, from `minutes`.
// The minute rows carry no odometer, firmware build or link state, so those come back empty.
export async function tripAggsBetween(env: Env, from: number, to: number): Promise<TripAgg[]> {
  const rows = await env.DB.prepare(
    `SELECT boot, MIN(t) AS start_ts, MAX(t) + 59 AS end_ts, SUM(km) AS km, SUM(maf_g) AS maf_g,
            SUM(engine_s) AS engine_s, SUM(moving_s) AS moving_s, MAX(spd_max) AS max_kph, MAX(rpm_max) AS max_rpm,
            MAX(cool_max) AS max_coolant, CASE WHEN SUM(rpm_n) > 0 THEN SUM(rpm_sum) / SUM(rpm_n) END AS avg_rpm, 0 AS est,
            NULL AS odo_start, NULL AS odo_end, 0 AS fw, 0 AS nolink_n
     FROM minutes WHERE t BETWEEN ? AND ? GROUP BY boot HAVING SUM(engine_n) > 0`,
  ).bind(Math.floor(from / 60) * 60, to).all<TripAgg>();
  return rows.results.sort((a, b) => b.start_ts - a.start_ts);
}

// Whole trips (not clipped) that overlap [from, to].
export async function tripAggsTouching(env: Env, from: number, to: number): Promise<TripAgg[]> {
  const rows = await env.DB.prepare(
    `SELECT ${TRIP_COLS} FROM trips WHERE engine_n > 0 AND end_ts >= ? AND start_ts <= ?`,
  ).bind(from, to).all<TripAgg>();
  return rows.results.sort((a, b) => b.start_ts - a.start_ts);
}

export async function tripAgg(env: Env, boot: number): Promise<TripAgg | null> {
  return env.DB.prepare(`SELECT ${TRIP_COLS} FROM trips WHERE boot = ? AND engine_n > 0`).bind(boot).first<TripAgg>();
}

// The trip that started before `t` and ended last. One row through the end_ts index.
// Bounded by the end of `t`, not its start: a session whose last records were dated at upload
// time can have a stored end a little after the next session's start.
export async function tripBefore(env: Env, t: Pick<TripAgg, "boot" | "start_ts" | "end_ts">): Promise<TripAgg | null> {
  return env.DB.prepare(
    `SELECT ${TRIP_COLS} FROM trips WHERE engine_n > 0 AND end_ts <= ?3 AND start_ts < ?1 AND boot != ?2
     ORDER BY end_ts DESC LIMIT 1`,
  ).bind(t.start_ts, t.boot, t.end_ts).first<TripAgg>();
}

// tripNumbersList plus one lookup, so the oldest trip in the list gets its unlogged miles too.
export async function tripNumbersWithGaps(env: Env, aggs: TripAgg[]): Promise<TripNums[]> {
  if (!aggs.length) return [];
  const oldest = aggs.reduce((a, b) => (b.start_ts < a.start_ts ? b : a));
  const prev = await tripBefore(env, oldest);
  if (prev) return tripNumbersList([...aggs, prev]).slice(0, aggs.length);
  // No trip at all came before the oldest one, so nothing can be missing before it.
  return tripNumbersList(aggs).map((n) => (n.id === oldest.boot ? { ...n, unlogged_known: true } : n));
}

// Trip miles are whole hundredths, so the minimum is tested on integer hundredths and float
// noise in a sum cannot move a total across it.
const hundredths = (miles: number) => Math.round(miles * 100);
export const enoughMpgMiles = (miles: number) => hundredths(miles) >= MPG30_MIN_MILES * 100;
// One decimal, rounded down, so a page that compares it with MPG30_MIN_MILES agrees with enoughMpgMiles.
export const milesDown = (miles: number) => Math.floor(hundredths(miles) / 10) / 10;

// The same miles and gallons while they are fewer than MPG30_MIN_MILES, from 5 miles on. Null
// once mpg30 has a figure. It is rough, so whatever shows it has to say so.
export const roughMpg = (e: { mpg: number | null; miles: number; gallons: number }) =>
  (e.mpg == null && e.miles >= 5 && e.gallons > 0.05 ? r1(e.miles / e.gallons) : null);

// 30-day figure used for range. Null until at least 25 logged miles exist in the window.
export async function mpg30(env: Env, now = nowS()): Promise<{ mpg: number | null; miles: number; gallons: number }> {
  const list = (await tripAggsSince(env, now - 30 * 86400)).map(tripNumbers);
  const miles = list.reduce((a, t) => a + t.miles, 0);
  const gallons = list.reduce((a, t) => a + t.gallons, 0);
  return {
    mpg: enoughMpgMiles(miles) && gallons > 0.05 ? r1(miles / gallons) : null,
    miles: milesDown(miles),
    gallons: r2(gallons) ?? 0,
  };
}

// `live` is the boot of the session in progress, `cut` the one whose end has not arrived.
function shapeTrip(env: Env, n: TripNums, live: number | null, cut: number | null) {
  return {
    trip_id: n.id,
    label: tripLabel(n.id),
    start: fmtTime(env, n.start_ts),
    end: fmtTime(env, n.end_ts),
    logger_on_min: r1(n.duration_s / 60),
    engine_on_min: r1(n.engine_s / 60),
    moving_min: r1(n.moving_s / 60),
    distance_mi: n.miles,
    // Only present when the speed readings failed but the GPS route shows the car moving.
    ...(n.gps_miles != null ? { gps_distance_mi: n.gps_miles, distance_note: "Speed readings failed on this trip, so distance_mi is near 0. gps_distance_mi is measured along the GPS route and reads a little short on curves." } : {}),
    odometer_distance_mi: n.odo_miles,
    unlogged_before_mi: n.unlogged_before_mi,
    fuel_used_gal_est: n.gallons,
    mpg_est: n.mpg,
    avg_moving_speed_mph: n.avg_mph,
    max_speed_mph: n.max_mph,
    max_rpm: n.max_rpm,
    avg_rpm: n.avg_rpm,
    max_coolant_f: n.max_coolant_f,
    times_estimated: n.est,
    in_progress: n.id === live,
    ...(n.id === cut ? { end_not_received: true } : {}),
  };
}

// Newest trips first. `from` and `to` are local dates (both included) and either may be left out.
export async function listTrips(env: Env, a: { limit?: unknown; from?: unknown; to?: unknown } = {}, now = nowS()) {
  const limit = clampInt(a.limit, 10, 1, 50);
  const tz = zoneOf(env);
  const from = a.from == null ? null : parseDay(a.from);
  const to = a.to == null ? null : parseDay(a.to);
  if (a.from != null && from == null) return badInput(`from is not a calendar date: ${JSON.stringify(a.from)}. Use YYYY-MM-DD, for example 2026-11-05.`);
  if (a.to != null && to == null) return badInput(`to is not a calendar date: ${JSON.stringify(a.to)}. Use YYYY-MM-DD, for example 2026-11-05.`);
  if (from != null && to != null && from > to) return badInput(`from (${dateOfDay(from)}) is after to (${dateOfDay(to)}).`);

  const where = ["engine_n > 0"];
  const binds: number[] = [];
  if (from != null) { where.push("end_ts >= ?"); binds.push(dayStart(tz, from)); }
  if (to != null) { where.push("start_ts < ?"); binds.push(dayStart(tz, to + 1)); }
  // One row more than asked for: it tells whether older trips exist, and it is the
  // predecessor that the last listed trip needs for its unlogged miles.
  const [rows, L] = await Promise.all([
    env.DB.prepare(`SELECT ${TRIP_COLS} FROM trips WHERE ${where.join(" AND ")} ORDER BY end_ts DESC LIMIT ?`)
      .bind(...binds, limit + 1).all<TripAgg>(),
    getLatest(env),
  ]);
  const aggs = rows.results.sort((x, y) => y.start_ts - x.start_ts);
  const more = aggs.length > limit;
  const nums = await withGpsMiles(env, (more || from == null ? tripNumbersList(aggs) : await tripNumbersWithGaps(env, aggs)).slice(0, limit));
  const live = liveBoot(L, now), cut = cutOffBoot(L, now);
  return {
    ...(from != null || to != null
      ? { window: { from: from == null ? null : dateOfDay(from), to: to == null ? null : dateOfDay(to), time_zone: tz } }
      : {}),
    trips: nums.slice(0, limit).map((n) => shapeTrip(env, n, live, cut)),
    more_trips_exist: more,
  };
}

// Tank gauge in whole percent at the first or last minute of a trip that has a reading. Reads
// the trip's minute rows from one end, never `samples`. A minute with a 0 % reading is skipped,
// see the stray-zero rule in ingest.ts.
async function gaugeEdge(env: Env, agg: TripAgg, dir: "ASC" | "DESC"): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT ROUND(fuel_sum / fuel_n) AS pct FROM minutes
     WHERE t BETWEEN ?1 AND ?2 AND boot = ?3 AND fuel_n > 0 AND fuel_min > 0 ORDER BY t ${dir} LIMIT 1`,
  ).bind(Math.floor(agg.start_ts / 60) * 60, agg.end_ts, agg.boot).first<{ pct: number }>();
  return row?.pct ?? null;
}

// First or last route point of a trip. Every `track` row has a position, so this reads one
// row. The same search in `samples` walks the whole session when the trip never had a fix.
async function place(env: Env, boot: number, dir: "ASC" | "DESC") {
  return env.DB.prepare(`SELECT lat, lon FROM track WHERE boot = ? ORDER BY ms ${dir} LIMIT 1`)
    .bind(boot).first<{ lat: number; lon: number }>();
}

// The default trip is looked for among this many of the newest sessions. An idle session or two
// in front of the last drive is common (a start to move the car, a warm-up), five is not.
const DEFAULT_TRIP_LOOKBACK = 5;

export async function tripSummary(env: Env, a: { trip_id?: unknown; include_locations?: unknown } = {}, now = nowS()) {
  let agg: TripAgg | null;
  // Filled when the default trip is picked, so its numbers and `latest` are not read twice.
  let picked: TripNums | null = null;
  let latest: Latest | null = null;
  let skipped: TripNums[] = [];
  if (a.trip_id == null) {
    // The newest trip in which the car moved, or the one in progress. Idle sessions newer than
    // it are named in the answer, so an engine start without driving is not hidden. Without such
    // a trip among the newest sessions, the newest one. About five indexed rows.
    const [recent, L] = await Promise.all([recentTripAggs(env, DEFAULT_TRIP_LOOKBACK), getLatest(env)]);
    if (!recent.length) return { error: "No trips recorded yet." };
    const nums = await withGpsMiles(env, recent.map(tripNumbers));
    const live = liveBoot(L, now);
    const i = Math.max(0, nums.findIndex((n) => n.id === live || tripMoved(n)));
    agg = recent[i];
    picked = nums[i];
    latest = L;
    skipped = nums.slice(0, i);
  } else {
    const id = parseTripId(a.trip_id);
    if (id == null) {
      return badInput(`trip_id must be a whole number or a label like "173-12", taken from list_trips, not ${JSON.stringify(a.trip_id)}.`);
    }
    agg = await tripAgg(env, id);
    if (!agg) return { error: `Trip ${tripLabel(id)} not found. Use list_trips to see the trip ids.` };
  }
  const boot = agg.boot;
  const withPlaces = a.include_locations === true || a.include_locations === "true";
  const [f0, f1, p0, p1, prev, L, [g]] = await Promise.all([
    gaugeEdge(env, agg, "ASC"), gaugeEdge(env, agg, "DESC"),
    withPlaces ? place(env, boot, "ASC") : null, withPlaces ? place(env, boot, "DESC") : null,
    tripBefore(env, agg), latest ?? getLatest(env),
    picked ? [picked] : withGpsMiles(env, [tripNumbers(agg)]),
  ]);
  const n: TripNums = { ...g, unlogged_before_mi: unloggedMiles(prev, agg) };
  const cut = cutOffBoot(L, now);
  return {
    ...shapeTrip(env, n, liveBoot(L, now), cut),
    fuel_level_pct: { start: f0, end: f1 },
    odometer_mi: agg.odo_start != null && agg.odo_end != null
      ? { start: Math.round(agg.odo_start * KM_TO_MI), end: Math.round(agg.odo_end * KM_TO_MI) } : null,
    ...(n.nolink_n ? { records_without_adapter_link: n.nolink_n } : {}),
    ...(withPlaces ? {
      start_location: p0 ? { lat: p0.lat, lon: p0.lon, map: mapsLink(p0.lat, p0.lon) } : null,
      end_location: p1 ? { lat: p1.lat, lon: p1.lon, map: mapsLink(p1.lat, p1.lon) } : null,
    } : {}),
    ...(skipped.length ? {
      newer_sessions_without_driving: skipped.map((s) => ({
        trip_id: s.id, label: tripLabel(s.id), start: fmtTime(env, s.start_ts), engine_on_min: r1(s.engine_s / 60),
        // The newest session can be cut off. What arrived of it did not move, the rest may still come.
        ...(s.id === cut ? { end_not_received: true } : {}),
      })),
    } : {}),
    note: (n.id === cut
      ? "The logger stopped sending while the engine was still on. End time, distance and fuel cover only what arrived. " +
        "The rest may come in after the next start. "
      : "") +
      "Fuel used and MPG are estimates from engine airflow (MAF), assuming E10 pump gasoline. They read low at full " +
      "throttle and high while coasting. fuel_level_pct is the tank gauge in whole percent. It swings by several points " +
      "while driving, so the difference between start and end is not fuel used. distance_mi is integrated from " +
      "speed and usually reads about 1% under the odometer.",
  };
}

// ------------------------------------------------------------ fuel economy

export async function fuelEconomy(env: Env, days: number, now = nowS()) {
  const list = (await tripAggsSince(env, now - days * 86400)).map(tripNumbers);
  const miles = list.reduce((a, t) => a + t.miles, 0);
  const gal = list.reduce((a, t) => a + t.gallons, 0);
  const ranked = list.filter((t) => t.mpg != null && t.miles >= RANKED_TRIP_MIN_MILES).map((t) => t.mpg!);
  const combined = gal > 0.05 ? r1(miles / gal) : null;
  // A short window is a fair question, so the figure stays. The flag keeps it from being
  // read as a solid average, which the dashboard only shows from the same minimum on.
  const fewMiles = combined != null && !enoughMpgMiles(miles);
  return {
    window_days: days,
    trip_count: list.length,
    total_miles: r1(miles),
    total_gallons_est: r2(gal),
    combined_mpg_est: combined,
    combined_mpg_few_miles: fewMiles,
    epa_reference_mpg: EPA,
    best_trip_mpg_est: ranked.length ? Math.max(...ranked) : null,
    worst_trip_mpg_est: ranked.length ? Math.min(...ranked) : null,
    // Only the trips that are listed get their time formatted.
    trips: list.slice(0, 20).map((t) => ({
      trip_id: t.id, label: tripLabel(t.id), start: fmtTime(env, t.start_ts), distance_mi: t.miles, mpg_est: t.mpg,
    })),
    note: `Gallons and MPG are estimates from engine airflow (MAF), not from fill-ups. Best and worst only count trips of ${RANKED_TRIP_MIN_MILES} miles or more. ` +
      "The trips list holds the 20 newest." +
      (fewMiles
        ? ` combined_mpg_est rests on fewer than ${MPG30_MIN_MILES} logged miles, so it is rough and not a solid average. ` +
          `Below ${MPG30_MIN_MILES} miles the dashboard marks its figure as rough too.`
        : ""),
  };
}

// ------------------------------------------------------------ history

const HISTORY_MAX_TRIPS = 50;

interface DayRow {
  day: number; km: number | null; maf_g: number | null; engine_s: number | null; moving_s: number | null;
  max_kph: number | null; max_rpm: number | null; trips: number;
}

// Totals for a window of whole local days, optionally per day, plus the trips in it.
// Reads only `minutes` (clipped totals) and `trips` (the list), never `samples`.
export async function history(
  env: Env, a: { period?: unknown; from?: unknown; to?: unknown; group_by?: unknown } = {}, now = nowS(),
) {
  if (a.group_by != null && a.group_by !== "day") {
    return badInput(`group_by can only be "day". Leave it out for totals alone.`);
  }
  const tz = zoneOf(env);
  const w = resolveWindow(tz, now, a);
  if ("error" in w) return w;

  // Minutes are grouped by local day inside SQL. The day changes at local midnight, which is a
  // different UTC offset on each side of a daylight-saving change, hence the spans.
  const spans = offsetSpans(tz, w.start, w.end);
  const [dayRows, touching, first] = await Promise.all([
    env.DB.prepare(
      `SELECT ${dayExpr("t", spans)} AS day, SUM(km) AS km, SUM(maf_g) AS maf_g, SUM(engine_s) AS engine_s,
              SUM(moving_s) AS moving_s, MAX(spd_max) AS max_kph, MAX(rpm_max) AS max_rpm,
              COUNT(DISTINCT CASE WHEN engine_n > 0 THEN boot END) AS trips
       FROM minutes WHERE t >= ? AND t < ? GROUP BY 1 ORDER BY 1`,
    ).bind(w.start, w.end).all<DayRow>(),
    tripAggsTouching(env, w.start, w.end - 1),
    // The oldest session of all, one row through the end_ts index.
    env.DB.prepare(`SELECT start_ts FROM trips WHERE end_ts IS NOT NULL ORDER BY end_ts LIMIT 1`).first<{ start_ts: number | null }>(),
  ]);
  const nums = await withGpsMiles(env, await tripNumbersWithGaps(env, touching));
  // A window that begins before the logger had any data would read as days without driving.
  const dataStarts = first?.start_ts ?? null;
  const uncovered = dataStarts == null || dataStarts > w.start;

  const days = dayRows.results;
  const sum = (k: "km" | "maf_g" | "engine_s" | "moving_s") => days.reduce((acc, d) => acc + (d[k] ?? 0), 0);
  const max = (k: "max_kph" | "max_rpm") => days.reduce<number | null>((m, d) => (d[k] != null && (m == null || d[k]! > m) ? d[k] : m), null);
  const miles = sum("km") * KM_TO_MI, gal = gallonsOf(sum("maf_g"));
  const driven = days.filter((d) => (d.engine_s ?? 0) > 0 || (d.km ?? 0) > 0);
  const mph = (kph: number | null) => (kph == null ? null : Math.round(kph * KM_TO_MI));
  const startedInside = nums.filter((n) => n.start_ts >= w.start && n.start_ts < w.end);
  const distance = r1(miles) ?? 0;
  const mpg = gal > 0.05 ? r1(miles / gal) : null;
  // Only trips wholly inside the window, so the span holds no driving from outside it.
  const odometer = odometerSpanMiles(touching.filter((t) => t.start_ts >= w.start && t.end_ts < w.end));
  // Null when no trip in the window has odometer readings, or when the gap before one of them
  // is not known, so "none found" and "unknown" differ.
  const unlogged = touching.some((t) => t.odo_start != null) ? unloggedTotal(startedInside) : null;
  const atLeast = unlogged == null ? unloggedAtLeast(startedInside) : null;
  const listed = nums.slice(0, HISTORY_MAX_TRIPS);

  return {
    window: {
      from: dateOfDay(w.from_day), to: dateOfDay(w.to_day), days: w.to_day - w.from_day + 1, time_zone: tz,
      starts_at: fmtTime(env, w.start), ends_before: fmtTime(env, w.end),
      ...(uncovered ? { data_starts: fmtTime(env, dataStarts) } : {}),
    },
    totals: {
      distance_mi: distance,
      odometer_distance_mi: odometer,
      fuel_used_gal_est: r2(gal),
      mpg_est: mpg,
      // The dashboard's rule: under MPG30_MIN_MILES logged miles the figure is rough.
      mpg_est_few_miles: mpg != null && !enoughMpgMiles(miles),
      engine_on_min: r1(sum("engine_s") / 60),
      moving_min: r1(sum("moving_s") / 60),
      idle_min: r1(Math.max(0, sum("engine_s") - sum("moving_s")) / 60),
      max_speed_mph: mph(max("max_kph")),
      max_rpm: max("max_rpm"),
      days_with_driving: driven.length,
      trip_count: touching.length,
      unlogged_mi: unlogged,
      ...(atLeast != null ? { unlogged_mi_at_least: atLeast } : {}),
    },
    ...(a.group_by === "day" ? {
      days: driven.map((d) => {
        const mi = (d.km ?? 0) * KM_TO_MI, g = gallonsOf(d.maf_g);
        return {
          date: dateOfDay(d.day),
          distance_mi: r1(mi),
          fuel_used_gal_est: r2(g),
          mpg_est: g > 0.01 && mi > 0.1 ? r1(mi / g) : null,
          engine_on_min: r1((d.engine_s ?? 0) / 60),
          moving_min: r1((d.moving_s ?? 0) / 60),
          max_speed_mph: mph(d.max_kph),
          trips: d.trips,
        };
      }),
    } : {}),
    trips: listed.map((n) => ({
      trip_id: n.id,
      label: tripLabel(n.id),
      start: fmtTime(env, n.start_ts),
      logger_on_min: r1(n.duration_s / 60),
      engine_on_min: r1(n.engine_s / 60),
      distance_mi: n.miles,
      ...(n.gps_miles != null ? { gps_distance_mi: n.gps_miles } : {}),
      fuel_used_gal_est: n.gallons,
      mpg_est: n.mpg,
      unlogged_before_mi: n.unlogged_before_mi,
    })),
    trips_not_listed: Math.max(0, nums.length - HISTORY_MAX_TRIPS),
    note: "Totals and days count only what happened inside the window. Trips are listed whole, newest first, so a trip that " +
      "crosses the edge of the window or midnight can show more miles than its day. Fuel and MPG are estimates from engine " +
      "airflow. Days without driving are left out. unlogged_mi is odometer distance the logger did not record, " +
      "null when that is not known." +
      (odometer != null && odometer - distance > Math.max(1, distance * 0.05)
        ? ` The odometer moved ${odometer} mi between the first and last readings in this window. ${distance} mi of that ` +
          "were logged from speed readings, the rest was missed by the logger or only measured by GPS."
        : "") +
      (listed.some((n) => n.gps_miles != null)
        ? " A trip row with gps_distance_mi had failed speed readings, so its distance_mi is near 0."
        : "") +
      (uncovered
        ? dataStarts == null
          ? " The logger has no data at all yet, so zeros here do not mean the car was not driven."
          : " The logger's data only starts at window.data_starts. Earlier days in the window are not covered, which is not the same as not driven."
        : ""),
  };
}

// Tests for the shared read helpers and the Claude tools. The first part is pure: arithmetic,
// or calls that return before the first query. The last part runs the tools against the
// in-memory D1 look-alike with a small made-up set of trips around a clock change.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { handleMcp } from "../src/mcp.ts";
import {
  batteryContext, CAR, carState, clampInt, cutOffBoot, dateOfDay, dayExpr, dayStart, fmtTime, fuelEconomy, history,
  latestBattery, latestStatus, listTrips, liveBoot, localDay, location, mpg30, MPG30_MIN_MILES, odometerSpanMiles, offsetSpans,
  parseDay, parseTripId, powerUpBattery, resolveWindow, roughMpg, sameRecord, STATE_RULES, tripAgg, tripBefore, tripLabel,
  tripMoved, tripNumbers, tripNumbersList, tripNumbersWithGaps, tripSummary, tzOffset, unloggedAtLeast, unloggedMiles,
  unloggedTotal, routeKm, withGpsMiles,
} from "../src/queries.ts";
import { makeEnv } from "./helpers/d1.mjs";

const LA = "America/Los_Angeles";
const utc = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const H = 3600;

// ------------------------------------------------------------ car state

const NOW = utc(2026, 11, 11, 20);
const entry = (v, age, boot = 11337740) => ({ v, ts: NOW - age, boot, ms: 1000 });

test("carState: no engine_on entry is unknown", () => {
  assert.deepEqual(carState({}, NOW), { state: "unknown", last_seen_ts: null, age_s: null, ended_mid_drive: false, link_down: false });
  // Other fields alone do not make a state.
  assert.equal(carState({ rpm: entry(900, 5) }, NOW).state, "unknown");
});

test("carState: engine on follows the two age boundaries", () => {
  assert.deepEqual(STATE_RULES, { running_s: 90, lost_s: 600 });
  const at = (age) => carState({ engine_on: entry(1, age) }, NOW);
  assert.deepEqual(at(0), { state: "running", last_seen_ts: NOW, age_s: 0, ended_mid_drive: false, link_down: false });
  assert.equal(at(89).state, "running");
  assert.equal(at(90).state, "no_signal");
  assert.equal(at(90).ended_mid_drive, false);
  assert.equal(at(600).state, "no_signal");
  assert.equal(at(600).ended_mid_drive, false);
  assert.deepEqual(at(601), { state: "parked", last_seen_ts: NOW - 601, age_s: 601, ended_mid_drive: true, link_down: false });
  assert.equal(at(86400).state, "parked");
  assert.equal(at(86400).ended_mid_drive, true);
});

test("carState: engine off is parked at any age and never ended mid drive", () => {
  for (const age of [0, 89, 90, 600, 601, 86400]) {
    const s = carState({ engine_on: entry(0, age) }, NOW);
    assert.equal(s.state, "parked", `age ${age}`);
    assert.equal(s.ended_mid_drive, false, `age ${age}`);
    assert.equal(s.age_s, age);
  }
});

test("carState: a record from a clock ahead of ours has age 0, not a negative one", () => {
  const s = carState({ engine_on: entry(1, -120) }, NOW);
  assert.equal(s.age_s, 0);
  assert.equal(s.state, "running");
});

test("carState: link_down needs link 0 and a recent record", () => {
  const at = (link, age, on = 0) => carState({ engine_on: entry(on, age), ...(link == null ? {} : { link: entry(link, age) }) }, NOW);
  assert.equal(at(0, 30).link_down, true);
  assert.equal(at(0, 30).state, "parked");
  assert.equal(at(0, 599).link_down, true);
  assert.equal(at(0, 600).link_down, false);
  assert.equal(at(0, 601).link_down, false);
  assert.equal(at(1, 30).link_down, false);
  assert.equal(at(null, 30).link_down, false); // legacy firmware never writes the entry
  assert.equal(at(0, 30, 1).state, "running");
  assert.equal(at(0, 30, 1).link_down, true);
});

test("liveBoot: only a running or no_signal session is in progress", () => {
  assert.equal(liveBoot({}, NOW), null);
  assert.equal(liveBoot({ engine_on: entry(1, 10, 12) }, NOW), 12);
  assert.equal(liveBoot({ engine_on: entry(1, 300, 12) }, NOW), 12);
  assert.equal(liveBoot({ engine_on: entry(1, 601, 12) }, NOW), null);
  assert.equal(liveBoot({ engine_on: entry(0, 10, 12) }, NOW), null);
});

test("cutOffBoot: the engine was on in the newest record, and nothing came after it", () => {
  const at = (on, age, uploadAge) => ({
    engine_on: entry(on, age, 12),
    ...(uploadAge == null ? {} : { last_upload: { v: NOW - uploadAge, ts: NOW - uploadAge, boot: 0, ms: 0 } }),
  });
  assert.equal(cutOffBoot(at(1, 601), NOW), 12);
  assert.equal(cutOffBoot(at(1, 600), NOW), null); // no signal yet, not cut off
  assert.equal(cutOffBoot(at(1, 601, 89), NOW), null); // stored records are still uploading
  assert.equal(cutOffBoot(at(1, 601, 90), NOW), 12);
  assert.equal(cutOffBoot(at(0, 601), NOW), null);
  assert.equal(cutOffBoot({}, NOW), null);
});

test("batteryContext: the word depends on the engine, not on voltage alone", () => {
  assert.equal(batteryContext(14.2, true), "charging");
  assert.equal(batteryContext(13.0, true), "charging");
  assert.equal(batteryContext(12.1, true), "engine on, not charging");
  assert.equal(batteryContext(12.4, false), "engine off");
  assert.equal(batteryContext(13.4, false), "charging");
  assert.equal(batteryContext(11.7, false), "low");
  assert.equal(batteryContext(11.7, true), "low");
});

test("sameRecord and latestBattery: the engine state comes from the record the voltage came from", () => {
  const at = (v, boot, ms) => ({ v, ts: NOW, boot, ms });
  assert.equal(sameRecord(at(1, 12, 1000), at(2, 12, 1000)), true);
  assert.equal(sameRecord(at(1, 12, 1000), at(1, 12, 2000)), false);
  assert.equal(sameRecord(at(1, 12, 1000), at(1, 13, 1000)), false);
  assert.equal(sameRecord(undefined, at(1, 12, 1000)), false);
  assert.equal(sameRecord(at(1, 12, 1000), undefined), false);

  assert.equal(latestBattery({}), null);
  assert.equal(latestBattery({ engine_on: at(1, 12, 1000) }), null);
  assert.equal(latestBattery({ adapter_v: at(12.1, 12, 1000), engine_on: at(1, 12, 1000) }), "engine on, not charging");
  assert.equal(latestBattery({ adapter_v: at(12.1, 12, 1000), engine_on: at(0, 12, 1000) }), "engine off");
  // A newer record without a voltage holds the engine flag. The RPM of the voltage's own record decides.
  assert.equal(latestBattery({ adapter_v: at(12.1, 12, 1000), engine_on: at(0, 12, 2000), rpm: at(900, 12, 1000) }), "engine on, not charging");
  assert.equal(latestBattery({ adapter_v: at(12.1, 12, 1000), engine_on: at(1, 12, 2000), rpm: at(0, 12, 1000) }), "engine off");
  assert.equal(latestBattery({ adapter_v: at(12.1, 12, 1000), engine_on: at(1, 12, 2000) }), "engine off");
  assert.equal(latestBattery({ adapter_v: at(14.2, 12, 1000) }), "charging");
  assert.equal(latestBattery({ adapter_v: at(11.7, 12, 1000), engine_on: at(1, 12, 1000) }), "low");
});

test("powerUpBattery: the voltage of a quiet first reading under 13.0 V, else null", () => {
  // Flags: 1 engine on, 2 quiet, 4 no adapter link.
  assert.equal(powerUpBattery({ adapter_v: 12.3, rpm: null, flags: 2 }), 12.3);
  assert.equal(powerUpBattery({ adapter_v: 12.3, rpm: 0, flags: 0 }), 12.3);
  assert.equal(powerUpBattery({ adapter_v: 14.1, rpm: null, flags: 2 }), null); // a charger, or the alternator
  assert.equal(powerUpBattery({ adapter_v: 13.0, rpm: null, flags: 2 }), null);
  assert.equal(powerUpBattery({ adapter_v: 12.3, rpm: 750, flags: 1 }), null); // the engine already runs
  assert.equal(powerUpBattery({ adapter_v: 12.3, rpm: 750, flags: 0 }), null);
  assert.equal(powerUpBattery({ adapter_v: 12.3, rpm: null, flags: 1 }), null);
  assert.equal(powerUpBattery({ adapter_v: 12.3, rpm: null, flags: 4 }), null); // without the link nothing is known
  assert.equal(powerUpBattery({ adapter_v: null, rpm: null, flags: 2 }), null);
});

// ------------------------------------------------------------ local days

test("parseDay and dateOfDay", () => {
  assert.equal(dateOfDay(parseDay("2026-11-05")), "2026-11-05");
  assert.equal(parseDay("2026-11-06") - parseDay("2026-11-05"), 1);
  assert.equal(parseDay("2028-02-29") - parseDay("2028-02-28"), 1);
  for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-1-5", "11/05/2026", "yesterday", "", 20261105, null, undefined, {}]) {
    assert.equal(parseDay(bad), null, String(bad));
  }
});

test("tzOffset and localDay in Los Angeles", () => {
  assert.equal(tzOffset(LA, utc(2026, 1, 15, 12)), -8 * H);
  assert.equal(tzOffset(LA, utc(2026, 7, 15, 12)), -7 * H);
  assert.equal(tzOffset("UTC", utc(2026, 7, 15, 12)), 0);
  // 2026-11-11 23:59:59 PST and the second after.
  assert.equal(dateOfDay(localDay(LA, utc(2026, 11, 12, 7, 59, 59))), "2026-11-11");
  assert.equal(dateOfDay(localDay(LA, utc(2026, 11, 12, 8))), "2026-11-12");
});

test("dayStart: 2026-03-08 is 23 hours long in Los Angeles", () => {
  const d = parseDay("2026-03-08");
  assert.equal(dayStart(LA, d - 1), utc(2026, 3, 7, 8)); // PST
  assert.equal(dayStart(LA, d), utc(2026, 3, 8, 8)); // still PST at midnight, clocks jump at 02:00
  assert.equal(dayStart(LA, d + 1), utc(2026, 3, 9, 7)); // PDT
  assert.equal(dayStart(LA, d + 1) - dayStart(LA, d), 23 * H);
  assert.equal(dayStart(LA, d) - dayStart(LA, d - 1), 24 * H);
  assert.equal(dayStart(LA, d + 2) - dayStart(LA, d + 1), 24 * H);
  // The last second before each start belongs to the day before.
  for (const day of [d - 1, d, d + 1, d + 2]) {
    assert.equal(localDay(LA, dayStart(LA, day)), day);
    assert.equal(localDay(LA, dayStart(LA, day) - 1), day - 1);
  }
});

test("dayStart: 2026-11-01 is 25 hours long in Los Angeles", () => {
  const d = parseDay("2026-11-01");
  assert.equal(dayStart(LA, d), utc(2026, 11, 1, 7)); // PDT
  assert.equal(dayStart(LA, d + 1), utc(2026, 11, 2, 8)); // PST
  assert.equal(dayStart(LA, d + 1) - dayStart(LA, d), 25 * H);
  assert.equal(dayStart(LA, d) - dayStart(LA, d - 1), 24 * H);
  assert.equal(dayStart(LA, d + 2) - dayStart(LA, d + 1), 24 * H);
  for (const day of [d - 1, d, d + 1, d + 2]) {
    assert.equal(localDay(LA, dayStart(LA, day)), day);
    assert.equal(localDay(LA, dayStart(LA, day) - 1), day - 1);
  }
});

test("dayStart: zones east of UTC and a zone without clock changes", () => {
  // Sydney leaves daylight time on 2026-04-05 at 03:00 local, which is the day before in UTC.
  const syd = parseDay("2026-04-05");
  assert.equal(dayStart("Australia/Sydney", syd), utc(2026, 4, 4, 13));
  assert.equal(dayStart("Australia/Sydney", syd + 1), utc(2026, 4, 5, 14));
  assert.equal(dayStart("Australia/Sydney", syd + 1) - dayStart("Australia/Sydney", syd), 25 * H);
  const ber = parseDay("2026-03-29");
  assert.equal(dayStart("Europe/Berlin", ber), utc(2026, 3, 28, 23));
  assert.equal(dayStart("Europe/Berlin", ber + 1) - dayStart("Europe/Berlin", ber), 23 * H);
  assert.equal(dayStart("UTC", ber), utc(2026, 3, 29));
  assert.equal(dayStart("America/Phoenix", ber), utc(2026, 3, 29, 7));
});

test("offsetSpans: cut exactly where the clocks change", () => {
  const mar = parseDay("2026-03-08");
  const a = dayStart(LA, mar - 1), b = dayStart(LA, mar + 2);
  assert.deepEqual(offsetSpans(LA, a, b), [
    { from: a, to: utc(2026, 3, 8, 10), offset: -8 * H }, // 02:00 PST is 10:00 UTC
    { from: utc(2026, 3, 8, 10), to: b, offset: -7 * H },
  ]);
  const nov = parseDay("2026-11-01");
  const c = dayStart(LA, nov - 1), d = dayStart(LA, nov + 2);
  assert.deepEqual(offsetSpans(LA, c, d), [
    { from: c, to: utc(2026, 11, 1, 9), offset: -7 * H }, // 02:00 PDT is 09:00 UTC
    { from: utc(2026, 11, 1, 9), to: d, offset: -8 * H },
  ]);
});

test("offsetSpans: a year has three parts, a quiet week has one, a change at the open end is not a cut", () => {
  const y0 = dayStart(LA, parseDay("2026-01-01")), y1 = dayStart(LA, parseDay("2027-01-01"));
  const year = offsetSpans(LA, y0, y1);
  assert.deepEqual(year.map((s) => s.offset), [-8 * H, -7 * H, -8 * H]);
  assert.equal(year[0].from, y0);
  assert.equal(year[2].to, y1);
  assert.equal(year[0].to, year[1].from);
  assert.equal(year[1].to, year[2].from);
  const w0 = dayStart(LA, parseDay("2026-06-01"));
  assert.deepEqual(offsetSpans(LA, w0, w0 + 7 * 86400), [{ from: w0, to: w0 + 7 * 86400, offset: -7 * H }]);
  assert.deepEqual(offsetSpans(LA, utc(2026, 3, 8, 8), utc(2026, 3, 8, 10)), [
    { from: utc(2026, 3, 8, 8), to: utc(2026, 3, 8, 10), offset: -8 * H },
  ]);
  assert.equal(offsetSpans("UTC", y0, y1).length, 1);
});

test("dayExpr: SQLite puts every minute in the same local day as the zone's own calendar", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE m (t INTEGER NOT NULL)");
  for (const [first, last] of [["2026-03-06", "2026-03-11"], ["2026-10-30", "2026-11-04"], ["2026-06-01", "2026-06-03"]]) {
    const start = dayStart(LA, parseDay(first)), end = dayStart(LA, parseDay(last) + 1);
    db.exec("DELETE FROM m");
    const ins = db.prepare("INSERT INTO m (t) VALUES (?)");
    // Every 7 minutes, plus the minutes on both sides of each local midnight and each clock change.
    const ts = new Set();
    for (let t = start; t < end; t += 420) ts.add(t);
    for (let day = parseDay(first); day <= parseDay(last); day++) {
      ts.add(dayStart(LA, day));
      ts.add(dayStart(LA, day + 1) - 60);
    }
    const spans = offsetSpans(LA, start, end);
    for (const s of spans) { ts.add(s.from); ts.add(s.to - 60); }
    for (const t of ts) ins.run(t);

    const sql = dayExpr("t", spans);
    assert.match(sql, /^[-+*/<() 0-9A-Zt]+$/); // integer literals only, nothing bound
    const rows = db.prepare(`SELECT t, ${sql} AS day FROM m ORDER BY t`).all();
    assert.equal(rows.length, ts.size);
    for (const r of rows) assert.equal(dateOfDay(r.day), dateOfDay(localDay(LA, r.t)), `t=${r.t}`);

    // Grouped, the short and the long day show up as 23 and 25 hours of minutes.
    db.exec("DELETE FROM m");
    for (let t = start; t < end; t += 60) ins.run(t);
    const perDay = db.prepare(`SELECT ${sql} AS day, COUNT(*) AS n FROM m GROUP BY 1 ORDER BY 1`).all();
    const hours = Object.fromEntries(perDay.map((r) => [dateOfDay(r.day), r.n / 60]));
    assert.equal(perDay.length, parseDay(last) - parseDay(first) + 1);
    for (const [date, h] of Object.entries(hours)) {
      assert.equal(h, date === "2026-03-08" ? 23 : date === "2026-11-01" ? 25 : 24, date);
    }
  }
  db.close();
});

test("dayExpr refuses anything that is not a whole number", () => {
  assert.throws(() => dayExpr("t", [{ from: 0, to: 10, offset: 0.5 }]));
  assert.throws(() => dayExpr("t", [{ from: 0, to: 1.5, offset: 0 }, { from: 1.5, to: 3, offset: 0 }]));
  assert.equal(dayExpr("t", [{ from: 0, to: 10, offset: -28800 }]), "(t + -28800) / 86400");
});

test("resolveWindow: named periods in Los Angeles", () => {
  const now = utc(2026, 11, 11, 20); // 12:00 PST on Wednesday 2026-11-11
  const win = (a) => {
    const w = resolveWindow(LA, now, a);
    assert.equal("error" in w, false, JSON.stringify(w));
    return { from: dateOfDay(w.from_day), to: dateOfDay(w.to_day), hours: (w.end - w.start) / H, start: w.start };
  };
  assert.deepEqual(win({ period: "today" }), { from: "2026-11-11", to: "2026-11-11", hours: 24, start: utc(2026, 11, 11, 8) });
  assert.deepEqual(win({ period: "yesterday" }), { from: "2026-11-10", to: "2026-11-10", hours: 24, start: utc(2026, 11, 10, 8) });
  assert.deepEqual(win({ period: "last_7_days" }), { from: "2026-11-05", to: "2026-11-11", hours: 7 * 24, start: utc(2026, 11, 5, 8) });
  assert.deepEqual(win({}), win({ period: "last_7_days" }));
  // 30 days that include the 25-hour day.
  assert.deepEqual(win({ period: "last_30_days" }), { from: "2026-10-13", to: "2026-11-11", hours: 30 * 24 + 1, start: utc(2026, 10, 13, 7) });
  assert.deepEqual(win({ period: "this_month" }), { from: "2026-11-01", to: "2026-11-11", hours: 11 * 24 + 1, start: utc(2026, 11, 1, 7) });
  assert.deepEqual(win({ period: "last_month" }), { from: "2026-10-01", to: "2026-10-31", hours: 31 * 24, start: utc(2026, 10, 1, 7) });
  // Both clock changes cancel out over the year so far.
  assert.deepEqual(win({ period: "this_year" }), { from: "2026-01-01", to: "2026-11-11", hours: 315 * 24, start: utc(2026, 1, 1, 8) });
});

test("resolveWindow: today is the local date, and last_month crosses the year", () => {
  // 21:00 PST on the 11th is already the 12th in UTC.
  const late = resolveWindow(LA, utc(2026, 11, 12, 5), { period: "today" });
  assert.equal(dateOfDay(late.from_day), "2026-11-11");
  const jan = resolveWindow(LA, utc(2027, 1, 10, 20), { period: "last_month" });
  assert.deepEqual([dateOfDay(jan.from_day), dateOfDay(jan.to_day)], ["2026-12-01", "2026-12-31"]);
  const mar = resolveWindow(LA, utc(2028, 3, 15, 20), { period: "last_month" });
  assert.deepEqual([dateOfDay(mar.from_day), dateOfDay(mar.to_day)], ["2028-02-01", "2028-02-29"]);
});

test("resolveWindow: from and to dates", () => {
  const now = utc(2026, 11, 11, 20);
  const w = resolveWindow(LA, now, { from: "2026-03-07", to: "2026-03-09" });
  assert.deepEqual(w, { from_day: parseDay("2026-03-07"), to_day: parseDay("2026-03-09"), start: utc(2026, 3, 7, 8), end: utc(2026, 3, 10, 7) });
  // `to` defaults to today.
  const open = resolveWindow(LA, now, { from: "2026-11-09" });
  assert.deepEqual([dateOfDay(open.from_day), dateOfDay(open.to_day)], ["2026-11-09", "2026-11-11"]);
  // 366 days is the most that is allowed.
  assert.equal("error" in resolveWindow(LA, now, { from: "2025-11-11", to: "2026-11-11" }), false);
});

test("resolveWindow: bad input comes back as text, never as an exception", () => {
  const now = utc(2026, 11, 11, 20);
  const err = (a, re) => {
    const w = resolveWindow(LA, now, a);
    assert.equal(w.bad_input, true, JSON.stringify(a));
    assert.match(w.error, re);
  };
  err({ from: "2026-02-30", to: "2026-03-01" }, /from is not a calendar date.*YYYY-MM-DD/);
  err({ from: "2026-03-01", to: "next week" }, /to is not a calendar date/);
  err({ from: 20260301 }, /from is not a calendar date/);
  err({ to: "2026-03-01" }, /needs a from date/);
  err({ from: "2026-03-05", to: "2026-03-01" }, /is after to/);
  err({ from: "2026-12-01" }, /in the future/);
  err({ period: "today", from: "2026-03-01" }, /not both/);
  err({ period: "last_week" }, /Unknown period.*last_7_days/);
  err({ period: 7 }, /Unknown period/);
  err({ from: "2025-11-10", to: "2026-11-11" }, /367 days.*366/);
});

test("fmtTime: local time plus ISO, and an unknown zone falls back to UTC", () => {
  const env = { LOCAL_TZ: LA };
  const s = fmtTime(env, utc(2026, 11, 11, 20, 30));
  assert.match(s, /Wed, Nov 11, 2026/);
  assert.match(s, /12:30/);
  assert.match(s, /PST \(2026-11-11T20:30:00\.000Z\)$/);
  assert.equal(fmtTime(env, utc(2026, 11, 11, 20, 30)), s);
  assert.match(fmtTime(env, utc(2026, 7, 4, 19)), /PDT/);
  assert.equal(fmtTime(env, 0), null);
  assert.equal(fmtTime(env, null), null);
  assert.match(fmtTime({ LOCAL_TZ: "Mars/Olympus" }, utc(2026, 11, 11, 20, 30)), /8:30.*UTC/);
  assert.match(fmtTime({ LOCAL_TZ: "" }, utc(2026, 11, 11, 20, 30)), /UTC/);
});

// ------------------------------------------------------------ trips

const agg = (over = {}) => ({
  boot: 12, start_ts: NOW - 3600, end_ts: NOW - 1800, km: 16.0934, maf_g: 0.5 * 14.1 * 2798.7,
  engine_s: 1500, moving_s: 1200, max_kph: 113, max_rpm: 5200, max_coolant: 96, avg_rpm: 1850.4, est: 0,
  odo_start: 12671.1, odo_end: 12687.3, fw: 2, nolink_n: 3, ...over,
});

test("the fuel constant is E10", () => {
  assert.equal(CAR.AFR, 14.1);
  assert.equal(CAR.G_PER_GAL, 2798.7);
  assert.deepEqual(CAR.EPA, { city: 16, highway: 24, combined: 19 });
  assert.equal(CAR.TANK_GAL, 18.5);
  assert.equal(CAR.KM_TO_MI, 0.621371);
});

test("tripNumbers: every field of the dashboard shape", () => {
  assert.deepEqual(tripNumbers(agg()), {
    id: 12, start_ts: NOW - 3600, end_ts: NOW - 1800, duration_s: 1800, engine_s: 1500, moving_s: 1200,
    miles: 10, gallons: 0.5, mpg: 20, avg_mph: 30, max_mph: 70, max_rpm: 5200, avg_rpm: 1850, max_coolant_f: 204.8,
    est: false, odo_miles: 10.1, unlogged_before_mi: null, unlogged_known: false, fw: 2, nolink_n: 3, gps_miles: null,
  });
});

test("tripNumbers: aggregates from the minutes table and odd odometer values", () => {
  const m = tripNumbers(agg({ odo_start: null, odo_end: null, fw: 0, nolink_n: 0, est: 1 }));
  assert.equal(m.odo_miles, null);
  assert.equal(m.fw, 0);
  assert.equal(m.nolink_n, 0);
  assert.equal(m.est, true);
  assert.equal(tripNumbers(agg({ odo_start: 12671.1, odo_end: null })).odo_miles, null);
  assert.equal(tripNumbers(agg({ odo_start: 12671.1, odo_end: 12671.1 })).odo_miles, 0);
  assert.equal(tripNumbers(agg({ odo_start: 12671.1, odo_end: 12000 })).odo_miles, null); // went backwards
  // A row read before the schema change has no such columns at all.
  const old = tripNumbers(agg({ odo_start: undefined, odo_end: undefined, fw: undefined, nolink_n: undefined }));
  assert.deepEqual([old.odo_miles, old.fw, old.nolink_n], [null, 0, 0]);
  const empty = tripNumbers(agg({ km: null, maf_g: null, engine_s: null, moving_s: null, max_kph: null, avg_rpm: null, max_coolant: null }));
  assert.deepEqual([empty.miles, empty.gallons, empty.mpg, empty.avg_mph, empty.max_mph, empty.avg_rpm, empty.max_coolant_f],
    [0, 0, null, null, null, null, null]);
});

test("unloggedMiles: needs both readings and more than 0.3 km", () => {
  const gap = (end, start) => unloggedMiles({ odo_end: end }, { odo_start: start });
  assert.equal(gap(12671.1, 12671.1), null);
  assert.equal(gap(12671.1, 12671.2), null);
  assert.equal(gap(100, 100.3), null); // 0.30000000000000426 in floating point
  assert.equal(gap(12671.1, 12671.4), null);
  assert.equal(gap(12671.1, 12671.5), 0.2); // 0.4 km
  assert.equal(gap(12671.1, 12687.2), 10); // 16.1 km
  assert.equal(gap(12671.1, 12600), null); // another board or a reset, not a drive
  assert.equal(gap(null, 12671.5), null);
  assert.equal(gap(12671.1, null), null);
  assert.equal(unloggedMiles(null, { odo_start: 12671.5 }), null);
  assert.equal(unloggedMiles(undefined, { odo_start: 12671.5 }), null);
});

test("tripNumbersList: fills the gap from the trip before, in any order", () => {
  const a = agg({ boot: 10, start_ts: 1000, end_ts: 2000, odo_start: 100, odo_end: 110 });
  const b = agg({ boot: 11, start_ts: 3000, end_ts: 4000, odo_start: 110.1, odo_end: 120 }); // no gap
  const c = agg({ boot: 12, start_ts: 5000, end_ts: 6000, odo_start: 152.2, odo_end: 160 }); // 32.2 km missing
  const d = agg({ boot: 13, start_ts: 7000, end_ts: 8000, odo_start: null, odo_end: null }); // car never answered
  const e = agg({ boot: 14, start_ts: 9000, end_ts: 9500, odo_start: 170, odo_end: 171 }); // previous end unknown
  const newestFirst = tripNumbersList([e, d, c, b, a]);
  assert.deepEqual(newestFirst.map((t) => t.id), [14, 13, 12, 11, 10]);
  assert.deepEqual(newestFirst.map((t) => t.unlogged_before_mi), [null, null, 20, null, null]);
  const oldestFirst = tripNumbersList([a, b, c, d, e]);
  assert.deepEqual(oldestFirst.map((t) => t.unlogged_before_mi), [null, null, 20, null, null]);
  // The oldest trip in a list has no predecessor there, so it stays null.
  assert.deepEqual(tripNumbersList([c]).map((t) => t.unlogged_before_mi), [null]);
  assert.deepEqual(tripNumbersList([c, b]).map((t) => t.unlogged_before_mi), [20, null]);
  assert.deepEqual(tripNumbersList([]), []);
  // The rest of each item is exactly tripNumbers.
  assert.deepEqual({ ...newestFirst[2], unlogged_before_mi: null, unlogged_known: false }, tripNumbers(c));
});

test("tripNumbersList and unloggedTotal: a missing reading is unknown, not zero", () => {
  const a = agg({ boot: 10, start_ts: 1000, end_ts: 2000, odo_start: 100, odo_end: 110 });
  const b = agg({ boot: 11, start_ts: 3000, end_ts: 4000, odo_start: 110.1, odo_end: 120 }); // no gap
  const c = agg({ boot: 12, start_ts: 5000, end_ts: 6000, odo_start: 152.2, odo_end: 160 }); // 32.2 km missing
  const d = agg({ boot: 13, start_ts: 7000, end_ts: 8000, odo_start: null, odo_end: null }); // car never answered
  const e = agg({ boot: 14, start_ts: 9000, end_ts: 9500, odo_start: 170, odo_end: 171 }); // previous end unknown
  const list = tripNumbersList([e, d, c, b, a]);
  // The oldest one has no predecessor in the list, so the list alone cannot know its gap.
  assert.deepEqual(list.map((t) => t.unlogged_known), [false, false, true, true, false]);
  assert.equal(unloggedTotal([list[2], list[3]]), 20);
  assert.equal(unloggedTotal([list[3]]), 0);
  assert.equal(unloggedTotal([]), 0);
  assert.equal(unloggedTotal([list[0], list[2]]), null);
  assert.equal(unloggedTotal([list[1], list[2], list[3]]), null);
  // When the total is unknown, the known gaps still give a floor.
  assert.equal(unloggedAtLeast([list[1], list[2], list[3]]), 20);
  assert.equal(unloggedAtLeast([list[0], list[1], list[3]]), null); // nothing known is missing
  assert.equal(unloggedAtLeast([list[2], list[3]]), null); // the total is known: 20
  assert.equal(unloggedAtLeast([]), null);
});

test("odometerSpanMiles: first reading to last in time order, null when an end is missing or it went back", () => {
  const t = (start_ts, odo_start, odo_end) => ({ start_ts, odo_start, odo_end });
  // Newest first or oldest first, the span runs from the oldest reading to the newest.
  const three = [t(3000, 1100, 1116.1), t(2000, null, null), t(1000, 1000, 1016.1)];
  assert.equal(odometerSpanMiles(three), 72.1); // 116.1 km
  assert.equal(odometerSpanMiles([...three].reverse()), 72.1);
  // A trip at either end without a reading: the nearest reading inside counts.
  assert.equal(odometerSpanMiles([t(1000, null, null), t(2000, 1000, 1016.1), t(3000, 1050, null)]), 10);
  assert.equal(odometerSpanMiles([t(1000, 1000, 1000)]), 0);
  assert.equal(odometerSpanMiles([t(1000, null, null)]), null);
  assert.equal(odometerSpanMiles([t(1000, 1000, null)]), null);
  assert.equal(odometerSpanMiles([]), null);
  // Backwards is another odometer or a reset, not a distance.
  assert.equal(odometerSpanMiles([t(1000, 1000, 1016.1), t(2000, 500, 510)]), null);
});

test("tripLabel and parseTripId: the full number and the dashboard label name the same trip", () => {
  assert.equal(tripLabel(12), "12");
  assert.equal(tripLabel(65535), "65535");
  assert.equal(tripLabel(65536), "1-0");
  assert.equal(tripLabel(11337740), "173-12");
  assert.equal(tripLabel(255 * 65536 + 65535), "255-65535");
  for (const id of [0, 12, 65535, 65536, 11337740, 255 * 65536 + 65535]) assert.equal(parseTripId(tripLabel(id)), id);
  assert.equal(parseTripId(11337740), 11337740);
  assert.equal(parseTripId("11337740"), 11337740);
  assert.equal(parseTripId(" 173-12 "), 11337740);
  // Nothing a real label cannot hold, so a typo cannot land on another trip.
  for (const bad of ["0-12", "256-12", "173-65536", "173-", "-12", "173-12-1", "173 12", "173.5-12", "Trip", "", -3, 1.5, null, undefined, {}, [173, 12], true]) {
    assert.equal(parseTripId(bad), null, JSON.stringify(bad));
  }
});

test("clampInt: defaults, limits and numbers sent as strings", () => {
  assert.equal(clampInt(undefined, 10, 1, 50), 10);
  assert.equal(clampInt(null, 10, 1, 50), 10);
  assert.equal(clampInt("abc", 10, 1, 50), 10);
  assert.equal(clampInt(NaN, 10, 1, 50), 10);
  assert.equal(clampInt({}, 10, 1, 50), 10);
  assert.equal(clampInt(5, 10, 1, 50), 5);
  assert.equal(clampInt("5", 10, 1, 50), 5);
  assert.equal(clampInt(7.9, 10, 1, 50), 7);
  assert.equal(clampInt(0, 10, 1, 50), 1);
  assert.equal(clampInt(500, 10, 1, 50), 50);
});

// ------------------------------------------------------------ MCP envelope

// No database behind this env: a call that reached one would fail with a TypeError text.
const env = { LOCAL_TZ: LA };
const mcpRaw = async (text, e = env) => {
  const res = await handleMcp(new Request("http://localhost/mcp/x", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: text,
  }), e);
  return { status: res.status, json: res.status === 202 ? null : await res.json() };
};
const mcp = (body, e) => mcpRaw(JSON.stringify(body), e);
const call = async (name, args, e) =>
  (await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, e)).json.result;

test("tools/list: six tools, each with a title and the read-only annotations", async () => {
  const { json } = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = json.result.tools;
  assert.deepEqual(tools.map((t) => t.name),
    ["get_latest_status", "get_location", "get_trip_summary", "list_trips", "get_fuel_economy", "get_history"]);
  for (const t of tools) {
    assert.ok(typeof t.title === "string" && t.title.length > 0, t.name);
    assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, t.name);
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.ok(t.description.length > 80, t.name);
    assert.equal("run" in t, false);
  }
  const props = (name) => Object.keys(tools.find((t) => t.name === name).inputSchema.properties);
  assert.deepEqual(props("get_trip_summary"), ["trip_id", "include_locations"]);
  assert.deepEqual(props("list_trips"), ["limit", "from", "to"]);
  assert.deepEqual(props("get_history"), ["period", "from", "to", "group_by"]);
  // Fuel figures are estimates, and the descriptions have to say so.
  for (const name of ["get_trip_summary", "list_trips", "get_fuel_economy", "get_history", "get_latest_status"]) {
    assert.match(tools.find((t) => t.name === name).description, /estimate/, name);
  }
});

test("tools/list: descriptions promise no more than the code does", async () => {
  const { json } = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tool = (name) => json.result.tools.find((t) => t.name === name);
  // Nothing has measured how close the airflow figures are.
  assert.doesNotMatch(tool("get_fuel_economy").description, /few percent/);
  assert.match(tool("get_fuel_economy").description, /not been checked against a fill-up/);
  assert.match(tool("get_fuel_economy").description, /combined_mpg_few_miles \(true when that figure rests on fewer than 25 logged miles/);
  // yesterday and last_month end before today.
  assert.doesNotMatch(tool("get_history").inputSchema.properties.period.description, /ending today/);
  assert.match(tool("get_history").description, /data_starts/);
  // A trip can be named by its number or by the label the dashboard shows.
  const tripId = tool("get_trip_summary").inputSchema.properties.trip_id;
  assert.deepEqual(tripId.type, ["integer", "string"]);
  assert.match(tripId.description, /173-12/);
  for (const name of ["get_trip_summary", "list_trips"]) assert.match(tool(name).description, /label/, name);
  // A status question must not lead to a location call.
  assert.match(tool("get_location").description, /only when the user asks/);
  assert.match(tool("get_latest_status").description, /Returns no position\.$/);
  assert.doesNotMatch(tool("get_latest_status").description, /get_location/);
  // What a trip is reaches clients that never show the instructions.
  assert.match(tool("list_trips").description, /an engine start without driving is listed too/);
});

test("tools/list: every field the answers carry is named in the description", async () => {
  const { json } = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const description = (name) => json.result.tools.find((t) => t.name === name).description;
  const fields = {
    get_latest_status: ["battery_note", "engine_values_as_of", "engine_values_stale", "odometer_as_of", "cell_signal_dbm",
      "firmware_build 0", "range_basis", "\"engine on, not charging\"", "engine off", "low"],
    get_location: ["fix_before_last_report_min", "parked"],
    get_trip_summary: ["newer_sessions_without_driving", "end_not_received", "times_estimated", "gps_distance_mi", "in_progress"],
    list_trips: ["end_not_received", "times_estimated", "gps_distance_mi", "more_trips_exist"],
    get_fuel_economy: ["combined_mpg_few_miles", "get_history"],
    get_history: ["odometer_distance_mi", "unlogged_mi_at_least", "mpg_est_few_miles", "gps_distance_mi", "get_fuel_economy"],
  };
  for (const [name, words] of Object.entries(fields)) {
    for (const w of words) assert.ok(description(name).includes(w), `${name} names ${w}`);
  }
});

test("initialize: instructions give the real upload period", async () => {
  const { json } = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(json.result.protocolVersion, "2025-06-18");
  assert.match(json.result.instructions, /about every 15 s/);
  assert.doesNotMatch(json.result.instructions, /30 s/);
  assert.match(json.result.instructions, /an engine start without driving is a trip too/);
  assert.match(json.result.instructions, /position only when the user asks/);
  assert.match(json.result.instructions, /Range is an estimate/);
});

test("messages that are not objects are rejected with -32600", async () => {
  for (const body of [42, "hello", null, true, []]) {
    const r = await mcp(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.deepEqual(r.json, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  }
  // Inside a batch only the bad entries fail.
  const batch = await mcp([7, { jsonrpc: "2.0", id: 5, method: "ping" }, null, [1]]);
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.json.map((m) => m.error?.code ?? "ok"), [-32600, "ok", -32600, -32600]);
  assert.deepEqual(batch.json[1], { jsonrpc: "2.0", id: 5, result: {} });
});

test("the rest of the JSON-RPC handling is unchanged", async () => {
  const torn = await mcpRaw("{not json");
  assert.equal(torn.status, 400);
  assert.equal(torn.json.error.code, -32700);
  assert.equal((await mcp({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  assert.equal((await mcp({ jsonrpc: "2.0", id: 2, method: "nope" })).json.error.code, -32601);
  assert.equal((await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } })).json.error.code, -32602);
  assert.deepEqual((await mcp({ jsonrpc: "2.0", id: 4, method: "ping" })).json, { jsonrpc: "2.0", id: 4, result: {} });
});

test("wrong tool arguments give an error text for the model before any query runs", async () => {
  const cases = [
    ["get_history", { from: "last tuesday" }, /from is not a calendar date/],
    ["get_history", { from: "2020-01-01", to: "2026-01-01" }, /The limit is 366/],
    ["get_history", { period: "today", from: "2026-11-01" }, /not both/],
    ["get_history", { period: "fortnight" }, /Unknown period/],
    ["get_history", { group_by: "week" }, /group_by can only be "day"/],
    ["list_trips", { from: "11/01/2026" }, /from is not a calendar date/],
    ["list_trips", { to: "2026-02-30" }, /to is not a calendar date/],
    ["list_trips", { from: "2026-11-05", to: "2026-11-01" }, /is after to/],
    ["get_trip_summary", { trip_id: "latest" }, /trip_id must be a whole number/],
    ["get_trip_summary", { trip_id: -3 }, /trip_id must be a whole number/],
    ["get_trip_summary", { trip_id: 1.5 }, /trip_id must be a whole number/],
    ["get_trip_summary", { trip_id: "0-12" }, /trip_id must be a whole number or a label like "173-12".*not "0-12"/],
    ["get_trip_summary", { trip_id: "173-65536" }, /trip_id must be a whole number or a label/],
  ];
  for (const [name, args, re] of cases) {
    const r = await call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(r.content[0].text, /^Error: /);
    assert.match(r.content[0].text, re);
  }
});

test("a tool call that throws is logged, wrong arguments are not", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  // No database behind this env, so the first query throws.
  const r = await call("get_latest_status", {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Error: /);
  assert.equal(logged.mock.callCount(), 1);
  const args = logged.mock.calls[0].arguments;
  assert.deepEqual(args.slice(0, 2), ["mcp tool failed", "get_latest_status"]);
  assert.ok(args[2] instanceof Error);
  // The model can fix a wrong argument by itself. That is not a failure worth a log line.
  assert.equal((await call("get_history", { period: "fortnight" })).isError, true);
  assert.equal(logged.mock.callCount(), 1);
});

// ------------------------------------------------------------ tools against a database

const MILE_KM = 1 / 0.621371;
const mafOf = (gallons) => gallons * 14.1 * 2798.7;

// One session at a steady mile per minute, written to `trips` and `minutes` the way ingest leaves them.
// `idle`: the engine runs the whole time, but the car does not move.
function addSession(e, { boot, start, minutes, mpg = 20, engine = true, idle = false, max_kph = 100, max_rpm = 3000, odo = [null, null], fw = 2, nolink_n = 0 }) {
  const drives = engine && !idle;
  const km = drives ? MILE_KM : 0, maf = drives ? mafOf(1 / mpg) : engine ? mafOf(0.005) : 0, eng = engine ? 60 : 0, mov = drives ? 50 : 0;
  const kph = drives ? max_kph : engine ? 0 : null;
  const db = e.DB.sqlite;
  db.prepare(
    `INSERT INTO trips (boot, start_ts, end_ts, last_ms, n, engine_n, km, maf_g, engine_s, moving_s, max_kph, max_rpm,
       max_coolant, rpm_sum, rpm_n, est, odo_start, odo_end, fw, nolink_n) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(boot, start, start + minutes * 60 - 1, minutes * 60000, minutes * 60, eng * minutes, km * minutes, maf * minutes,
    eng * minutes, mov * minutes, kph, engine ? max_rpm : null, engine ? 95 : null,
    engine ? 2000 * 60 * minutes : 0, engine ? 60 * minutes : 0, 0, odo[0], odo[1], fw, nolink_n);
  const ins = db.prepare(
    `INSERT INTO minutes (t, boot, n, engine_n, gps_n, km, maf_g, engine_s, moving_s, spd_max, rpm_max) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let i = 0; i < minutes; i++) {
    ins.run(start + i * 60, boot, 60, eng, 60, km, maf, eng, mov, kph, engine ? max_rpm : null);
  }
}

// Sessions around the night the clocks go back in Los Angeles (2026-11-01, 25 hours long).
// Local times are in the comments. Midnight is 07:00 UTC before the change and 08:00 UTC after.
function carEnv() {
  const e = makeEnv();
  // Oct 31 22:30 to 23:10 PDT.
  addSession(e, { boot: 9, start: utc(2026, 11, 1, 5, 30), minutes: 40, odo: [1000, 1064.4] });
  // Oct 31 23:50 to Nov 1 00:20 PDT: 10 minutes before midnight, 20 after.
  addSession(e, { boot: 10, start: utc(2026, 11, 1, 6, 50), minutes: 30, odo: [1064.4, 1112.7] });
  // Nov 1 01:30 PDT to 01:30 PST: straight through the hour that happens twice.
  addSession(e, { boot: 11, start: utc(2026, 11, 1, 8, 30), minutes: 60, max_kph: 161, max_rpm: 6400, odo: [1112.7, 1209.3] });
  // Nov 1 23:30 to Nov 2 00:15 PST: 30 minutes before midnight, 15 after. With the old offset
  // all of it would land on Nov 2. The odometer is 32.2 km ahead of where trip 11 ended.
  addSession(e, { boot: 12, start: utc(2026, 11, 2, 7, 30), minutes: 45, odo: [1241.5, 1313.9], nolink_n: 4 });
  // Nov 3 12:00 PST, a thrifty one.
  addSession(e, { boot: 13, start: utc(2026, 11, 3, 20), minutes: 20, mpg: 25, odo: [1313.9, 1346.1] });
  // Nov 3 15:00 PST: powered but the engine never ran. Not a trip.
  addSession(e, { boot: 14, start: utc(2026, 11, 3, 23), minutes: 5, engine: false });
  // Nov 3 15:30 PST: one mile, too short to be a best or worst trip.
  addSession(e, { boot: 15, start: utc(2026, 11, 3, 23, 30), minutes: 1, mpg: 50, odo: [1346.2, 1347.8] });
  return e;
}

const setLatest = (e, latest) =>
  e.DB.sqlite.prepare("INSERT OR REPLACE INTO latest (id, json) VALUES (1, ?)").run(JSON.stringify(latest));

// The newest record of a drive, as ingest stores it.
function drivingLatest(now, boot = 13, over = {}) {
  const at = { ts: now - 5, boot, ms: 600000 };
  const vals = {
    engine_on: 1, link: 1, fw: 2, rpm: 1500, speed_kph: 88, coolant_c: 90.5, intake_c: 31, fuel_pct: 50, adapter_v: 12.1,
    ecu_v: 12, odo_km: 12671.1, csq: 21, lat: 37.8199, lon: -122.4783, sats: 11, ...over,
  };
  const latest = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, { v, ...at }]));
  latest.last_upload = { v: now - 3, ts: now - 3, boot: 0, ms: 0 };
  return latest;
}

test("get_history: local days across the 25-hour day", async () => {
  const e = carEnv();
  const h = await history(e, { from: "2026-10-31", to: "2026-11-02", group_by: "day" }, utc(2026, 11, 4, 20));
  assert.deepEqual({ ...h.window, starts_at: null, ends_before: null, data_starts: null },
    { from: "2026-10-31", to: "2026-11-02", days: 3, time_zone: LA, starts_at: null, ends_before: null, data_starts: null });
  assert.match(h.window.starts_at, /Oct 31, 2026.*12:00.AM PDT \(2026-10-31T07:00:00\.000Z\)/);
  assert.match(h.window.ends_before, /Nov 3, 2026.*12:00.AM PST \(2026-11-03T08:00:00\.000Z\)/);
  // The first session of this database starts at 22:30 on the first day of the window.
  assert.match(h.window.data_starts, /Oct 31, 2026.*10:30.PM PDT/);
  assert.deepEqual(h.days, [
    { date: "2026-10-31", distance_mi: 50, fuel_used_gal_est: 2.5, mpg_est: 20, engine_on_min: 50, moving_min: 41.7, max_speed_mph: 62, trips: 2 },
    { date: "2026-11-01", distance_mi: 110, fuel_used_gal_est: 5.5, mpg_est: 20, engine_on_min: 110, moving_min: 91.7, max_speed_mph: 100, trips: 3 },
    { date: "2026-11-02", distance_mi: 15, fuel_used_gal_est: 0.75, mpg_est: 20, engine_on_min: 15, moving_min: 12.5, max_speed_mph: 62, trips: 1 },
  ]);
  assert.deepEqual(h.totals, {
    distance_mi: 175, odometer_distance_mi: 195, fuel_used_gal_est: 8.75, mpg_est: 20, mpg_est_few_miles: false,
    engine_on_min: 175, moving_min: 145.8, idle_min: 29.2, max_speed_mph: 100, max_rpm: 6400, days_with_driving: 3,
    trip_count: 4, unlogged_mi: 20,
  });
  // The odometer moved 20 mi more than was logged, and the note says so.
  assert.match(h.note, /The odometer moved 195 mi between the first and last readings in this window\. 175 mi of that were logged from speed readings/);
  assert.doesNotMatch(h.note, /gps_distance_mi/);
  assert.deepEqual(h.trips.map((t) => [t.trip_id, t.distance_mi, t.unlogged_before_mi]), [[12, 45, 20], [11, 60, null], [10, 30, null], [9, 40, null]]);
  assert.deepEqual(Object.keys(h.trips[0]),
    ["trip_id", "label", "start", "logger_on_min", "engine_on_min", "distance_mi", "fuel_used_gal_est", "mpg_est", "unlogged_before_mi"]);
  assert.deepEqual(h.trips.map((t) => t.label), ["12", "11", "10", "9"]);
  assert.equal(h.trips_not_listed, 0);
  assert.doesNotMatch(JSON.stringify(h), /"lat"|"lon"|maps\.google/);
});

test("get_history: local days across the 23-hour day", async () => {
  const e = makeEnv();
  // Mar 7 23:40 PST to Mar 8 00:20 PST, then Mar 8 23:30 to Mar 9 00:30 PDT.
  addSession(e, { boot: 1, start: utc(2026, 3, 8, 7, 40), minutes: 40 });
  addSession(e, { boot: 2, start: utc(2026, 3, 9, 6, 30), minutes: 60 });
  const h = await history(e, { from: "2026-03-07", to: "2026-03-09", group_by: "day" }, utc(2026, 11, 4, 20));
  assert.deepEqual(h.days.map((d) => [d.date, d.distance_mi, d.trips]), [["2026-03-07", 20, 1], ["2026-03-08", 50, 2], ["2026-03-09", 30, 1]]);
  assert.equal(h.totals.distance_mi, 100);
  assert.equal(h.totals.unlogged_mi, null); // no odometer readings at all
  // One day alone gives the same figure as its row.
  const one = await history(e, { from: "2026-03-08", to: "2026-03-08" }, utc(2026, 11, 4, 20));
  assert.equal(one.totals.distance_mi, 50);
  assert.equal(one.totals.trip_count, 2);
  assert.equal("days" in one, false);
});

test("get_history: periods, an edge trip, an empty window and a whole year", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 3, 21); // 13:00 PST on Nov 3
  const today = await history(e, { period: "today" }, now);
  assert.equal(today.window.from, "2026-11-03");
  assert.deepEqual([today.totals.distance_mi, today.totals.fuel_used_gal_est, today.totals.mpg_est], [21, 0.82, 25.6]);
  // 21 logged miles is under the 25 the dashboard asks for, so the figure is rough.
  assert.equal(today.totals.mpg_est_few_miles, true);
  assert.equal(today.totals.days_with_driving, 1);
  assert.deepEqual(today.trips.map((t) => t.trip_id), [15, 13]); // session 14 never had the engine on
  assert.equal(today.totals.unlogged_mi, 0);

  const yesterday = await history(e, { period: "yesterday" }, now);
  assert.equal(yesterday.window.from, "2026-11-02");
  assert.equal(yesterday.totals.distance_mi, 15); // only the part of trip 12 after midnight
  assert.deepEqual(yesterday.trips.map((t) => [t.trip_id, t.distance_mi, t.unlogged_before_mi]), [[12, 45, 20]]);
  assert.equal(yesterday.totals.unlogged_mi, 0); // that gap belongs to the day the trip started

  const week = await history(e, {}, now);
  assert.deepEqual([week.window.from, week.window.to, week.window.days], ["2026-10-28", "2026-11-03", 7]);
  assert.equal(week.totals.distance_mi, 196);
  assert.equal(week.totals.trip_count, 6);

  const empty = await history(e, { from: "2026-01-01", to: "2026-01-31", group_by: "day" }, now);
  assert.deepEqual(empty.totals, {
    distance_mi: 0, odometer_distance_mi: null, fuel_used_gal_est: 0, mpg_est: null, mpg_est_few_miles: false,
    engine_on_min: 0, moving_min: 0, idle_min: 0, max_speed_mph: null, max_rpm: null, days_with_driving: 0, trip_count: 0,
    unlogged_mi: null,
  });
  assert.deepEqual(empty.days, []);
  assert.deepEqual(empty.trips, []);

  // Three offset spans in one statement.
  const year = await history(e, { period: "this_year", group_by: "day" }, now);
  assert.equal(year.window.days, 307);
  assert.equal(year.totals.distance_mi, 196);
  assert.deepEqual(year.days.map((d) => [d.date, d.distance_mi]),
    [["2026-10-31", 50], ["2026-11-01", 110], ["2026-11-02", 15], ["2026-11-03", 21]]);
});

test("get_history reads only the minutes and trips tables", async () => {
  const e = carEnv();
  e.DB.sqlite.exec("DROP TABLE samples; DROP TABLE track; DROP TABLE latest; DROP TABLE boots; DROP TABLE ingests;");
  const before = e.DB.statements;
  const h = await history(e, { from: "2026-10-31", to: "2026-11-02", group_by: "day" }, utc(2026, 11, 4, 20));
  assert.equal(h.totals.distance_mi, 175);
  // Minutes by day, trips in the window, the oldest session of all, the trip before the oldest.
  assert.equal(e.DB.statements - before, 4);
});

test("get_history: a window that begins before the logger's data says where the data starts", async () => {
  const e = carEnv(); // first session: Oct 31 22:30 PDT
  const now = utc(2026, 11, 3, 21);
  // A whole month before the logger existed reads as zero. data_starts is what tells it apart.
  const before = await history(e, { from: "2026-09-01", to: "2026-09-30" }, now);
  assert.equal(before.totals.distance_mi, 0);
  assert.match(before.window.data_starts, /Oct 31, 2026.*10:30.PM PDT \(2026-11-01T05:30:00\.000Z\)/);
  assert.match(before.note, /data only starts at window\.data_starts.*not the same as not driven/);

  const year = await history(e, { period: "this_year" }, now);
  assert.match(year.window.data_starts, /Oct 31, 2026/);
  assert.match(year.note, /data only starts/);

  // A window that lies inside the logged time is answered as before.
  const covered = await history(e, { from: "2026-11-01", to: "2026-11-03" }, now);
  assert.equal("data_starts" in covered.window, false);
  assert.doesNotMatch(covered.note, /data only starts|no data at all/);
  assert.deepEqual(Object.keys(covered.window), ["from", "to", "days", "time_zone", "starts_at", "ends_before"]);

  // A session that never had the engine on still counts as data.
  const idle = makeEnv();
  addSession(idle, { boot: 1, start: utc(2026, 10, 1, 20), minutes: 5, engine: false });
  addSession(idle, { boot: 2, start: utc(2026, 11, 2, 20), minutes: 10 });
  assert.equal("data_starts" in (await history(idle, { from: "2026-11-01", to: "2026-11-03" }, now)).window, false);

  const none = await history(makeEnv(), { period: "last_month" }, now);
  assert.equal(none.window.data_starts, null);
  assert.match(none.note, /no data at all yet/);
});

test("get_history: unlogged_mi is null when a gap in the window is not known", async () => {
  const now = utc(2026, 11, 20, 20);
  const win = { from: "2026-11-10", to: "2026-11-12" };
  // Trip 61 never got an odometer answer. The odometer moved 84 km between its neighbours.
  const e = makeEnv();
  addSession(e, { boot: 60, start: utc(2026, 11, 10, 20), minutes: 10, odo: [1000, 1016] });
  addSession(e, { boot: 61, start: utc(2026, 11, 11, 20), minutes: 10 });
  addSession(e, { boot: 62, start: utc(2026, 11, 12, 20), minutes: 10, odo: [1100, 1116] });
  const h = await history(e, win, now);
  assert.deepEqual(h.trips.map((t) => [t.trip_id, t.unlogged_before_mi]), [[62, null], [61, null], [60, null]]);
  assert.equal(h.totals.unlogged_mi, null);
  assert.match(h.note, /unlogged_mi.*null when that is not known/);
  // No gap here is known to be above 0, so there is no floor either.
  assert.equal("unlogged_mi_at_least" in h.totals, false);
  // The odometer still says how far the car went: 116 km from the first reading to the last.
  assert.equal(h.totals.odometer_distance_mi, 72.1);
  // The day of trip 60 alone has nothing unknown in it: no trip at all came before it.
  assert.equal((await history(e, { from: "2026-11-10", to: "2026-11-10" }, now)).totals.unlogged_mi, 0);
  // The day of trip 62 alone is unknown too, because its predecessor has no reading.
  assert.equal((await history(e, { from: "2026-11-12", to: "2026-11-12" }, now)).totals.unlogged_mi, null);

  // The same three trips with every reading in place: a real gap is summed, no gap is 0.
  const full = makeEnv();
  addSession(full, { boot: 60, start: utc(2026, 11, 10, 20), minutes: 10, odo: [1000, 1016] });
  addSession(full, { boot: 61, start: utc(2026, 11, 11, 20), minutes: 10, odo: [1016, 1032] });
  addSession(full, { boot: 62, start: utc(2026, 11, 12, 20), minutes: 10, odo: [1100, 1116] });
  assert.equal((await history(full, win, now)).totals.unlogged_mi, 42.3); // 68 km
  assert.equal((await history(full, { from: "2026-11-10", to: "2026-11-11" }, now)).totals.unlogged_mi, 0);
});

test("get_history through the MCP endpoint", async () => {
  const e = carEnv();
  const r = await call("get_history", { from: "2026-10-31", to: "2026-11-02", group_by: "day" }, e);
  assert.equal(r.isError, false);
  const h = JSON.parse(r.content[0].text);
  // Compact JSON: indentation would only cost the model context.
  assert.equal(r.content[0].text, JSON.stringify(h));
  assert.doesNotMatch(r.content[0].text, /\n/);
  assert.equal(h.totals.distance_mi, 175);
  assert.equal(h.days.length, 3);
  const bad = await call("get_history", { from: "2026-11-02", to: "2026-10-31" }, e);
  assert.equal(bad.isError, true);
  assert.equal(bad.content[0].text, "Error: from (2026-11-02) is after to (2026-10-31).");
});

test("list_trips: newest first, limit, and unlogged miles", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 4, 20);
  const all = await listTrips(e, {}, now);
  assert.deepEqual(all.trips.map((t) => t.trip_id), [15, 13, 12, 11, 10, 9]);
  assert.equal(all.more_trips_exist, false);
  assert.equal("window" in all, false);
  assert.deepEqual(all.trips.map((t) => t.unlogged_before_mi), [null, null, 20, null, null, null]);
  assert.deepEqual(all.trips.map((t) => t.in_progress), [false, false, false, false, false, false]);
  assert.deepEqual(Object.keys(all.trips[0]), [
    "trip_id", "label", "start", "end", "logger_on_min", "engine_on_min", "moving_min", "distance_mi", "odometer_distance_mi",
    "unlogged_before_mi", "fuel_used_gal_est", "mpg_est", "avg_moving_speed_mph", "max_speed_mph", "max_rpm", "avg_rpm",
    "max_coolant_f", "times_estimated", "in_progress",
  ]);
  const t12 = all.trips[2];
  assert.deepEqual(
    [t12.logger_on_min, t12.engine_on_min, t12.moving_min, t12.distance_mi, t12.odometer_distance_mi, t12.fuel_used_gal_est, t12.mpg_est],
    [45, 45, 37.5, 45, 45, 2.25, 20]);
  assert.match(t12.start, /Sun, Nov 1, 2026.*11:30.PM PST/);

  // The trip just past the limit is read too, so the last listed one still gets its gap.
  const two = await listTrips(e, { limit: 3 }, now);
  assert.deepEqual(two.trips.map((t) => [t.trip_id, t.unlogged_before_mi]), [[15, null], [13, null], [12, 20]]);
  assert.equal(two.more_trips_exist, true);
  assert.equal((await listTrips(e, { limit: "2" }, now)).trips.length, 2);
  assert.equal((await listTrips(e, { limit: 0 }, now)).trips.length, 1);
  assert.equal((await listTrips(makeEnv(), {}, now)).trips.length, 0);
});

test("list_trips: from and to are local dates, both included", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 4, 20);
  const ids = async (a) => (await listTrips(e, a, now)).trips.map((t) => t.trip_id);
  // Nov 1 is the long day. Trip 10 ends on it, trip 12 starts on it at 23:30 PST.
  assert.deepEqual(await ids({ from: "2026-11-01", to: "2026-11-01" }), [12, 11, 10]);
  assert.deepEqual(await ids({ from: "2026-10-31", to: "2026-10-31" }), [10, 9]);
  assert.deepEqual(await ids({ from: "2026-11-02", to: "2026-11-02" }), [12]);
  assert.deepEqual(await ids({ from: "2026-11-02" }), [15, 13, 12]);
  assert.deepEqual(await ids({ to: "2026-10-31" }), [10, 9]);
  assert.deepEqual(await ids({ from: "2026-11-01", to: "2026-11-03", limit: 2 }), [15, 13]);
  assert.deepEqual(await ids({ from: "2026-09-01", to: "2026-09-30" }), []);

  const day = await listTrips(e, { from: "2026-11-02", to: "2026-11-02" }, now);
  assert.deepEqual(day.window, { from: "2026-11-02", to: "2026-11-02", time_zone: LA });
  assert.equal(day.more_trips_exist, false);
  // Its predecessor is outside the window and is looked up.
  assert.equal(day.trips[0].unlogged_before_mi, 20);
  const cut = await listTrips(e, { from: "2026-11-01", to: "2026-11-03", limit: 2 }, now);
  assert.equal(cut.more_trips_exist, true);
});

test("list_trips and get_trip_summary mark the trip in progress", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 3, 20, 10);
  setLatest(e, drivingLatest(now));
  const live = await listTrips(e, {}, now);
  assert.deepEqual(live.trips.filter((t) => t.in_progress).map((t) => t.trip_id), [13]);
  assert.equal((await tripSummary(e, { trip_id: 13 }, now)).in_progress, true);
  assert.equal((await tripSummary(e, { trip_id: 12 }, now)).in_progress, false);
  // Two hours later nothing is in progress.
  assert.deepEqual((await listTrips(e, {}, now + 7200)).trips.filter((t) => t.in_progress), []);
});

test("list_trips and get_trip_summary mark a trip whose end has not arrived", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 3, 20, 10);
  // The newest record of trip 13 had the engine on. Two hours later nothing more came.
  setLatest(e, drivingLatest(now));
  const later = now + 7200;
  const list = await listTrips(e, {}, later);
  assert.deepEqual(list.trips.filter((t) => t.end_not_received).map((t) => t.trip_id), [13]);
  assert.equal(list.trips.find((t) => t.trip_id === 13).end_not_received, true);
  assert.equal("end_not_received" in list.trips.find((t) => t.trip_id === 12), false);
  const cut = await tripSummary(e, { trip_id: 13 }, later);
  assert.deepEqual([cut.end_not_received, cut.in_progress], [true, false]);
  assert.match(cut.note, /^The logger stopped sending while the engine was still on\. End time, distance and fuel cover only what arrived\. The rest may come in after the next start\. Fuel used and MPG/);
  const other = await tripSummary(e, { trip_id: 12 }, later);
  assert.equal("end_not_received" in other, false);
  assert.match(other.note, /^Fuel used and MPG/);
  for (const a of [list, cut]) assert.doesNotMatch(JSON.stringify(a), /location|"lat"|"lon"|maps\.google/);

  // While the trip runs it is in progress, not cut off.
  assert.equal("end_not_received" in (await tripSummary(e, { trip_id: 13 }, now)), false);
  // While stored records still upload, the end may be on its way: no flag, and the usual note.
  for (const age of [2, 89]) {
    const backlog = drivingLatest(now);
    backlog.last_upload = { v: later - age, ts: later - age, boot: 0, ms: 0 };
    setLatest(e, backlog);
    assert.deepEqual((await listTrips(e, {}, later)).trips.filter((t) => t.end_not_received), [], `upload ${age} s ago`);
    const t = await tripSummary(e, { trip_id: 13 }, later);
    assert.equal("end_not_received" in t, false, `upload ${age} s ago`);
    assert.match(t.note, /^Fuel used and MPG/);
  }
  // get_history rows never read latest, so they carry no flag.
  const h = await history(e, { from: "2026-11-03", to: "2026-11-03" }, later);
  assert.equal(h.trips.some((t) => "end_not_received" in t), false);
});

test("tripMoved: logged distance from 0.1 mi, or a GPS distance", () => {
  assert.equal(tripMoved({ miles: 0.1, gps_miles: null }), true);
  assert.equal(tripMoved({ miles: 0.09, gps_miles: null }), false);
  assert.equal(tripMoved({ miles: 0, gps_miles: null }), false);
  assert.equal(tripMoved({ miles: 0, gps_miles: 7.5 }), true);
});

test("get_trip_summary: by default the newest trip that moved, or the one in progress", async () => {
  const e = carEnv();
  // Nov 3 16:00 PST, after trip 15: two minutes with the engine on and no driving.
  addSession(e, { boot: 16, start: utc(2026, 11, 4, 0), minutes: 2, idle: true });
  const now = utc(2026, 11, 4, 20);
  const t = await tripSummary(e, {}, now);
  assert.deepEqual([t.trip_id, t.distance_mi], [15, 1]);
  assert.deepEqual(t.newer_sessions_without_driving.map((s) => ({ ...s, start: null })),
    [{ trip_id: 16, label: "16", start: null, engine_on_min: 2 }]);
  assert.match(t.newer_sessions_without_driving[0].start, /Tue, Nov 3, 2026.*4:00.PM PST/);
  assert.doesNotMatch(JSON.stringify(t), /location|"lat"|"lon"|maps\.google/);
  // The default answer is the same as asking for trip 15, plus the list.
  const { newer_sessions_without_driving: _, ...rest } = t;
  assert.deepEqual(rest, await tripSummary(e, { trip_id: 15 }, now));
  // Asked for by id, the idle session is a trip like any other.
  const idle = await tripSummary(e, { trip_id: 16 }, now);
  assert.deepEqual([idle.trip_id, idle.distance_mi, idle.engine_on_min, "newer_sessions_without_driving" in idle], [16, 0, 2, false]);

  // While it runs it is the default, moved or not.
  const running = utc(2026, 11, 4, 0, 1, 50);
  setLatest(e, drivingLatest(running, 16, { speed_kph: 0 }));
  const live = await tripSummary(e, {}, running);
  assert.deepEqual([live.trip_id, live.in_progress, "newer_sessions_without_driving" in live], [16, true, false]);
  // Cut off while idling, it is skipped again and named as such.
  const cut = await tripSummary(e, {}, running + 7200);
  assert.equal(cut.trip_id, 15);
  assert.deepEqual(cut.newer_sessions_without_driving.map((s) => [s.trip_id, s.end_not_received]), [[16, true]]);
  assert.equal("end_not_received" in cut, false);

  // When none of the five newest sessions moved, the newest one is the answer, with nothing skipped.
  for (let i = 0; i < 4; i++) addSession(e, { boot: 17 + i, start: utc(2026, 11, 4, 1 + i), minutes: 2, idle: true });
  const none = await tripSummary(e, {}, utc(2026, 11, 5, 20));
  assert.deepEqual([none.trip_id, "newer_sessions_without_driving" in none], [20, false]);
});

test("tripNumbersWithGaps looks up the trip before the oldest one", async () => {
  const e = carEnv();
  const row = (boot) => e.DB.prepare(
    `SELECT boot, start_ts, end_ts, km, maf_g, engine_s, moving_s, max_kph, max_rpm, max_coolant, 2000 AS avg_rpm, est,
            odo_start, odo_end, fw, nolink_n FROM trips WHERE boot = ?`).bind(boot).first();
  const nums = await tripNumbersWithGaps(e, [await row(13), await row(12)]);
  assert.deepEqual(nums.map((n) => [n.id, n.unlogged_before_mi, n.nolink_n]), [[13, null, 0], [12, 20, 4]]);
  assert.deepEqual((await tripNumbersWithGaps(e, [await row(9)])).map((n) => n.unlogged_before_mi), [null]);
  assert.deepEqual(await tripNumbersWithGaps(e, []), []);
  // With the lookup every gap is known. Trip 9 is the first trip of all, so nothing is missing before it.
  assert.deepEqual(nums.map((n) => n.unlogged_known), [true, true]);
  assert.deepEqual((await tripNumbersWithGaps(e, [await row(9)])).map((n) => n.unlogged_known), [true]);
  assert.deepEqual((await tripNumbersWithGaps(e, [await row(10), await row(9)])).map((n) => n.unlogged_known), [true, true]);
});

// A session that never had a clock is dated at upload time, which is after the next start.
// Its stored end then lies a little after the start of the trip that follows it.
function overlapEnv() {
  const e = makeEnv();
  addSession(e, { boot: 9, start: utc(2026, 11, 6, 20), minutes: 10, odo: [1000, 1016] });
  addSession(e, { boot: 10, start: utc(2026, 11, 6, 23, 9), minutes: 12, odo: [1016, 1027.4] }); // ends 23:20:59
  addSession(e, { boot: 11, start: utc(2026, 11, 6, 23, 20, 20), minutes: 15, odo: [1027.4, 1050] });
  return e;
}

test("tripBefore: the previous trip counts even when its stored end is after this trip's start", async () => {
  const e = overlapEnv();
  const now = utc(2026, 11, 8, 20);
  assert.equal((await tripBefore(e, await tripAgg(e, 11))).boot, 10);
  assert.equal((await tripBefore(e, await tripAgg(e, 10))).boot, 9);
  assert.equal(await tripBefore(e, await tripAgg(e, 9)), null);
  // The odometer is continuous, so no tool may report trip 10's distance as unlogged.
  const list = await listTrips(e, {}, now);
  assert.deepEqual(list.trips.map((t) => [t.trip_id, t.unlogged_before_mi]), [[11, null], [10, null], [9, null]]);
  assert.equal((await tripSummary(e, { trip_id: 11 }, now)).unlogged_before_mi, null);
  assert.deepEqual((await tripNumbersWithGaps(e, [await tripAgg(e, 11)])).map((n) => [n.unlogged_before_mi, n.unlogged_known]), [[null, true]]);
  // A real gap before trip 11 is still found through the same predecessor.
  e.DB.sqlite.prepare("UPDATE trips SET odo_start = 1059.6 WHERE boot = 11").run();
  assert.equal((await tripSummary(e, { trip_id: 11 }, now)).unlogged_before_mi, 20); // 32.2 km after trip 10
});

test("get_trip_summary: field names, odometer, and locations only on request", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 4, 20);
  // The tank gauge comes from the first and last minute rows with a reading. The very last
  // minute holds ten 0 % readings from one bad reply, so it is skipped.
  const gauge = e.DB.sqlite.prepare("UPDATE minutes SET fuel_sum = ?, fuel_n = 60, fuel_min = ?, fuel_max = ? WHERE boot = 12 AND t = ?");
  const t12 = utc(2026, 11, 2, 7, 30);
  gauge.run(60 * 60, 60, 60, t12);
  gauge.run(50 * 60, 50, 50, t12 + 43 * 60);
  gauge.run(50 * 50, 0, 50, t12 + 44 * 60);
  // The start and end positions come from the route points, never from a walk through `samples`.
  const pt = e.DB.sqlite.prepare("INSERT INTO track (boot, ms, ts, lat, lon, mph) VALUES (?,?,?,?,?,?)");
  pt.run(12, 15000, utc(2026, 11, 2, 7, 30) + 15, 37.8199, -122.4783, 0);
  pt.run(12, 1350000, utc(2026, 11, 2, 7, 52, 30), 37.8262, -122.479, 62);
  pt.run(12, 2685000, utc(2026, 11, 2, 8, 14, 45), 37.8324, -122.4795, 0);

  const t = await tripSummary(e, { trip_id: 12 }, now);
  assert.deepEqual(Object.keys(t), [
    "trip_id", "label", "start", "end", "logger_on_min", "engine_on_min", "moving_min", "distance_mi", "odometer_distance_mi",
    "unlogged_before_mi", "fuel_used_gal_est", "mpg_est", "avg_moving_speed_mph", "max_speed_mph", "max_rpm", "avg_rpm",
    "max_coolant_f", "times_estimated", "in_progress", "fuel_level_pct", "odometer_mi",
    "records_without_adapter_link", "note",
  ]);
  assert.deepEqual({ ...t, start: null, end: null, note: null }, {
    trip_id: 12, label: "12", start: null, end: null, logger_on_min: 45, engine_on_min: 45, moving_min: 37.5, distance_mi: 45,
    odometer_distance_mi: 45, unlogged_before_mi: 20, fuel_used_gal_est: 2.25, mpg_est: 20, avg_moving_speed_mph: 72,
    max_speed_mph: 62, max_rpm: 3000, avg_rpm: 2000, max_coolant_f: 203, times_estimated: false, in_progress: false,
    fuel_level_pct: { start: 60, end: 50 }, odometer_mi: { start: 771, end: 816 },
    records_without_adapter_link: 4, note: null,
  });
  assert.match(t.note, /estimates from engine airflow/);
  // The gauge is not a fuel figure, and the note says why.
  assert.match(t.note, /fuel_level_pct is the tank gauge in whole percent.*not fuel used/);
  assert.doesNotMatch(t.note, /cross-check/);
  assert.doesNotMatch(JSON.stringify(t), /location|"lat"|maps\.google/);

  const withPlaces = await tripSummary(e, { trip_id: 12, include_locations: true }, now);
  assert.deepEqual(withPlaces.start_location, { lat: 37.8199, lon: -122.4783, map: "https://maps.google.com/?q=37.819900,-122.478300" });
  assert.deepEqual(withPlaces.end_location, { lat: 37.8324, lon: -122.4795, map: "https://maps.google.com/?q=37.832400,-122.479500" });
  assert.equal("start_location" in (await tripSummary(e, { trip_id: 12, include_locations: false }, now)), false);
  // A trip without any fix still answers when locations are asked for.
  const noFix = await tripSummary(e, { trip_id: 13, include_locations: true }, now);
  assert.deepEqual([noFix.start_location, noFix.end_location], [null, null]);
  assert.equal("records_without_adapter_link" in noFix, false);
  assert.deepEqual(noFix.fuel_level_pct, { start: null, end: null }); // no minute of trip 13 has a reading

  // No id means the newest trip. An id sent as a string works too.
  assert.equal((await tripSummary(e, {}, now)).trip_id, 15);
  assert.equal((await tripSummary(e, { trip_id: "9" }, now)).trip_id, 9);
  assert.equal((await tripSummary(e, { trip_id: 9 }, now)).unlogged_before_mi, null);
  assert.match((await tripSummary(e, { trip_id: 999 }, now)).error, /Trip 999 not found/);
  assert.match((await tripSummary(e, { trip_id: 14 }, now)).error, /not found/); // engine never ran
  assert.equal((await tripSummary(makeEnv(), {}, now)).error, "No trips recorded yet.");

  // Nothing of it walks through the readings of the trip.
  e.DB.sqlite.exec("DROP TABLE samples");
  assert.deepEqual(await tripSummary(e, { trip_id: 12 }, now), t);
});

test("trip labels: every tool shows the label next to trip_id and takes either form", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 5, 20);
  // New firmware: install id 173, boot counter 12. The dashboard calls it "173-12".
  addSession(e, { boot: 11337740, start: utc(2026, 11, 4, 20), minutes: 30, odo: [1347.8, 1396.1] });

  const list = await listTrips(e, { limit: 2 }, now);
  assert.deepEqual(list.trips.map((t) => [t.trip_id, t.label]), [[11337740, "173-12"], [15, "15"]]);
  const hist = await history(e, { from: "2026-11-03", to: "2026-11-04" }, now);
  assert.deepEqual(hist.trips.map((t) => [t.trip_id, t.label]), [[11337740, "173-12"], [15, "15"], [13, "13"]]);
  const econ = await fuelEconomy(e, 2, now);
  assert.deepEqual(econ.trips.map((t) => [t.trip_id, t.label]), [[11337740, "173-12"], [15, "15"], [13, "13"]]);

  const byLabel = await tripSummary(e, { trip_id: "173-12" }, now);
  assert.deepEqual([byLabel.trip_id, byLabel.label, byLabel.distance_mi], [11337740, "173-12", 30]);
  assert.deepEqual(await tripSummary(e, { trip_id: 11337740 }, now), byLabel);
  assert.deepEqual(await tripSummary(e, { trip_id: "11337740" }, now), byLabel);
  // The legacy trip 12 of the old board is a different trip and stays reachable by its number.
  assert.deepEqual([(await tripSummary(e, { trip_id: 12 }, now)).label, (await tripSummary(e, { trip_id: "12" }, now)).distance_mi], ["12", 45]);
  // A label that names no trip says so in the same form it was asked in.
  assert.match((await tripSummary(e, { trip_id: "173-13" }, now)).error, /^Trip 173-13 not found/);
  assert.equal((await tripSummary(e, { trip_id: "256-12" }, now)).bad_input, true);

  // Through the endpoint, the way a model sends it.
  const r = await call("get_trip_summary", { trip_id: "173-12" }, e);
  assert.equal(r.isError, false);
  assert.equal(JSON.parse(r.content[0].text).trip_id, 11337740);
});

test("get_fuel_economy: estimates, and best and worst skip trips under 2 miles", async () => {
  const e = carEnv();
  const f = await fuelEconomy(e, 30, utc(2026, 11, 4, 20));
  assert.deepEqual({ ...f, trips: null, note: null }, {
    window_days: 30, trip_count: 6, total_miles: 196, total_gallons_est: 9.57, combined_mpg_est: 20.5,
    combined_mpg_few_miles: false,
    epa_reference_mpg: { city: 16, highway: 24, combined: 19 }, best_trip_mpg_est: 25, worst_trip_mpg_est: 20,
    trips: null, note: null,
  });
  assert.doesNotMatch(f.note, /fewer than/);
  assert.deepEqual(f.trips.map((t) => [t.trip_id, t.distance_mi, t.mpg_est]),
    [[15, 1, 50], [13, 20, 25], [12, 45, 20], [11, 60, 20], [10, 30, 20], [9, 40, 20]]);
  assert.deepEqual(Object.keys(f.trips[0]), ["trip_id", "label", "start", "distance_mi", "mpg_est"]);
  assert.match(f.note, /estimates from engine airflow/);
  // A one-day window that only holds the short trip has no best or worst.
  const short = await fuelEconomy(e, 1, utc(2026, 11, 4, 23, 20));
  assert.deepEqual([short.trip_count, short.best_trip_mpg_est, short.worst_trip_mpg_est, short.combined_mpg_est], [1, null, null, null]);
  const none = await fuelEconomy(makeEnv(), 30, utc(2026, 11, 4, 20));
  assert.deepEqual([none.trip_count, none.total_miles, none.combined_mpg_est, none.best_trip_mpg_est], [0, 0, null, null]);
  assert.equal(none.combined_mpg_few_miles, false); // no figure, nothing to warn about
  // Only 20 trips are listed, however many there are.
  const many = makeEnv();
  for (let i = 0; i < 25; i++) addSession(many, { boot: 100 + i, start: utc(2026, 11, 1, 8) + i * 3600, minutes: 3 });
  const m = await fuelEconomy(many, 30, utc(2026, 11, 4, 20));
  assert.deepEqual([m.trip_count, m.trips.length, m.trips[0].trip_id, m.total_miles], [25, 20, 124, 75]);
});

test("get_fuel_economy: a figure from fewer than 25 logged miles is kept but flagged", async () => {
  const e = carEnv();
  // Since Nov 3 20:00 UTC: trips 13 (20 miles) and 15 (1 mile).
  const day = await fuelEconomy(e, 1, utc(2026, 11, 4, 20));
  assert.deepEqual([day.total_miles, day.combined_mpg_est, day.combined_mpg_few_miles], [21, 25.6, true]);
  assert.match(day.note, /combined_mpg_est rests on fewer than 25 logged miles, so it is rough and not a solid average/);
  // The flag follows the same gate as the dashboard's 30-day average.
  const near = makeEnv();
  addSession(near, { boot: 1, start: utc(2026, 11, 1, 8), minutes: 25 });
  near.DB.sqlite.prepare("UPDATE trips SET km = ? WHERE boot = 1").run(24.96 / 0.621371);
  const now = utc(2026, 11, 4, 20);
  const [f, m] = [await fuelEconomy(near, 30, now), await mpg30(near, now)];
  assert.deepEqual([f.combined_mpg_few_miles, m.mpg], [true, null]);
  addSession(near, { boot: 2, start: utc(2026, 11, 2, 8), minutes: 1 });
  const [f2, m2] = [await fuelEconomy(near, 30, now), await mpg30(near, now)];
  assert.equal(f2.combined_mpg_few_miles, false);
  assert.notEqual(m2.mpg, null);
  // Through the endpoint the field is there for the model.
  const r = await call("get_fuel_economy", { days: 365 }, e);
  assert.equal(r.isError, false);
  assert.equal(typeof JSON.parse(r.content[0].text).combined_mpg_few_miles, "boolean");
});

test("mpg30: null until 25 logged miles", async () => {
  const now = utc(2026, 11, 4, 20);
  assert.equal(MPG30_MIN_MILES, 25); // exported so the dashboard can show the same number
  assert.deepEqual(await mpg30(makeEnv(), now), { mpg: null, miles: 0, gallons: 0 });
  const few = makeEnv();
  addSession(few, { boot: 1, start: utc(2026, 11, 1, 8), minutes: 24 });
  assert.deepEqual(await mpg30(few, now), { mpg: null, miles: 24, gallons: 1.2 });
  addSession(few, { boot: 2, start: utc(2026, 11, 2, 8), minutes: 1 });
  assert.deepEqual(await mpg30(few, now), { mpg: 20, miles: 25, gallons: 1.25 });
  // Trips older than 30 days do not count.
  assert.deepEqual(await mpg30(few, now + 40 * 86400), { mpg: null, miles: 0, gallons: 0 });
  assert.deepEqual(await mpg30(carEnv(), now), { mpg: 20.5, miles: 196, gallons: 9.57 });
});

test("roughMpg: a figure from 5 to 25 logged miles, only while mpg30 has none", () => {
  assert.equal(roughMpg({ mpg: null, miles: 20.1, gallons: 2.05 }), 9.8);
  assert.equal(roughMpg({ mpg: null, miles: 5, gallons: 0.5 }), 10);
  assert.equal(roughMpg({ mpg: null, miles: 4.9, gallons: 0.5 }), null);
  assert.equal(roughMpg({ mpg: null, miles: 20, gallons: 0.05 }), null); // no fuel use readings
  assert.equal(roughMpg({ mpg: 20.5, miles: 196, gallons: 9.57 }), null);
  assert.equal(roughMpg({ mpg: null, miles: 0, gallons: 0 }), null);
});

test("mpg30: miles are rounded down, so a page comparing them with 25 agrees with the server", async () => {
  const now = utc(2026, 11, 4, 20);
  const e = makeEnv();
  addSession(e, { boot: 1, start: utc(2026, 11, 1, 8), minutes: 25 });
  e.DB.sqlite.prepare("UPDATE trips SET km = ? WHERE boot = 1").run(24.96 / 0.621371);
  // Rounded to the nearest tenth this would read 25.0 next to a missing average.
  const short = await mpg30(e, now);
  assert.equal(short.mpg, null);
  assert.equal(short.miles, 24.9);
  assert.ok(short.miles < MPG30_MIN_MILES);
  // Three trips of 8.1 miles add up to 24.299999999999997 in floating point. That is 24.3, not 24.2.
  const three = makeEnv();
  for (const boot of [1, 2, 3]) addSession(three, { boot, start: utc(2026, 11, boot, 8), minutes: 8 });
  three.DB.sqlite.prepare("UPDATE trips SET km = ?").run(8.1 / 0.621371);
  assert.deepEqual([(await mpg30(three, now)).miles, (await mpg30(three, now)).mpg], [24.3, null]);
  // Newest first these add up to 24.999999999999996. That is 25: it passes the gate and the miles say 25.
  const noisy = makeEnv();
  const parts = [0.7, 8.1, 8.1, 8.1]; // oldest first
  parts.forEach((mi, i) => addSession(noisy, { boot: i + 1, start: utc(2026, 11, 1, 8 + i), minutes: 1 }));
  parts.forEach((mi, i) => noisy.DB.sqlite.prepare("UPDATE trips SET km = ? WHERE boot = ?").run(mi / 0.621371, i + 1));
  const at25 = await mpg30(noisy, now);
  assert.equal(at25.miles, 25);
  assert.notEqual(at25.mpg, null);
});

test("get_latest_status: running car, no coordinates", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 3, 20, 10);
  setLatest(e, drivingLatest(now));
  const s = await latestStatus(e, now);
  assert.deepEqual(Object.keys(s), [
    "car_state", "engine_running_at_last_report", "fuel", "battery_v", "battery_context", "battery_as_of", "ecu_v",
    "coolant_f", "intake_air_f", "last_speed_mph", "last_rpm", "engine_values_as_of", "odometer_mi", "cell_signal_csq",
    "cell_signal_dbm", "logger", "note",
  ]);
  assert.equal(s.car_state.state, "running");
  assert.equal(s.car_state.summary, "The engine is running, last report 5s ago.");
  assert.deepEqual([s.car_state.ended_mid_drive, s.car_state.link_down, s.car_state.last_report.age], [false, false, "5s ago"]);
  assert.deepEqual({ ...s.fuel, as_of: null }, {
    level_pct: 50, est_gallons_left: 9.3, est_range_mi: 190, range_basis_mpg: 20.5,
    range_basis: "estimated MPG of the last 30 days", as_of: null,
  });
  assert.deepEqual([s.battery_v, s.battery_context, s.ecu_v], [12.1, "engine on, not charging", 12]);
  assert.deepEqual([s.coolant_f, s.intake_air_f, s.last_speed_mph, s.last_rpm, s.odometer_mi, s.cell_signal_csq], [194.9, 87.8, 55, 1500, 7873, 21]);
  assert.equal(s.cell_signal_dbm, -71);
  assert.equal(s.engine_values_as_of.age, "5s ago");
  assert.deepEqual({ ...s.logger, last_upload: s.logger.last_upload.age }, { firmware_build: 2, adapter_link: "up", last_upload: "3s ago" });
  assert.doesNotMatch(JSON.stringify(s), /"lat"|"lon"|"location"|"map"|37\.8199|122\.4783|maps\.google/);
  // Nothing in the answer points toward a location call.
  assert.doesNotMatch(s.note, /get_location|position/);
});

test("get_latest_status: no signal, parked, link down, legacy firmware and the EPA fallback", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 3, 20, 10);
  setLatest(e, drivingLatest(now));
  const quiet = await latestStatus(e, now + 295); // last record 300 s old
  assert.equal(quiet.car_state.state, "no_signal");
  assert.match(quiet.car_state.summary, /No report since 5 min ago and the engine was on then/);
  assert.equal("ecu_v" in quiet, false);
  assert.equal("battery_note" in quiet, false);

  const lost = await latestStatus(e, now + 7200);
  assert.equal(lost.car_state.state, "parked");
  assert.equal(lost.car_state.ended_mid_drive, true);
  assert.equal(lost.car_state.summary, "Treated as parked. The last report (2 h ago) still had the engine on, and the end " +
    "of that drive has not arrived. Records the logger still holds are sent after its next start.");
  assert.equal("ecu_v" in lost, false);
  // An old reading keeps its word, and a note says that it is old.
  assert.equal(lost.battery_context, "engine on, not charging");
  assert.equal(lost.battery_note, "Measured 2 h ago with the engine running. The logger cannot measure a parked car, " +
    "so the voltage now is not known.");

  setLatest(e, drivingLatest(now, 13, { engine_on: 0, rpm: 0, adapter_v: 12.4 }));
  const parked = await latestStatus(e, now + 7195);
  assert.equal(parked.car_state.summary, "Parked, the engine was off at the last report 2 h ago.");
  assert.deepEqual([parked.battery_context, parked.engine_running_at_last_report], ["engine off", false]);
  assert.match(parked.battery_note, /^Measured 2 h ago with the engine off\. The logger cannot measure a parked car/);

  setLatest(e, drivingLatest(now, 13, { engine_on: 0, link: 0, adapter_v: 11.6 }));
  const noLink = await latestStatus(e, now);
  assert.deepEqual([noLink.car_state.state, noLink.car_state.link_down, noLink.logger.adapter_link], ["parked", true, "down"]);
  assert.match(noLink.car_state.summary, /no Bluetooth link to the OBD adapter/);
  assert.equal(noLink.battery_context, "low");
  // Without the link nobody knows whether the engine runs, so no field may say that it is off.
  assert.equal(noLink.engine_running_at_last_report, null);
  assert.equal((await location(e, now)).parked, null);
  // Ten minutes later the link flag is too old to matter and the usual rule is back.
  const noLinkOld = await latestStatus(e, now + 700);
  assert.deepEqual([noLinkOld.car_state.link_down, noLinkOld.engine_running_at_last_report], [false, false]);
  assert.equal((await location(e, now + 700)).parked, true);

  // Legacy firmware writes neither fw nor link, and this car has never sent an odometer value.
  const legacy = drivingLatest(now);
  delete legacy.fw; delete legacy.link; delete legacy.odo_km; delete legacy.fuel_pct;
  setLatest(e, legacy);
  const old = await latestStatus(e, now);
  assert.deepEqual([old.logger.firmware_build, old.logger.adapter_link, old.odometer_mi, old.fuel], [null, null, null, null]);
  assert.equal("odometer_as_of" in old, false);

  // RPM keeps coming, but speed, coolant and the odometer were last read in another session two days ago.
  const mixed = drivingLatest(now);
  const twoDays = { ts: now - 2 * 86400, boot: 12, ms: 1000 };
  Object.assign(mixed, { speed_kph: { v: 120, ...twoDays }, coolant_c: { v: 70, ...twoDays }, odo_km: { v: 12600, ...twoDays } });
  setLatest(e, mixed);
  const st = await latestStatus(e, now);
  assert.deepEqual([st.last_rpm, st.last_speed_mph, st.coolant_f, st.intake_air_f], [1500, null, null, 87.8]);
  assert.deepEqual(st.engine_values_stale, { last_speed_mph: "last read 2 days ago", coolant_f: "last read 2 days ago" });
  assert.equal(st.engine_values_as_of.age, "5s ago");
  // The odometer keeps its value and says how old it is.
  assert.deepEqual([st.odometer_mi, st.odometer_as_of.age], [7829, "2 days ago"]);
  // The other way round: the RPM replies stopped and speed still comes. The age follows the speed.
  const noRpm = drivingLatest(now);
  noRpm.rpm = { v: 900, ts: now - 400, boot: 13, ms: 205000 };
  setLatest(e, noRpm);
  const r = await latestStatus(e, now);
  assert.deepEqual([r.last_rpm, r.last_speed_mph, r.engine_values_stale], [null, 55, { last_rpm: "last read 7 min ago" }]);
  assert.equal(r.engine_values_as_of.age, "5s ago");
  // Up to 120 s behind the newest value in the same session a value is current, so the
  // once-a-minute retry of a skipped PID does not make it come and go.
  const edge = drivingLatest(now);
  edge.coolant_c = { v: 90.5, ts: now - 125, boot: 13, ms: 480000 };
  edge.intake_c = { v: 31, ts: now - 126, boot: 13, ms: 479000 };
  setLatest(e, edge);
  const b = await latestStatus(e, now);
  assert.deepEqual([b.coolant_f, b.intake_air_f, b.engine_values_stale], [194.9, null, { intake_air_f: "last read 2 min ago" }]);
  assert.equal("odometer_as_of" in b, false);
  // A cell signal the modem does not know.
  setLatest(e, drivingLatest(now, 13, { csq: 99 }));
  const noCsq = await latestStatus(e, now);
  assert.deepEqual([noCsq.cell_signal_csq, noCsq.cell_signal_dbm], [99, null]);
  // None of these answers carries a position.
  for (const a of [st, r, b, noCsq]) assert.doesNotMatch(JSON.stringify(a), /"lat"|"lon"|37\.8199|122\.4783|maps\.google/);

  // Under 25 logged miles the range uses the EPA figure when the car's own rough figure is higher.
  const few = makeEnv();
  addSession(few, { boot: 1, start: utc(2026, 11, 3, 19), minutes: 20, mpg: 30 });
  setLatest(few, drivingLatest(now, 1));
  const fresh = await latestStatus(few, now);
  assert.deepEqual([fresh.fuel.est_range_mi, fresh.fuel.range_basis_mpg], [176, 19]);
  assert.match(fresh.fuel.range_basis, /EPA combined rating \(fewer than 25 logged miles/);
  // A lower one is used, and named as rough.
  const thirsty = makeEnv();
  addSession(thirsty, { boot: 1, start: utc(2026, 11, 3, 19), minutes: 20, mpg: 10 });
  setLatest(thirsty, drivingLatest(now, 1));
  const rough = await latestStatus(thirsty, now);
  assert.deepEqual([rough.fuel.est_range_mi, rough.fuel.range_basis_mpg], [93, 10]);
  assert.equal(rough.fuel.range_basis, "rough MPG of the 20 logged miles of the last 30 days, fewer than 25 and lower than the EPA rating");
  // Under 5 logged miles there is no rough figure at all.
  const short = makeEnv();
  addSession(short, { boot: 1, start: utc(2026, 11, 3, 19), minutes: 4, mpg: 10 });
  setLatest(short, drivingLatest(now, 1));
  assert.equal((await latestStatus(short, now)).fuel.range_basis_mpg, 19);

  assert.deepEqual(await latestStatus(makeEnv(), now), { error: "No data received yet." });
});

test("car_state while stored records upload: an old newest record is not a lost drive end", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 3, 20, 30);
  // The backlog arrives oldest first. The newest record so far is 14 minutes old with the
  // engine on, and the last upload came in 2 s ago.
  const latest = drivingLatest(now - 835);
  latest.last_upload = { v: now - 2, ts: now - 2, boot: 0, ms: 0 };
  setLatest(e, latest);
  const s = await latestStatus(e, now);
  assert.deepEqual([s.car_state.state, s.car_state.ended_mid_drive], ["parked", false]);
  assert.equal(s.car_state.summary, "The logger is uploading stored records right now (last upload 2s ago). " +
    "The newest one so far is from 14 min ago and had the engine on, so the current state is not known until it has caught up.");
  assert.doesNotMatch(s.car_state.summary, /not recorded/);
  const l = await location(e, now);
  assert.equal(l.parked, null);
  assert.deepEqual(l.car_state, s.car_state);

  // Once the uploads have stopped for 90 s the drive end really is missing.
  for (const [later, drain] of [[87, true], [88, false], [3600, false]]) {
    const st = await latestStatus(e, now + later);
    assert.equal(st.car_state.ended_mid_drive, !drain, `upload ${later + 2} s ago`);
    assert.equal(/uploading stored records/.test(st.car_state.summary), drain, `upload ${later + 2} s ago`);
    assert.equal(/the end of that drive has not arrived/.test(st.car_state.summary), !drain, `upload ${later + 2} s ago`);
    // Uploading or cut off, nobody knows whether the car stands where the last fix was.
    assert.equal((await location(e, now + later)).parked, null, `upload ${later + 2} s ago`);
  }
  // A row from a Worker that never wrote last_upload keeps the old answer.
  delete latest.last_upload;
  setLatest(e, latest);
  assert.equal((await latestStatus(e, now)).car_state.ended_mid_drive, true);
  // A parked car with the engine off is not a backlog, however fresh the upload.
  const off = drivingLatest(now - 835, 13, { engine_on: 0 });
  off.last_upload = { v: now - 2, ts: now - 2, boot: 0, ms: 0 };
  setLatest(e, off);
  assert.match((await latestStatus(e, now)).car_state.summary, /^Parked, the engine was off/);
  assert.equal((await location(e, now)).parked, true);
});

test("car_state while stored records upload after a gap under 10 minutes", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 3, 20, 30);
  const at = async (recordAge, uploadAge) => {
    const latest = drivingLatest(now - recordAge + 5);
    latest.last_upload = { v: now - uploadAge, ts: now - uploadAge, boot: 0, ms: 0 };
    setLatest(e, latest);
    return [await latestStatus(e, now), await location(e, now)];
  };
  // The newest record so far is 4 minutes old with the engine on, and the last upload came 2 s ago.
  const [s, l] = await at(240, 2);
  assert.deepEqual([s.car_state.state, s.car_state.ended_mid_drive], ["no_signal", false]);
  assert.equal(s.car_state.summary, "The logger is uploading stored records right now (last upload 2s ago). " +
    "The newest one so far is from 4 min ago and had the engine on, so the current state is not known until it has caught up.");
  // The state word is unchanged, so the car still counts as driving.
  assert.deepEqual([l.car_state, l.parked], [s.car_state, false]);
  // The last post before the car went quiet is not a backlog: it came right after the newest record.
  for (const [recordAge, uploadAge] of [[100, 85], [240, 100], [92, 2]]) {
    const [q] = await at(recordAge, uploadAge);
    assert.equal(q.car_state.state, "no_signal", `${recordAge} ${uploadAge}`);
    assert.match(q.car_state.summary, /^No report since .* so the car is probably driving without cell coverage/, `${recordAge} ${uploadAge}`);
  }
  // Just over the 90 s gap it is a backlog again.
  assert.match((await at(93, 2))[0].car_state.summary, /uploading stored records/);
  // A row from a Worker that never wrote last_upload keeps the old answer.
  const old = drivingLatest(now - 235);
  delete old.last_upload;
  setLatest(e, old);
  assert.match((await latestStatus(e, now)).car_state.summary, /^No report since 4 min ago/);
});

test("get_location: coordinates with the shared state", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 3, 20, 10);
  assert.deepEqual(await location(e, now), { error: "No GPS fix has been reported yet." });
  setLatest(e, drivingLatest(now));
  const here = await location(e, now);
  assert.deepEqual(Object.keys(here), ["lat", "lon", "satellites", "map", "as_of", "age", "fix_before_last_report_min", "parked", "car_state"]);
  assert.deepEqual([here.lat, here.lon, here.satellites, here.map, here.age, here.fix_before_last_report_min, here.parked],
    [37.8199, -122.4783, 11, "https://maps.google.com/?q=37.819900,-122.478300", "5s ago", null, false]);
  assert.equal(here.car_state.state, "running");
  // The same rule as get_latest_status at every age. The newest record had the engine on, so
  // once it is old the car is not called parked there.
  for (const [later, state, parked] of [[80, "running", false], [200, "no_signal", false], [1000, "parked", null]]) {
    const l = await location(e, now + later);
    const s = await latestStatus(e, now + later);
    assert.deepEqual([l.car_state.state, l.parked], [state, parked]);
    assert.deepEqual(l.car_state, s.car_state);
  }
  // Parked with the engine off, it is.
  setLatest(e, drivingLatest(now, 13, { engine_on: 0, rpm: 0 }));
  assert.equal((await location(e, now + 1000)).parked, true);
});

test("get_location: a fix older than the last report says by how much", async () => {
  const e = carEnv();
  const now = utc(2026, 11, 3, 20, 10);
  // Same session: the fix was lost 10 minutes before the newest record.
  const lost = drivingLatest(now);
  for (const k of ["lat", "lon", "sats"]) lost[k] = { ...lost[k], ts: now - 605, ms: 0 };
  setLatest(e, lost);
  const l = await location(e, now);
  assert.deepEqual([l.age, l.fix_before_last_report_min, l.parked], ["10 min ago", 10, false]);
  // A minute or less is a normal gap between fixes.
  const recent = drivingLatest(now);
  for (const k of ["lat", "lon", "sats"]) recent[k] = { ...recent[k], ts: now - 65 };
  setLatest(e, recent);
  assert.equal((await location(e, now)).fix_before_last_report_min, null);
  // An earlier session: this power-up never got a fix, the last one is two days old.
  const earlier = drivingLatest(now);
  for (const k of ["lat", "lon", "sats"]) earlier[k] = { ...earlier[k], ts: now - 5 - 2 * 86400, boot: 12, ms: 2000 };
  setLatest(e, earlier);
  const old = await location(e, now);
  assert.deepEqual([old.age, old.fix_before_last_report_min], ["2 days ago", 2880]);
});

// ------------------------------------------------------------ distance from GPS

// A drive north along a meridian at about 20 m/s, one route point every 15 s.
const northRoute = (n, startMs = 0, mps = 20) =>
  Array.from({ length: n }, (_, i) => ({ ms: startMs + i * 15000, lat: 37.8199 + (i * 15 * mps) / 110574, lon: -122.4783 }));

test("routeKm: counts driving, skips standing drift, jumps and gaps", () => {
  // 40 steps of 300 m.
  assert.ok(Math.abs(routeKm(northRoute(41)) - 12) < 0.01);
  // Standing: a few metres of drift per step is not distance.
  const still = Array.from({ length: 200 }, (_, i) => ({ ms: i * 15000, lat: 37.8199 + (i % 2) * 0.00003, lon: -122.4783 }));
  assert.equal(routeKm(still), 0);
  // A jump faster than 70 m/s and a gap over 60 s count nothing.
  assert.equal(routeKm([{ ms: 0, lat: 37.8199, lon: -122.4783 }, { ms: 15000, lat: 37.84, lon: -122.4783 }]), 0);
  assert.equal(routeKm([{ ms: 0, lat: 37.8199, lon: -122.4783 }, { ms: 120000, lat: 37.83, lon: -122.4783 }]), 0);
});

test("withGpsMiles: a drive without speed readings gets its GPS distance, a normal one is untouched", async () => {
  const e = makeEnv();
  const start = utc(2026, 11, 12, 16);
  addSession(e, { boot: 13, start, minutes: 16, engine: true });
  addSession(e, { boot: 14, start: start + 3600, minutes: 10, engine: true });
  // Session 13 lost its speed readings: no distance in its trip row, but a route.
  e.DB.sqlite.prepare("UPDATE trips SET km = 0 WHERE boot = 13").run();
  const ins = e.DB.sqlite.prepare("INSERT INTO track (boot, ms, ts, lat, lon, mph) VALUES (?,?,?,?,?,?)");
  for (const p of northRoute(41)) ins.run(13, p.ms, start + p.ms / 1000, p.lat, p.lon, null);
  for (const p of northRoute(41)) ins.run(14, p.ms, start + 3600 + p.ms / 1000, p.lat, p.lon, 45);

  const aggs = [await tripAgg(e, 13), await tripAgg(e, 14)];
  const [a, b] = await withGpsMiles(e, tripNumbersList(aggs));
  assert.equal(a.miles, 0);
  assert.equal(a.gps_miles, 7.5); // 12 km
  assert.equal(b.gps_miles, null, "a trip with speed readings keeps its logged distance");

  // Only the trip that needs it reads route points. statements is a count of statements run.
  const before = e.DB.statements;
  await withGpsMiles(e, tripNumbersList([aggs[1]]));
  assert.equal(e.DB.statements, before, "no query when every trip has its distance");

  // The tools carry the figure with a note.
  const list = await listTrips(e, { limit: 5 }, start + 7200);
  const t13 = list.trips.find((t) => t.trip_id === 13);
  assert.equal(t13.gps_distance_mi, 7.5);
  assert.match(t13.distance_note, /GPS route/);
  assert.equal(list.trips.find((t) => t.trip_id === 14).gps_distance_mi, undefined);
});

test("get_trip_summary: a drive whose speed readings failed moved by GPS, so the default does not skip it", async () => {
  const e = makeEnv();
  const start = utc(2026, 11, 12, 16);
  addSession(e, { boot: 13, start, minutes: 16 });
  e.DB.sqlite.prepare("UPDATE trips SET km = 0 WHERE boot = 13").run();
  const ins = e.DB.sqlite.prepare("INSERT INTO track (boot, ms, ts, lat, lon, mph) VALUES (?,?,?,?,?,?)");
  for (const p of northRoute(41)) ins.run(13, p.ms, start + p.ms / 1000, p.lat, p.lon, null);
  addSession(e, { boot: 14, start: start + 3600, minutes: 2, idle: true });
  const t = await tripSummary(e, {}, start + 7200);
  assert.deepEqual([t.trip_id, t.distance_mi, t.gps_distance_mi], [13, 0, 7.5]);
  assert.deepEqual(t.newer_sessions_without_driving.map((s) => s.trip_id), [14]);
});

test("get_history: odometer distance, GPS distance on trip rows, and a floor for unlogged miles", async () => {
  const e = makeEnv();
  const start = utc(2026, 11, 12, 16); // 08:00 PST
  // 10 logged miles each for trips 12, 14 and 15. Trip 13 lost its speed readings and never
  // answered the odometer, so the gaps on both sides of it are not known. Before trip 15 the
  // odometer is 33.9 km ahead of where trip 14 ended.
  addSession(e, { boot: 12, start, minutes: 10, odo: [1000, 1016.1] });
  addSession(e, { boot: 13, start: start + 3600, minutes: 16 });
  addSession(e, { boot: 14, start: start + 7200, minutes: 10, odo: [1050, 1066.1] });
  addSession(e, { boot: 15, start: start + 10800, minutes: 10, odo: [1100, 1116.1] });
  e.DB.sqlite.prepare("UPDATE trips SET km = 0 WHERE boot = 13").run();
  e.DB.sqlite.prepare("UPDATE minutes SET km = 0 WHERE boot = 13").run();
  const ins = e.DB.sqlite.prepare("INSERT INTO track (boot, ms, ts, lat, lon, mph) VALUES (?,?,?,?,?,?)");
  for (const p of northRoute(41)) ins.run(13, p.ms, start + 3600 + p.ms / 1000, p.lat, p.lon, null);

  const h = await history(e, { from: "2026-11-12", to: "2026-11-12" }, utc(2026, 11, 13, 20));
  assert.deepEqual(h.trips.map((t) => [t.trip_id, t.distance_mi, t.gps_distance_mi, t.unlogged_before_mi]),
    [[15, 10, undefined, 21.1], [14, 10, undefined, null], [13, 0, 7.5, null], [12, 10, undefined, null]]);
  assert.deepEqual(Object.keys(h.trips[2]), ["trip_id", "label", "start", "logger_on_min", "engine_on_min", "distance_mi",
    "gps_distance_mi", "fuel_used_gal_est", "mpg_est", "unlogged_before_mi"]);
  // Two gaps are not known, so the total is unknown. The one that is known is a floor.
  assert.deepEqual([h.totals.distance_mi, h.totals.odometer_distance_mi, h.totals.unlogged_mi, h.totals.unlogged_mi_at_least],
    [30, 72.1, null, 21.1]);
  assert.match(h.note, /The odometer moved 72\.1 mi between the first and last readings in this window\. 30 mi of that were logged from speed readings, the rest was missed by the logger or only measured by GPS\./);
  assert.match(h.note, /A trip row with gps_distance_mi had failed speed readings, so its distance_mi is near 0\./);
  assert.doesNotMatch(JSON.stringify(h), /"lat"|"lon"|maps\.google/);

  // Trip 16 starts at 23:50 and ends after midnight. Only a window that holds it whole counts
  // its odometer, so no day gets driving from outside it.
  addSession(e, { boot: 16, start: utc(2026, 11, 13, 7, 50), minutes: 20, odo: [1116.1, 1148.3] });
  const day = async (from, to) => (await history(e, { from, to }, utc(2026, 11, 14, 20))).totals.odometer_distance_mi;
  assert.deepEqual([await day("2026-11-12", "2026-11-12"), await day("2026-11-13", "2026-11-13")], [72.1, null]);
  assert.equal(await day("2026-11-12", "2026-11-13"), 92.1); // 148.3 km
});
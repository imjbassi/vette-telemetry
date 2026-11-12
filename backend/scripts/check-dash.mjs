// Checks for the dashboard page. Usage: node scripts/check-dash.mjs
// src/dash.html is bundled as text, so neither tsc nor wrangler ever parses its script, and
// the tests in test/ never run it. A mistake there only shows up in the browser. Two stages:
//
// 1. Syntax. Every inline <script> (one without src) is pulled out of the page, written to
//    .wrangler/check-dash/ (git-ignored) and given to "node --check".
// 2. Behavior. The page script runs in a small stand-in for the browser (elements, timers,
//    fetch and Leaflet are fakes) against the real dashboard API of src/dash.ts, on the sqlite
//    database double of the tests, filled through the real ingest handler. Those are
//    TypeScript, so this file bundles itself with the esbuild that wrangler installed, like
//    run-tests.mjs does for the tests, and runs the bundle with CHECK_DASH_STAGE=behavior.
//
// The stand-in has no layout and no real Leaflet. How the page looks still needs a browser.
// Nothing here talks to Cloudflare or to the network. Exits non-zero when a check fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CHECK_DASH_STAGE === "behavior") process.exit(await behavior());

const self = fileURLToPath(import.meta.url);
const root = join(dirname(self), "..");
const outDir = join(root, ".wrangler", "check-dash");
// Start clean so a removed script cannot leave an old file behind.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let failed = syntax(join(root, "src", "dash.html"));
if (!failed) {
  const { build } = await import("esbuild");
  const bundle = join(outDir, "behavior.mjs");
  try {
    await build({
      entryPoints: [self],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "esm",
      loader: { ".html": "text", ".sql": "text" },
      external: ["node:*", "esbuild"],
      sourcemap: "inline",
      logLevel: "warning",
    });
    const run = spawnSync(process.execPath, ["--enable-source-maps", "--disable-warning=ExperimentalWarning", bundle],
      { stdio: "inherit", env: { ...process.env, CHECK_DASH_STAGE: "behavior" } });
    failed = run.status ?? 1;
  } catch {
    // esbuild has already printed what is wrong.
    failed = 1;
  }
}
process.exit(failed ? 1 : 0);

// ------------------------------------------------------------ stage 1: syntax

function syntax(src) {
  const html = readFileSync(src, "utf8");
  const attr = (attrs, name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
    return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
  };

  const blocks = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const [, attrs, body] = m;
    if (attr(attrs, "src") != null) continue;
    const type = (attr(attrs, "type") ?? "").trim().toLowerCase();
    // Data blocks such as application/json are not JavaScript.
    if (type && type !== "module" && !/^(text|application)\/(java|ecma)script$/.test(type)) continue;
    // Line of the page on which the script body starts, so error lines match dash.html.
    const line = html.slice(0, m.index + m[0].indexOf(">") + 1).split("\n").length;
    blocks.push({ body, line, module: type === "module" });
  }

  if (!blocks.length) {
    console.error(`check-dash: no inline <script> found in ${src}`);
    return 1;
  }

  let bad = 0;
  blocks.forEach((b, i) => {
    // .cjs is parsed as a classic script and .mjs as a module, whatever package.json says.
    const file = join(outDir, `inline-${i + 1}.${b.module ? "mjs" : "cjs"}`);
    // Leading blank lines keep the line numbers the same as in dash.html.
    writeFileSync(file, "\n".repeat(b.line - 1) + b.body);
    const run = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    const lines = b.body.split("\n").length;
    if (run.status === 0) {
      console.log(`check-dash: script ${i + 1} ok (dash.html lines ${b.line} to ${b.line + lines - 1})`);
    } else {
      bad++;
      console.error(`check-dash: script ${i + 1} has a syntax error. Line numbers are those of src/dash.html.`);
      console.error((run.stderr || run.stdout || String(run.error ?? "node --check failed")).trim());
    }
  });
  return bad;
}

// ------------------------------------------------------------ stage 2: behavior

// Only runs inside the bundle. Plain node cannot resolve these imports, and never gets here.
async function behavior() {
  const { handleDash } = await import("../src/dash");
  const { makeEnv } = await import("../test/helpers/d1.mjs");
  const { drive, noLink, postChunks, restoreNow, setNow, sid, T0 } = await import("../test/helpers/drive.mjs");
  const { F } = await import("./lib/record-encode.mjs");

  const realSetTimeout = setTimeout;
  const sleep = (ms) => new Promise((done) => realSetTimeout(done, ms));
  const call = (env, path) => handleDash(new Request("https://dash.test/dash/s/" + path), env, "/" + path.split("?")[0], "/dash/s");
  const api = async (env, path) => (await call(env, path)).json();
  const html = await (await call(makeEnv(), "")).text();

  // An error inside one of the page's async functions surfaces here.
  const stray = [];
  process.on("unhandledRejection", (e) => stray.push(e));

  // Element methods the page calls that need no real behavior here. Any other method is
  // undefined, so calling it throws as it would in a browser.
  const NOOP_METHODS = new Set(["addEventListener", "removeEventListener", "setAttribute", "getAttribute", "removeAttribute", "scrollIntoView"]);

  // The page in a stand-in browser. Timers do not run by themselves: a check fires the poll
  // timer when it wants the next poll, and moves the clock with setNow(). Only the page's
  // short layout delays (up to 200 ms) run at once. `touch` makes it a phone with a touch
  // screen, `page` replaces the page text (to prove that a broken page fails). `reject` and
  // `hold` (see net below) apply from the first request on.
  function openPage(env, { hash = "", width = 600, touch = false, page: text = html, reject = null, hold = null } = {}) {
    const script = /<script>([\s\S]*?)<\/script>/.exec(text)[1];
    // Only ids that the page has. Ids built by the script appear in it as id="..." as well.
    const ids = new Set([...text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const els = new Map();
    function makeEl() {
      const store = { id: "", textContent: "", html: "", hidden: false, className: "", style: {}, dataset: {}, children: [], value: "", found: {}, classes: new Set(), next: [] };
      return new Proxy(store, {
        get(t, p) {
          if (p === "innerHTML") return t.html;
          if (p in t) return t[p];
          if (p === "clientWidth" || p === "offsetWidth") return width;
          if (p === "classList") {
            return { toggle: (c, on) => { (on ?? !t.classes.has(c)) ? t.classes.add(c) : t.classes.delete(c); }, add: (c) => t.classes.add(c), remove: (c) => t.classes.delete(c) };
          }
          if (p === "querySelector") return (sel) => (t.found[sel] ??= makeEl());
          if (p === "querySelectorAll") return () => [];
          if (p === "getBoundingClientRect") return () => ({ top: 2000, left: 0, width, height: 200 });
          if (p === "parentNode") return (t.parent ??= makeEl());
          if (p === "appendChild") return (c) => { t.children.push(c); return c; };
          // Inserts a node after this one. Kept, so a check can see it.
          if (p === "after") return (c) => { t.next.push(c); };
          if (NOOP_METHODS.has(p)) return () => undefined;
          return undefined;
        },
        set(t, p, v) {
          if (p === "innerHTML") { t.html = String(v); t.children = []; t.found = {}; } else t[p] = v;
          return true;
        },
      });
    }
    // Like document.getElementById: null for an id the page does not have.
    const $ = (id) => {
      if (!ids.has(id)) return null;
      if (!els.has(id)) { const e = makeEl(); e.id = id; els.set(id, e); }
      return els.get(id);
    };
    // The few groups the page looks up by selector, taken from the markup, so their click
    // handlers can be run. Any other selector finds nothing.
    const buttons = (attr) => [...text.matchAll(new RegExp(`<button data-${attr}="([^"]+)"`, "g"))]
      .map((m) => { const b = makeEl(); b.dataset[attr] = m[1]; return b; });
    const groups = {
      "[data-view]": buttons("view"),
      "#h-presets button": buttons("p"),
      "#h-metrics button": buttons("m"),
      ".view": [...text.matchAll(/<section class="view" id="([^"]+)"/g)].map((m) => $(m[1])),
    };

    // reject(path) and hold(path) decide per request. reject may answer "late": the request
    // then fails after the others of the same moment were answered. A held request never
    // answers, so only the page's own time limit can end it.
    const net = { log: [], busy: 0, reject, hold };
    const fetch = async (path, init = {}) => {
      net.log.push(path);
      if (net.hold && net.hold(path)) {
        await new Promise((_, no) => init.signal && init.signal.addEventListener("abort", () => no(new Error("aborted"))));
      }
      net.busy++;
      try {
        const verdict = net.reject && net.reject(path);
        if (verdict === "late") await sleep(20);
        if (verdict) throw new TypeError("Failed to fetch");
        return await call(env, path);
      } finally { net.busy--; }
    };

    const timers = [], errors = [], listeners = {}, tooltips = [];
    let every10s = null;
    const fire = (t) => { if (t.dead) return; t.dead = true; try { return t.fn(); } catch (e) { errors.push(e); } };
    const fakeSetTimeout = (fn, ms) => {
      const t = { fn, ms, dead: false };
      timers.push(t);
      if (ms <= 200) realSetTimeout(() => fire(t), 0);
      return t;
    };
    const live = () => timers.filter((t) => !t.dead && t.ms > 200);
    // The time limit of a request is the one timer whose callback aborts something.
    const isLimit = (t) => String(t.fn).includes("abort");

    // Every Leaflet call answers with Leaflet itself, so any chain of calls works.
    const leaflet = new Proxy(function () {}, {
      get: (_, k) => (typeof k === "symbol" ? undefined : (...args) => { if (k === "bindTooltip") tooltips.push(args[0]); return leaflet; }),
    });
    const doc = {
      hidden: false,
      getElementById: $,
      querySelectorAll: (sel) => groups[sel] ?? [],
      createElement: makeEl,
      addEventListener: (ev, fn) => { listeners["doc:" + ev] = fn; },
    };
    // Setting the hash fires hashchange a moment later, as in a browser. replaceState does not.
    let hashNow = hash ? "#" + hash : "";
    const loc = {
      get hash() { return hashNow; },
      set hash(v) {
        v = String(v);
        if (v && v[0] !== "#") v = "#" + v;
        if (v === hashNow) return;
        hashNow = v;
        realSetTimeout(() => { try { listeners.hashchange && listeners.hashchange(); } catch (e) { errors.push(e); } }, 0);
      },
    };
    // A touch screen matches the hover query. A max-width query is tested against `width`.
    const matchMedia = (q) => {
      const max = /max-width:\s*(\d+)px/.exec(q);
      return { matches: (touch && /hover:\s*none/.test(q)) || (!!max && width <= +max[1]) };
    };
    const win = { matchMedia, scrollTo: () => {}, L: leaflet };
    new Function("window", "document", "location", "history", "fetch", "setTimeout", "clearTimeout", "setInterval",
      "matchMedia", "addEventListener", "innerHeight", "L", script)(
      win, doc, loc, { replaceState: (a, b, h) => { hashNow = h; } }, fetch, fakeSetTimeout, (t) => { if (t) t.dead = true; },
      (fn) => { every10s = fn; return 1; }, matchMedia, (ev, fn) => { listeners[ev] = fn; }, 800, leaflet);

    const page = {
      $, net, errors, tooltips, location: loc,
      // A tap on a button of the side bar or the bottom bar.
      nav: (view) => groups["[data-view]"].find((b) => b.dataset.view === view).onclick(),
      shown: () => groups[".view"].filter((v) => v.classes.has("show")).map((v) => v.id),
      header: () => `${$("state").textContent} ${$("updated").textContent}`.trim(),
      requests: (prefix) => net.log.filter((p) => p.startsWith(prefix)).length,
      polls: () => live().filter((t) => !isLimit(t)),
      limits: () => live().filter(isLimit),
      // Waits until every request is answered and the page has drawn the answers.
      async settle() {
        for (let quiet = 0; quiet < 3;) { await sleep(8); quiet = net.busy ? 0 : quiet + 1; }
      },
      // The delay of the one pending poll.
      nextPoll() {
        const p = page.polls();
        assert.equal(p.length, 1, `expected one poll timer, found ${p.length} (${p.map((t) => t.ms)})`);
        return p[0].ms;
      },
      // What the browser does when the poll timer runs out.
      async poll() {
        page.nextPoll();
        fire(page.polls()[0]);
        await page.settle();
      },
      // The header re-check the page runs every 10 s.
      interval: () => every10s(),
    };
    return page;
  }

  // ---------------------------------------------------------------- test data
  // All times hang off T0 and the clock is pinned, so nothing depends on when this runs.
  const INST = 173;
  // One upload of everything, at `now`.
  const upload = (env, fields, now) => postChunks(env, fields, [341], { now, everyS: 0 });
  // A short legacy drive (about 3.6 miles) and the quiet readings after it: a parked car.
  async function parkedCar(env) {
    await upload(env, drive({ boot: 11, inst: 0, fw: 0, n: 300 }), T0 + 320);
    const quiet = drive({ boot: 11, inst: 0, fw: 0, n: 10, ms0: 320000, stepMs: 2000, flags: F.QUIET })
      .map((r) => ({ ...r, rpm: null, speed_kph: null }));
    await upload(env, quiet, T0 + 340);
    setNow(T0 + 4000);
  }
  // Three trips an hour apart. The middle one has an odometer start, or none at all.
  async function threeTrips(env, middleOdo) {
    await upload(env, drive({ boot: 12, n: 60 }), T0 + 100);
    await upload(env, drive({ boot: 13, n: 60, base: T0 + 3600, odo0: middleOdo }), T0 + 3700);
    await upload(env, drive({ boot: 14, n: 60, base: T0 + 7200, odo0: 127600 }), T0 + 7300);
    setNow(T0 + 8000);
  }
  const WINDOW = `from=${T0 - 600}&to=${T0 + 8000}`;

  const checks = [];
  const check = (name, fn) => checks.push([name, fn]);

  // ---------------------------------------------------------------- the API (src/dash.ts)

  check("history: the speed peak is rounded once, so the card and the chart note agree", async () => {
    const env = makeEnv();
    const fields = drive({ n: 120 });
    // 115 km/h is 71.46 mph: 71 rounded once, but 72 when it is rounded to 71.5 first.
    fields[60].speed_kph = 115;
    await upload(env, fields, T0 + 200);
    setNow(T0 + 300);
    // A short window reads the raw readings, a long one the per-minute rollup.
    for (const [from, to] of [[T0, T0 + 600], [T0 - 3600, T0 + 3600]]) {
      const h = await api(env, `api/history?from=${from}&to=${to}`);
      assert.equal(h.totals.max_mph, 71);
      assert.equal(Math.max(...h.series.speed_max.filter((v) => v != null)), 71);
      const p = openPage(env, { hash: `history/${from}-${to}` });
      await p.settle();
      assert.match(p.$("h-kpis").innerHTML, /Top speed<\/div><div class="val">71<small>mph<\/small>/);
      assert.match(p.$("h-chart").innerHTML, /Highest single reading in this period: <b>71 mph<\/b>/);
      assert.deepEqual(p.errors, []);
    }
  });

  check("history: unlogged miles are unknown, not 0, when a trip in the chain has no odometer", async () => {
    const env = makeEnv();
    await threeTrips(env, null);
    assert.equal((await api(env, `api/history?${WINDOW}`)).totals.unlogged_mi, null);

    const known = makeEnv();
    await threeTrips(known, 126800);
    const h = await api(known, `api/history?${WINDOW}`);
    assert.equal(h.trips.length, 3);
    assert.ok(h.totals.unlogged_mi > 40, `unlogged_mi ${h.totals.unlogged_mi}`);
    assert.equal(h.totals.unlogged_mi, Math.round(h.trips.reduce((a, t) => a + (t.unlogged_before_mi ?? 0), 0) * 10) / 10);
  });

  check("trip: unlogged_known says the same inside the trip and beside it", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    const last = await api(env, `api/trip/${sid(14, INST)}`);
    assert.ok(last.trip.unlogged_before_mi > 40);
    assert.deepEqual([last.unlogged_known, last.trip.unlogged_known], [true, true]);
    // No trip came before the first one, so nothing is missing before it.
    const first = await api(env, `api/trip/${sid(12, INST)}`);
    assert.deepEqual([first.unlogged_known, first.trip.unlogged_known, first.trip.unlogged_before_mi], [true, true, null]);

    const gap = makeEnv();
    await threeTrips(gap, null);
    const unknown = await api(gap, `api/trip/${sid(14, INST)}`);
    assert.deepEqual([unknown.unlogged_known, unknown.trip.unlogged_known, unknown.trip.unlogged_before_mi], [false, false, null]);
  });

  check("economy: no 30-day average under the minimum of logged miles, same as status", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const [few, st] = [await api(env, "api/economy?days=30"), await api(env, "api/status")];
    assert.equal(st.mpg30_min_miles, 25);
    assert.ok(few.miles > 1 && few.miles < st.mpg30_min_miles, `miles ${few.miles}`);
    assert.deepEqual([few.mpg, st.mpg30], [null, null]);
    // Both round the miles down, so the chip and the card show the same number.
    assert.equal(few.miles, st.mpg30_miles);

    // About 29 miles in one drive.
    const far = makeEnv();
    await upload(far, drive({ n: 2400 }), T0 + 2500);
    setNow(T0 + 4000);
    const [enough, st2] = [await api(far, "api/economy?days=30"), await api(far, "api/status")];
    assert.ok(enough.miles >= 25, `miles ${enough.miles}`);
    assert.equal(typeof enough.mpg, "number");
    assert.equal(enough.mpg, st2.mpg30);
    assert.equal(enough.miles, st2.mpg30_miles);
  });

  // ---------------------------------------------------------------- the page (src/dash.html)

  check("overview: the empty Fuel economy card says why, and the chip beside it shows no average", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env);
    await p.settle();
    assert.equal(p.header(), "Parked · updated 1.0 h ago");
    assert.equal(p.$("k-mpg").innerHTML, "–");
    assert.match(p.$("k-mpg-d").textContent, /^Too few miles logged in the last 30 days \(3\.\d of 25\)$/);
    assert.match(p.$("o-econ-chip").textContent, /^3\.\d mi logged$/);
    assert.deepEqual(p.errors, []);
  });

  check("overview: with the adapter link down the location is not called parked", async () => {
    const env = makeEnv();
    const fields = drive({ fw: 3, n: 60 });
    for (let ms = 80000; ms <= 200000; ms += 30000) fields.push(noLink({ ms }));
    await upload(env, fields, T0 + 201);
    setNow(T0 + 230);
    const p = openPage(env);
    await p.settle();
    assert.equal(p.header(), "Adapter link down · updated 29s ago");
    assert.equal(p.$("o-loc-sub").textContent, "Adapter link down · 30s ago");
    assert.deepEqual(p.tooltips, ["Latest position"]);
    assert.deepEqual(p.errors, []);
  });

  check("live: the banner gives the age of the newest reading, not of the last upload", async () => {
    const env = makeEnv();
    // The newest reading is from T0 + 139. It was uploaded more than two minutes later.
    await upload(env, drive({ n: 120 }), T0 + 280);
    setNow(T0 + 339);
    const p = openPage(env, { hash: "live" });
    await p.settle();
    assert.match(p.header(), /^No signal since /);
    assert.match(p.$("l-banner-t").innerHTML, /Showing the last readings from 3 min ago\.$/);
    assert.deepEqual(p.errors, []);
  });

  check("charts: a narrow chart gets three time labels, a wide one five", async () => {
    const env = makeEnv();
    await parkedCar(env);
    for (const [width, labels] of [[305, 3], [479, 3], [480, 5], [600, 5]]) {
      const p = openPage(env, { width });
      await p.settle();
      // The Last drive chart is 200 high, and its time labels sit 5 above the bottom edge.
      const svg = p.$("o-drive").innerHTML;
      assert.equal((svg.match(/<text x="[^"]+" y="195"/g) ?? []).length, labels, `width ${width}`);
      assert.equal((svg.match(/y="195" text-anchor="start"/g) ?? []).length, 1, `width ${width}`);
      assert.equal((svg.match(/y="195" text-anchor="end"/g) ?? []).length, 1, `width ${width}`);
    }
  });

  check("history: the hover value has a line of its own, outside the card head", async () => {
    const id = html.indexOf('id="h-readout"');
    assert.ok(id > 0, "no element with id h-readout");
    const tag = html.lastIndexOf("<", id);
    // Divs opened and closed between the last card head before it and the element itself.
    const between = html.slice(html.lastIndexOf('<div class="card-head"', tag), tag);
    const open = (between.match(/<div\b/g) ?? []).length, closed = (between.match(/<\/div>/g) ?? []).length;
    assert.ok(open <= closed, "h-readout is inside a card head again");
    // Room for two lines, so a long value cannot push the chart down either.
    assert.match(html.slice(tag, html.indexOf(">", id)), /^<div class="readout"[^>]*min-height/);
  });

  check("live: a watched drive is not paused by a long gap in the uploads", async () => {
    const env = makeEnv();
    await upload(env, drive({ n: 120 }), T0 + 140);
    setNow(T0 + 145);
    const p = openPage(env, { hash: "live" });
    await p.settle();
    assert.equal(p.header(), "Engine running · updated just now");

    // The drive goes on for 16 minutes and nobody touches the screen. That is past the idle
    // pause, which does not apply here.
    for (const ms0 of [140000, 460000, 780000]) {
      await upload(env, drive({ n: 320, ms0 }), T0 + ms0 / 1000 + 320);
      setNow(T0 + ms0 / 1000 + 321);
      await p.poll();
      assert.equal(p.header(), "Engine running · updated just now");
      assert.equal(p.nextPoll(), 15000);
    }

    // 11 minutes without an upload. The state falls back to parked, the polling goes on.
    setNow(T0 + 1099 + 660);
    await p.poll();
    assert.match(p.header(), /^Parked · logger went offline mid-drive/);
    assert.equal(p.nextPoll(), 60000);

    // Coverage is back and the stored readings arrive.
    await upload(env, drive({ n: 660, ms0: 1100000 }), T0 + 1760);
    setNow(T0 + 1765);
    await p.poll();
    assert.equal(p.header(), "Engine running · updated just now");
    assert.equal(p.nextPoll(), 15000);

    // Two hours of silence end the exception.
    setNow(T0 + 1759 + 7300);
    await p.poll();
    assert.equal(p.header(), "Paused · tap to resume");
    assert.equal(p.polls().length, 0);
    assert.deepEqual(p.errors, []);
  });

  check("a failed first request for the last drive, the trips or the economy is asked again", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const failedOnce = new Set();
    const p = openPage(env);
    // The first request of each kind fails. "api/trip/" is the per-minute series of the last drive.
    p.net.reject = (path) => {
      const kind = ["api/trips", "api/economy", "api/trip/"].find((k) => path.startsWith(k));
      if (!kind || failedOnce.has(kind)) return false;
      failedOnce.add(kind);
      return true;
    };
    await p.settle();
    assert.deepEqual([p.requests("api/trips"), p.requests("api/economy"), p.requests("api/trip/")], [1, 1, 0]);

    // The next poll asks for trips and economy again. The trip list then asks for the last drive.
    await p.poll();
    assert.deepEqual([p.requests("api/trips"), p.requests("api/economy"), p.requests("api/trip/")], [2, 2, 1]);
    assert.equal(p.$("o-trips-chip").textContent, "1 total");
    assert.match(p.$("o-econ-chip").textContent, /mi logged$/);
    assert.equal(p.$("o-drive-chip").textContent, "");

    // That one failed too. It is asked again with the next trip list, on the sixth poll.
    for (let i = 0; i < 5; i++) await p.poll();
    assert.deepEqual([p.requests("api/trips"), p.requests("api/trip/")], [3, 2]);
    assert.match(p.$("o-drive-chip").textContent, /^top \d+ mph$/);
    assert.equal(p.header(), "Parked · updated 1.0 h ago");
    assert.deepEqual(p.errors, []);
  });

  check("after a failed request the next poll comes early, twice, then at the normal rate", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env);
    await p.settle();
    assert.equal(p.nextPoll(), 60000);

    p.net.reject = () => true;
    await p.poll();
    assert.equal(p.header(), "No connection to the server · last data 1.0 h ago");
    assert.equal(p.nextPoll(), 5000);
    setNow(T0 + 4005);
    await p.poll();
    assert.equal(p.nextPoll(), 5000);
    setNow(T0 + 4010);
    await p.poll();
    assert.equal(p.nextPoll(), 60000);

    p.net.reject = null;
    setNow(T0 + 4070);
    await p.poll();
    assert.equal(p.header(), "Parked · updated 1.0 h ago");
    assert.equal(p.nextPoll(), 60000);

    // A request beside the poll fails, after the poll and the trip list were answered.
    setNow(T0 + 4200);
    await p.poll();
    p.net.reject = (path) => path.startsWith("api/economy") && "late";
    await p.poll(); // the sixth poll of this page reloads trips and economy
    assert.equal(p.requests("api/economy"), 2);
    assert.match(p.header(), /^No connection to the server/);
    assert.equal(p.nextPoll(), 5000);
    p.net.reject = null;
    setNow(T0 + 4205);
    await p.poll();
    assert.equal(p.header(), "Parked · updated 1.1 h ago");
    assert.equal(p.nextPoll(), 60000);
    assert.deepEqual(p.errors, []);
  });

  check("one request that keeps failing is asked once more, then every sixth poll, and the header shows the car", async () => {
    const env = makeEnv();
    await parkedCar(env);
    // It fails after the others of the same moment were answered, so nothing clears the error.
    const p = openPage(env, { reject: (path) => path.startsWith("api/economy") && "late" });
    await p.settle();
    // After each poll: the delay of the next one, economy requests so far, whether the header
    // shows the car. The economy request fails at the start and is asked once more on the next
    // poll. After that only every sixth poll asks, and each such failure gets one early poll,
    // whose answer puts the car back in the header.
    const seen = [[p.nextPoll(), p.requests("api/economy"), /^Parked · updated/.test(p.header())]];
    let t = T0 + 4000;
    for (let i = 1; i <= 13; i++) {
      t += p.nextPoll() / 1000;
      setNow(t);
      await p.poll();
      seen.push([p.nextPoll(), p.requests("api/economy"), /^Parked · updated/.test(p.header())]);
    }
    const rest = (k, count) => Array.from({ length: k }, () => [60000, count, true]);
    assert.deepEqual(seen, [
      [5000, 1, false], [60000, 2, false], ...rest(4, 2),
      [5000, 3, false], ...rest(5, 3),
      [5000, 4, false], ...rest(1, 4),
    ]);
    assert.deepEqual(p.errors, []);
  });

  check("after an outage at page open, the trip list and the economy load on the first answered poll", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env, { reject: () => true });
    await p.settle();
    let t = T0 + 4000;
    for (let i = 0; i < 3; i++) { t += p.nextPoll() / 1000; setNow(t); await p.poll(); }
    assert.equal(p.$("o-trips-chip").textContent, "");
    // Failures during the outage do not use up the early retry of the trip list and economy.
    p.net.reject = null;
    t += p.nextPoll() / 1000; setNow(t);
    await p.poll();
    assert.equal(p.$("o-trips-chip").textContent, "1 total");
    assert.match(p.$("o-econ-chip").textContent, /mi logged$/);
    assert.match(p.header(), /^Parked · updated/);
    assert.deepEqual(p.errors, []);
  });

  check("a request that never answers is given up, reported, and the polling goes on", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env);
    await p.settle();
    assert.equal(p.limits().length, 0, "the time limit of an answered request is cleared");

    p.net.hold = (path) => path.startsWith("api/status");
    await p.poll();
    assert.equal(p.polls().length, 0);
    assert.deepEqual(p.limits().map((t) => t.ms), [30000]);
    assert.equal(p.header(), "Parked · updated 1.0 h ago");

    // 30 s later the page gives the request up.
    p.net.hold = null;
    setNow(T0 + 4030);
    p.limits()[0].fn();
    await p.settle();
    assert.equal(p.header(), "No connection to the server · last data 1.0 h ago");
    assert.equal(p.nextPoll(), 5000);
    setNow(T0 + 4035);
    await p.poll();
    assert.equal(p.header(), "Parked · updated 1.0 h ago");
    assert.deepEqual(p.errors, []);
  });

  check("history: an older range given up late does not mark the newer one 'could not load'", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const old = T0 - 300 * 86400;
    // The long range never answers. Then a short range is picked and loads.
    const p = openPage(env, { hash: `history/${old}-${T0 + 4000}`, hold: (path) => path.startsWith(`api/history?from=${old}&`) });
    await p.settle();
    p.location.hash = `history/${T0 - 3600}-${T0 + 4000}`;
    await p.settle();
    assert.match(p.$("h-kpis").innerHTML, /Distance/);
    const label = p.$("h-label").textContent;
    // 30 s after the first pick the page gives the long range up.
    assert.deepEqual(p.limits().map((t) => t.ms), [30000]);
    p.limits()[0].fn();
    await p.settle();
    assert.equal(p.$("h-label").textContent, label);
    assert.deepEqual(p.errors, []);
  });

  check("charts: date labels under the bars are thinned on a narrow chart", async () => {
    const env = makeEnv();
    // Twelve short trips, one a day.
    for (let k = 11; k >= 0; k--) {
      const base = T0 - k * 86400;
      await upload(env, drive({ boot: 20 + k, n: 60, base, odo0: null }), base + 100);
    }
    setNow(T0 + 4000);
    // Ten of those days in History.
    const tenDays = `history/${T0 - 9 * 86400 - 600}-${T0 + 4000}`;
    for (const [width, bars, days] of [[305, 6, 5], [600, 12, 10]]) {
      const o = openPage(env, { width });
      await o.settle();
      // The MPG by trip chart is 190 high, the By day chart 200. Labels sit 5 above the bottom.
      assert.equal((o.$("o-econ").innerHTML.match(/<text [^>]*y="185"/g) ?? []).length, bars, `MPG by trip, width ${width}`);
      const h = openPage(env, { width, hash: tenDays });
      await h.settle();
      assert.equal((h.$("h-days").innerHTML.match(/<text [^>]*y="195"/g) ?? []).length, days, `By day, width ${width}`);
      assert.deepEqual([...o.errors, ...h.errors], []);
    }
  });

  check("overview: with enough miles but no fuel readings, the range card and the economy card agree", async () => {
    const env = makeEnv();
    // About 29 miles with no airflow readings, so no fuel use.
    await upload(env, drive({ n: 2400 }).map((r) => ({ ...r, maf_gs: null })), T0 + 2500);
    setNow(T0 + 4000);
    const st = await api(env, "api/status");
    assert.ok(st.mpg30 == null && st.mpg30_miles >= st.mpg30_min_miles, JSON.stringify([st.mpg30, st.mpg30_miles]));
    const p = openPage(env);
    await p.settle();
    assert.equal(p.$("k-mpg-d").textContent, "No fuel use readings in the last 30 days");
    assert.equal(p.$("k-range-d").textContent, "at EPA 19 mpg, no fuel use readings");
    assert.deepEqual(p.errors, []);
  });

  check("every view opens from its button, a trip opens from the list, and each view polls", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    // A wide desktop and a phone with a touch screen.
    for (const [width, touch] of [[1200, false], [375, true]]) {
      const p = openPage(env, { width, touch });
      await p.settle();
      assert.deepEqual(p.shown(), ["v-overview"]);
      p.$("o-trips").children[0].onclick();
      await p.settle();
      assert.deepEqual(p.shown(), ["v-trips"]);
      assert.equal(p.$("t-detail").hidden, false);
      assert.match(p.$("t-sub").textContent, new RegExp(`^Trip ${INST}-14 · `));
      assert.match(p.$("t-stats").innerHTML, /Distance/);
      await p.poll();
      for (const view of ["live", "history", "logs", "overview"]) {
        p.nav(view);
        await p.settle();
        assert.deepEqual(p.shown(), ["v-" + view]);
        if (view === "logs") {
          assert.match(p.$("g-health").innerHTML, /Last upload/);
          assert.equal((p.$("g-boots").innerHTML.match(/<tr>/g) ?? []).length, 4);
        }
        await p.poll();
      }
      // On a touch screen each map says how to move it.
      assert.deepEqual(p.$("o-map").next.map((e) => e.textContent), touch ? ["Use two fingers to move the map."] : []);
      assert.deepEqual(p.errors, []);
    }
  });

  check("the stand-in fails a page with a missing id or a broken Trips or Logs view", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    const mutants = [
      ["the markup loses an id", "", 'id="k-mpg-d"', 'id="k-mpg-x"'],
      ["Logs writes to an id that does not exist", "logs", '$("g-health").innerHTML', '$("g-healthz").innerHTML'],
      ["the trip view calls a function that does not exist", "trips", '$("t-sub").textContent = tripSub(t);', '$("t-sub").textContent = tripSubX(t);'],
      ["Logs reads a field that does not exist", "logs", "d.stats.hour || {}", "d.stats.hourly.x || {}"],
    ];
    for (const [name, hash, from, to] of mutants) {
      assert.ok(html.includes(from), `the page changed, so this no longer applies: ${name}`);
      const p = openPage(env, { hash, page: html.replace(from, () => to) });
      await p.settle();
      await sleep(0);
      assert.ok(p.errors.length + stray.splice(0).length > 0, `no error for: ${name}`);
    }
  });

  // ---------------------------------------------------------------- run
  let bad = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      await sleep(0);
      if (stray.length) throw stray.splice(0)[0];
      console.log(`check-dash: ok    ${name}`);
    } catch (e) {
      bad++;
      console.error(`check-dash: FAIL  ${name}`);
      console.error(String((e && e.stack) || e).replace(/^/gm, "    "));
    }
    restoreNow();
  }
  console.log(bad ? `check-dash: ${bad} of ${checks.length} behavior checks failed` : `check-dash: all ${checks.length} behavior checks passed`);
  return bad ? 1 : 0;
}

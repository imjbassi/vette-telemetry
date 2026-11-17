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
//    run-tests.mjs does for the tests, and runs the bundle with CHECK_DASH_STAGE=behavior and
//    TZ=America/Los_Angeles.
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
    // The car's zone (LOCAL_TZ of wrangler.toml), so local days and midnights come out the same
    // on every machine.
    const run = spawnSync(process.execPath, ["--enable-source-maps", "--disable-warning=ExperimentalWarning", bundle],
      { stdio: "inherit", env: { ...process.env, CHECK_DASH_STAGE: "behavior", TZ: "America/Los_Angeles" } });
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
  // The pages the running check opened, for the run loop to look at afterwards.
  const opened = [];

  // Element methods the page calls that need no real behavior here. Any other method is
  // undefined, so calling it throws as it would in a browser.
  const NOOP_METHODS = new Set(["addEventListener", "removeEventListener", "setAttribute", "getAttribute", "removeAttribute", "scrollIntoView"]);

  // The page in a stand-in browser. Timers do not run by themselves: a check fires the poll
  // timer when it wants the next poll, and moves the clock with setNow(). new Date() reads
  // that clock too. Only the page's short layout delays (up to 200 ms) run at once. `width` is
  // the window width, which page.setWidth() changes later. The page reads it as
  // window.innerWidth or an element's clientWidth, never as a bare innerWidth, which does not
  // exist here. `touch` makes it a phone with a touch screen, `page` replaces the page text (to
  // prove that a broken page fails). `reject` and `hold` (see net below) apply from the first
  // request on.
  function openPage(env, { hash = "", width = 600, touch = false, page: text = html, reject = null, hold = null } = {}) {
    const script = /<script>([\s\S]*?)<\/script>/.exec(text)[1];
    // Only ids that the page has. Ids built by the script appear in it as id="..." as well.
    const ids = new Set([...text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const els = new Map();
    function makeEl() {
      const store = { id: "", textContent: "", html: "", hidden: false, style: {}, dataset: {}, children: [], value: "", found: {}, classes: new Set(), next: [] };
      // className and classList are two views of the same classes, as in a browser.
      const classList = {
        add: (...cs) => { for (const c of cs) store.classes.add(c); },
        remove: (...cs) => { for (const c of cs) store.classes.delete(c); },
        toggle: (c, on) => { const want = on ?? !store.classes.has(c); if (want) store.classes.add(c); else store.classes.delete(c); return want; },
        contains: (c) => store.classes.has(c),
      };
      return new Proxy(store, {
        get(t, p) {
          if (p === "innerHTML") return t.html;
          if (p === "className") return [...t.classes].join(" ");
          if (p === "classList") return classList;
          if (p in t) return t[p];
          if (p === "clientWidth" || p === "offsetWidth") return width;
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
          if (p === "innerHTML") { t.html = String(v); t.children = []; t.found = {}; }
          else if (p === "className") t.classes = new Set(String(v).split(/\s+/).filter(Boolean));
          else t[p] = v;
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
    // answers, so only the page's own time limit can end it. edit(path, answer) may change a
    // JSON answer in place before the page reads it, as a newer Worker would answer.
    const net = { log: [], busy: 0, reject, hold, edit: null };
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
        const res = await call(env, path);
        if (!net.edit || !res.ok) return res;
        const answer = await res.json();
        net.edit(path, answer);
        return new Response(JSON.stringify(answer), { status: res.status, headers: res.headers });
      } finally { net.busy--; }
    };

    // calls: the name of every Leaflet method the page called, in order. fills: the fill color
    // of every setStyle call, which is how a marker gets its color.
    const timers = [], errors = [], listeners = {}, tooltips = [], calls = [], pushed = [], fills = [];
    let reloads = 0;
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
      get: (_, k) => (typeof k === "symbol" ? undefined : (...args) => {
        calls.push(k);
        if (k === "bindTooltip") tooltips.push(args[0]);
        if (k === "setStyle") fills.push(args[0] && args[0].fillColor);
        return leaflet;
      }),
    });
    const doc = {
      hidden: false,
      getElementById: $,
      querySelectorAll: (sel) => groups[sel] ?? [],
      createElement: makeEl,
      addEventListener: (ev, fn) => { listeners["doc:" + ev] = fn; },
    };
    // Setting the hash fires hashchange a moment later, as in a browser. replaceState and
    // pushState do not. reload() only counts: the page stays as it is.
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
      reload: () => { reloads++; },
    };
    const hist = {
      replaceState: (a, b, h) => { hashNow = h; },
      pushState: (a, b, h) => { pushed.push(h); hashNow = h; },
    };
    // A touch screen matches the hover query. A max-width query is tested against `width`.
    const matchMedia = (q) => {
      const max = /max-width:\s*(\d+)px/.exec(q);
      return { matches: (touch && /hover:\s*none/.test(q)) || (!!max && width <= +max[1]) };
    };
    const win = {
      matchMedia, scrollTo: () => {}, L: leaflet,
      get innerWidth() { return width; },
      set innerWidth(w) { width = w; },
    };
    // Without arguments a Date is the pinned clock of setNow(), like Date.now(), so ranges
    // such as "7 days" follow it.
    const PageDate = class extends Date { constructor(...a) { super(...(a.length ? a : [Date.now()])); } };
    new Function("window", "document", "location", "history", "fetch", "setTimeout", "clearTimeout", "setInterval",
      "matchMedia", "addEventListener", "innerHeight", "L", "Date", script)(
      win, doc, loc, hist, fetch, fakeSetTimeout, (t) => { if (t) t.dead = true; },
      (fn) => { every10s = fn; return 1; }, matchMedia, (ev, fn) => { listeners[ev] = fn; }, 800, leaflet, PageDate);

    const page = {
      $, net, errors, tooltips, calls, pushed, fills, listeners, doc, groups, location: loc,
      // How often the page asked for a reload.
      reloads: () => reloads,
      // The window becomes `w` wide. Nothing is fired: a check fires listeners.resize() itself.
      setWidth: (w) => { win.innerWidth = w; },
      // The tab goes to the background (false) or comes back (true).
      visible: (on) => { doc.hidden = !on; listeners["doc:visibilitychange"](); },
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
    opened.push(page);
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

  check("history: 0 % fuel readings from one bad reply are left out of the fuel figures", async () => {
    const env = makeEnv();
    // The tank reads about 62 %. One bad PID 2F reply is carried into ten records.
    const fields = drive({ n: 180 }).map((r, i) => (i >= 90 && i < 100 ? { ...r, fuel_raw: 0 } : r));
    await upload(env, fields, T0 + 300);
    setNow(T0 + 400);
    // The raw readings, then the per-minute rollup.
    for (const [from, to] of [[T0, T0 + 600], [T0 - 3600, T0 + 3600]]) {
      const h = await api(env, `api/history?from=${from}&to=${to}`);
      const fuel = h.series.fuel.filter((v) => v != null);
      assert.ok(fuel.length > 1, `${h.source}: ${fuel.length} fuel points`);
      assert.ok(Math.min(...fuel) > 60, `${h.source}: lowest fuel point ${Math.min(...fuel)}`);
      assert.ok(h.totals.fuel_min > 60 && h.totals.fuel_max < 63, `${h.source}: fuel ${h.totals.fuel_min} to ${h.totals.fuel_max}`);
    }
  });

  check("history: unlogged miles are unknown, not 0, when a trip in the chain has no odometer", async () => {
    const env = makeEnv();
    await threeTrips(env, null);
    const unknown = await api(env, `api/history?${WINDOW}`);
    assert.equal(unknown.totals.unlogged_mi, null);
    // No gap of this chain is known, so there is no floor either.
    assert.equal(unknown.totals.unlogged_mi_at_least, null);

    const known = makeEnv();
    await threeTrips(known, 126800);
    const h = await api(known, `api/history?${WINDOW}`);
    assert.equal(h.trips.length, 3);
    assert.ok(h.totals.unlogged_mi > 40, `unlogged_mi ${h.totals.unlogged_mi}`);
    assert.equal(h.totals.unlogged_mi, Math.round(h.trips.reduce((a, t) => a + (t.unlogged_before_mi ?? 0), 0) * 10) / 10);
    assert.equal(h.totals.unlogged_mi_at_least, null);
  });

  check("history: odometer distance, a floor for unlogged miles, rough MPG and where the data starts", async () => {
    const env = makeEnv();
    // Four trips an hour apart. The odometer is ahead before the second one, and the third never
    // answered it, so one gap is known and the two around the third are not.
    const trips = [
      drive({ boot: 12, n: 60 }),
      drive({ boot: 13, n: 60, base: T0 + 3600, odo0: 127000 }),
      drive({ boot: 14, n: 60, base: T0 + 7200, odo0: null }),
      drive({ boot: 15, n: 60, base: T0 + 10800, odo0: 127600 }),
    ];
    for (const [i, fields] of trips.entries()) await upload(env, fields, T0 + 100 + i * 3600);
    setNow(T0 + 11500);
    const h = await api(env, `api/history?from=${T0 - 600}&to=${T0 + 11500}`);
    const gap = h.trips.find((t) => t.id === sid(13, INST)).unlogged_before_mi;
    assert.ok(gap > 15, `gap before the second trip ${gap}`);
    assert.deepEqual([h.totals.unlogged_mi, h.totals.unlogged_mi_at_least], [null, gap]);
    // From the first odometer reading of the first trip to the last of the fourth.
    const span = Math.round((trips[3].at(-1).odo_km - trips[0][0].odo_km) * 0.621371 * 10) / 10;
    assert.equal(h.totals.odometer_mi, span);
    assert.ok(span > h.totals.miles + 30, `${span} mi by odometer, ${h.totals.miles} logged`);
    // Under 3 logged miles: the MPG is there, flagged as resting on too few miles.
    assert.equal(typeof h.totals.mpg, "number");
    assert.equal(h.totals.mpg_few_miles, true);
    assert.ok(h.totals.miles_down <= h.totals.miles && h.totals.miles_down > h.totals.miles - 0.11, `miles_down ${h.totals.miles_down}`);
    // The first trip starts inside this window.
    assert.equal(h.data_starts, T0 + 20);

    // A window that holds only part of a trip has no odometer figure for it.
    assert.equal((await api(env, `api/history?from=${T0 + 30}&to=${T0 + 3000}`)).totals.odometer_mi, null);
    // No data at all yet.
    assert.equal((await api(makeEnv(), `api/history?${WINDOW}`)).data_starts, null);

    // About 29 logged miles: a solid figure.
    const far = makeEnv();
    await upload(far, drive({ n: 2400 }), T0 + 2500);
    setNow(T0 + 4000);
    const solid = await api(far, `api/history?from=${T0}&to=${T0 + 4000}`);
    assert.ok(solid.totals.miles_down >= 25, `miles ${solid.totals.miles_down}`);
    assert.deepEqual([typeof solid.totals.mpg, solid.totals.mpg_few_miles], ["number", false]);
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

  check("trip: the battery at power-up comes from a quiet first reading under 13 V", async () => {
    const env = makeEnv();
    // The logger wakes up 10 s before the engine starts: one quiet record at 12.3 V.
    const wake = { boot: 12, inst: INST, fw: 2, ms: 10000, epoch: T0 + 10, flags: F.QUIET, adapter_v: 12.3, csq: 20 };
    await upload(env, [wake, ...drive({ n: 60 })], T0 + 100);
    setNow(T0 + 200);
    const t = await api(env, `api/trip/${sid(12, INST)}`);
    assert.equal(t.battery_start_v, 12.3);
    // A session whose first record already has the engine running says nothing.
    const running = makeEnv();
    await upload(running, drive({ n: 60 }), T0 + 100);
    assert.equal((await api(running, `api/trip/${sid(12, INST)}`)).battery_start_v, null);
    // Neither does a first record at a charger's voltage.
    const charger = makeEnv();
    await upload(charger, [{ ...wake, adapter_v: 13.6 }, ...drive({ n: 60 })], T0 + 100);
    assert.equal((await api(charger, `api/trip/${sid(12, INST)}`)).battery_start_v, null);
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
    // Under 5 miles there is not even a rough figure.
    assert.equal(st.mpg30_rough, null);

    // About 14 miles: no average yet, but a rough figure from the same miles and gallons.
    const mid = makeEnv();
    await upload(mid, drive({ n: 1200 }), T0 + 1300);
    setNow(T0 + 4000);
    const [some, st1] = [await api(mid, "api/economy?days=30"), await api(mid, "api/status")];
    assert.ok(some.miles >= 5 && some.miles < 25, `miles ${some.miles}`);
    assert.equal(st1.mpg30, null);
    assert.equal(st1.mpg30_rough, Math.round((some.miles / some.gallons) * 10) / 10);

    // About 29 miles in one drive.
    const far = makeEnv();
    await upload(far, drive({ n: 2400 }), T0 + 2500);
    setNow(T0 + 4000);
    const [enough, st2] = [await api(far, "api/economy?days=30"), await api(far, "api/status")];
    assert.ok(enough.miles >= 25, `miles ${enough.miles}`);
    assert.equal(typeof enough.mpg, "number");
    assert.equal(enough.mpg, st2.mpg30);
    assert.equal(enough.miles, st2.mpg30_miles);
    assert.equal(st2.mpg30_rough, null);
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
    assert.deepEqual(p.fills, ["#ef4444"]);
    assert.deepEqual(p.errors, []);
  });

  check("location: a cut-off drive is last known, and a fix behind the newest reading is a grey last fix", async () => {
    // A drive whose end never arrived.
    const cut = makeEnv();
    await upload(cut, drive({ n: 60 }), T0 + 80);
    setNow(T0 + 740);
    const a = openPage(cut);
    await a.settle();
    assert.match(a.header(), /^Parked · logger went offline mid-drive/);
    assert.equal(a.$("o-loc-sub").textContent, "Last known · 11 min ago");
    assert.deepEqual(a.tooltips, ["Last position before the logger went offline"]);
    assert.deepEqual(a.fills, ["#ef4444"]);

    // The engine runs, but the last two minutes of readings came without a fix.
    const lost = makeEnv();
    await upload(lost, [...drive({ n: 60 }), ...drive({ n: 120, ms0: 80000, gps: false })], T0 + 200);
    setNow(T0 + 205);
    const b = openPage(lost);
    await b.settle();
    assert.equal(b.header(), "Engine running · updated just now");
    assert.equal(b.$("o-loc-sub").textContent, "Last fix · 2 min ago");
    assert.deepEqual(b.tooltips, ["Last GPS fix, 2 min before the last report"]);
    assert.deepEqual(b.fills, ["#8b8f9a"]);
    b.nav("live");
    await b.settle();
    assert.match(b.$("l-gauges").innerHTML, /<div class="delta">Last fix 2 min before the newest reading<\/div>/);
    b.nav("logs");
    await b.settle();
    assert.match(b.$("g-health").innerHTML, /GPS<\/div><div class="val ">No fix<\/div><div class="delta">Last fix 2 min before the newest reading</);

    // Parked in a garage: the fix was lost three minutes before the engine stopped. That is
    // still where the car stands.
    const garage = makeEnv();
    const off = drive({ n: 10, ms0: 260000, stepMs: 2000, flags: F.QUIET, gps: false }).map((r) => ({ ...r, rpm: null, speed_kph: null }));
    await upload(garage, [...drive({ n: 60 }), ...drive({ n: 180, ms0: 80000, gps: false }), ...off], T0 + 300);
    setNow(T0 + 400);
    const c = openPage(garage);
    await c.settle();
    assert.match(c.header(), /^Parked · updated /);
    assert.equal(c.$("o-loc-sub").textContent, "Parked · 5 min ago");
    assert.deepEqual(c.tooltips, ["Parked here"]);
    assert.deepEqual(c.fills, ["#ef4444"]);

    // Two minutes after the last reading the logger powers up again and gets no fix. The fix is
    // under 10 minutes old, but from the session before.
    const later = makeEnv();
    await parkedCar(later);
    const wake = drive({ boot: 12, n: 10, base: T0 + 400, stepMs: 2000, flags: F.QUIET, gps: false }).map((r) => ({ ...r, rpm: null, speed_kph: null }));
    await upload(later, wake, T0 + 440);
    setNow(T0 + 500);
    const d = openPage(later);
    await d.settle();
    assert.match(d.header(), /^Parked · updated /);
    assert.equal(d.$("o-loc-sub").textContent, "Last fix · 3 min ago");
    assert.deepEqual(d.tooltips, ["Last GPS fix, from an earlier power-up"]);
    assert.deepEqual(d.fills, ["#8b8f9a"]);
    d.nav("logs");
    await d.settle();
    assert.match(d.$("g-health").innerHTML, /GPS<\/div><div class="val ">No fix<\/div><div class="delta">No fix since the logger started</);
    assert.deepEqual([...a.errors, ...b.errors, ...c.errors, ...d.errors], []);
  });

  check("logs: the GPS card gives the age of the fix, and no card or table prints coordinates", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env, { hash: "logs" });
    await p.settle();
    const health = p.$("g-health").innerHTML, raw = p.$("g-raw").innerHTML;
    assert.match(health, /GPS<\/div><div class="val ">9<small>sats<\/small><\/div><div class="delta">Last fix 1\.0 h ago</);
    assert.match(raw, /<th>GPS<\/th>/);
    assert.match(raw, /<span class="tag ok">fix<\/span>/);
    for (const text of [health, raw]) assert.doesNotMatch(text, /\d+\.\d{5}, -?\d+\.\d{5}/);
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

  check("live: during an outage or a pause the banner says what the header says", async () => {
    const env = makeEnv();
    await upload(env, drive({ n: 120 }), T0 + 140);
    setNow(T0 + 145);
    const p = openPage(env, { hash: "live" });
    await p.settle();
    // The first look of the 10 s re-check, so the next one only redraws on a change.
    p.interval();
    const banner = () => p.$("l-banner-t").innerHTML;
    assert.match(banner(), /Engine running\.<\/b> Updates arrive about every 15 s\.$/);
    assert.equal(p.$("l-dot").className, "dot on");

    // Every request fails. The banner changes with the header, before any re-check.
    p.net.reject = () => true;
    await p.poll();
    assert.match(p.header(), /^No connection to the server · /);
    assert.equal(p.$("l-dot").className, "dot bad");
    assert.match(banner(), /^<b [^>]*>No connection to the server\.<\/b> Showing the last readings from just now\.$/);
    // Two minutes on, the drive is no longer called running and the age has moved.
    setNow(T0 + 265);
    p.interval();
    assert.doesNotMatch(banner(), /Engine running/);
    assert.equal(p.$("l-dot").className, "dot bad");
    assert.match(banner(), /No connection to the server\.<\/b> Showing the last readings from 2 min ago\.$/);

    // A parked car, the Live view left alone for 16 minutes.
    const env2 = makeEnv();
    await parkedCar(env2);
    const q = openPage(env2, { hash: "live" });
    await q.settle();
    assert.match(q.$("l-banner-t").innerHTML, /Engine off\.<\/b> Showing the last readings from 1\.0 h ago\.$/);
    setNow(T0 + 4960);
    await q.poll();
    assert.equal(q.header(), "Paused · tap to resume");
    assert.equal(q.$("l-dot").className, "dot");
    assert.match(q.$("l-banner-t").innerHTML, /^<b [^>]*>Paused\.<\/b> Tap to resume\. Showing the last readings from 1\.3 h ago\.$/);
    q.listeners.pointerdown();
    await q.settle();
    assert.match(q.$("l-banner-t").innerHTML, /Engine off\.<\/b> Showing the last readings from 1\.3 h ago\.$/);
    assert.deepEqual([...p.errors, ...q.errors], []);
  });

  check("live: with the engine off the gauges are grey, name no state, and the charts say when they end", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env, { hash: "live" });
    await p.settle();
    const g = p.$("l-gauges").innerHTML;
    assert.equal((g.match(/class="card kpi gauge old"/g) ?? []).length, 10);
    assert.doesNotMatch(g, /Charging|Idling|Normal|Warming up|satellites/);
    assert.match(g, /class="bars old"/);
    // No instant MPG from the last speed and airflow of a car that stands.
    assert.match(g, /Instant MPG<\/div>\s*<div class="val">–<small>mpg/);
    // The fill of a sparkline drops under its last reading (the 300th of 310), not at the edge.
    assert.match(g, /L193\.5,34L0\.0,34Z/);
    // The time axis has no date, so the subtitles give the end of the readings.
    const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    const end = new Date((T0 + 338) * 1000);
    const wins = ["l-win", "l-win2", "l-win3", "l-win4"].map((id) => p.$(id).textContent);
    assert.deepEqual(wins, Array(4).fill(`10 minutes up to ${day.format(end)}, ${time.format(end)}`));
    assert.match(p.$("l-thr-r").innerHTML, /^avg <b>/);
    assert.match(p.$("l-cool-r").innerHTML, /^avg <b>/);

    // Overview: the voltage is an hour old, so it is grey and its word is in the past tense.
    const o = openPage(env);
    await o.settle();
    assert.equal(o.$("k-batt-d").innerHTML, "Was charging · 1.0 h ago");
    assert.equal(o.$("k-batt").className, "old");
    // Logs: the signal bars of an hour ago are grey too.
    const l = openPage(env, { hash: "logs" });
    await l.settle();
    assert.match(l.$("g-health").innerHTML, /class="bars old"/);
    assert.deepEqual([...p.errors, ...o.errors, ...l.errors], []);
  });

  check("live: speed, RPM, throttle and airflow come only from the running session and its last 10 s", async () => {
    const env = makeEnv();
    await parkedCar(env);
    // The next day a drive whose speed readings all fail. `latest` still holds yesterday's speed.
    await upload(env, drive({ boot: 12, n: 60, base: T0 + 86400 }).map((r) => ({ ...r, speed_kph: null })), T0 + 86480);
    setNow(T0 + 86485);
    const p = openPage(env, { hash: "live" });
    await p.settle();
    assert.equal(p.header(), "Engine running · updated just now");
    const g = p.$("l-gauges").innerHTML;
    assert.match(g, /Speed<\/div>\s*<div class="val">–<small>mph/);
    assert.match(g, /Instant MPG<\/div>\s*<div class="val">–<small>mpg/);
    // Only the Speed card is grey, with the age of the speed it no longer shows.
    assert.equal((g.match(/class="card kpi gauge old"/g) ?? []).length, 1);
    assert.match(g, /<div class="card kpi gauge old">[^\n]*>Speed<\/div>\s*<div class="val">–<small>mph<\/small><\/div><div class="delta">Last read 24 h ago</);

    // One session: the speed stopped coming 20 s before the newest reading.
    const env2 = makeEnv();
    await upload(env2, [...drive({ n: 60 }), ...drive({ n: 20, ms0: 80000 }).map((r) => ({ ...r, speed_kph: null }))], T0 + 100);
    setNow(T0 + 105);
    const q = openPage(env2, { hash: "live" });
    await q.settle();
    assert.equal(q.header(), "Engine running · updated just now");
    const h = q.$("l-gauges").innerHTML;
    assert.match(h, /Speed<\/div>\s*<div class="val">–<small>mph/);
    // RPM came with the newest reading, so it stays.
    assert.match(h, /Engine speed<\/div>\s*<div class="val">[^–<]+<small>rpm/);
    assert.doesNotMatch(h, / old/);
    assert.deepEqual([...p.errors, ...q.errors], []);
  });

  check("overview: during an outage the ages on the cards keep counting", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env);
    await p.settle();
    p.interval();
    assert.match(p.$("k-fuel-d").textContent, / · 1\.0 h ago$/);
    p.net.reject = () => true;
    await p.poll();
    // The header changed, so this re-check redraws anyway. The next ones would not.
    p.interval();
    setNow(T0 + 6400);
    p.interval();
    assert.match(p.header(), /^No connection to the server · last data 1\.7 h ago$/);
    assert.match(p.$("k-fuel-d").textContent, / · 1\.7 h ago$/);
    assert.match(p.$("o-loc-sub").textContent, / · 1\.7 h ago$/);
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

  check("the hidden attribute hides an element whatever its class", async () => {
    // .btn sets display and comes later. Without !important "Open in Maps" is drawn as a dead
    // button until there is a position.
    assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    assert.match(html, /<a class="btn" id="o-maps"[^>]* hidden>/);
  });

  check("live: a watched drive is not paused by a long gap in the uploads", async () => {
    const env = makeEnv();
    await upload(env, drive({ n: 120 }), T0 + 140);
    setNow(T0 + 145);
    const p = openPage(env, { hash: "live" });
    await p.settle();
    assert.equal(p.header(), "Engine running · updated just now");
    // While the engine runs nothing is grey. The speed is the one of the newest reading, and the
    // battery word is the server's.
    const g = p.$("l-gauges").innerHTML;
    assert.doesNotMatch(g, / old/);
    assert.match(g, />50<small>mph/);
    assert.match(g, /Battery<\/div>\s*<div class="val">14\.1<small>V<\/small><\/div><div class="delta"><span class="up">Charging<\/span>/);
    assert.equal(p.$("l-win").textContent, "Last 10 minutes");

    // The drive goes on for 16 minutes and nobody touches the screen. That is past the idle
    // pause, which does not apply here.
    for (const ms0 of [140000, 460000, 780000]) {
      await upload(env, drive({ n: 320, ms0 }), T0 + ms0 / 1000 + 320);
      setNow(T0 + ms0 / 1000 + 321);
      await p.poll();
      assert.equal(p.header(), "Engine running · updated just now");
      assert.equal(p.nextPoll(), 15000);
      assert.doesNotMatch(p.$("l-gauges").innerHTML, / old/);
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

  check("every view opens from its button, a trip opens from the list, and each view polls and redraws on a resize", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    // A wide desktop and a phone with a touch screen.
    for (const [width, touch] of [[1200, false], [375, true]]) {
      const p = openPage(env, { width, touch });
      // The phone turns or the window is resized: the open view draws its charts again for the
      // new width. `chart` is one chart of the view. Logs has none.
      let w = width;
      const resize = async (chart) => {
        w = w === width ? width - 40 : width;
        p.setWidth(w);
        const before = chart && p.$(chart).innerHTML;
        p.listeners.resize();
        await p.settle();
        if (chart) assert.notEqual(p.$(chart).innerHTML, before, `${chart} is drawn again after a resize`);
      };
      await p.settle();
      assert.deepEqual(p.shown(), ["v-overview"]);
      p.$("o-trips").children[0].onclick();
      await p.settle();
      assert.deepEqual(p.shown(), ["v-trips"]);
      assert.equal(p.$("t-detail").hidden, false);
      assert.match(p.$("t-sub").textContent, new RegExp(`^Trip ${INST}-14 · `));
      assert.match(p.$("t-stats").innerHTML, /Distance/);
      await resize("t-speed");
      await p.poll();
      for (const [view, chart] of [["live", "l-speed"], ["history", "h-chart"], ["logs", null], ["overview", "o-drive"]]) {
        p.nav(view);
        await p.settle();
        assert.deepEqual(p.shown(), ["v-" + view]);
        if (view === "logs") {
          assert.match(p.$("g-health").innerHTML, /Last upload/);
          assert.equal((p.$("g-boots").innerHTML.match(/<tr>/g) ?? []).length, 4);
        }
        await resize(chart);
        await p.poll();
      }
      // On a touch screen each map says how to move it.
      assert.deepEqual(p.$("o-map").next.map((e) => e.textContent), touch ? ["Use two fingers to move the map."] : []);
      assert.deepEqual(p.errors, []);
    }
  });

  check("back from the background: after 2 minutes only the status is asked, after 7 the trips and the economy too", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env);
    await p.settle();
    // Two minutes away. One status poll at once, then the usual rate.
    const before = p.net.log.length;
    p.visible(false);
    assert.equal(p.polls().length, 0, "no poll while hidden");
    setNow(T0 + 4120);
    p.visible(true);
    await p.settle();
    assert.deepEqual(p.net.log.slice(before), ["api/status"]);
    assert.equal(p.nextPoll(), 60000);
    // Seven minutes away. The trip list and the economy figures may be out of date as well.
    const asked = () => ["api/status", "api/trips", "api/economy"].map((k) => p.requests(k));
    const [status, trips, econ] = asked();
    p.visible(false);
    setNow(T0 + 4540);
    p.visible(true);
    await p.settle();
    assert.deepEqual(asked(), [status + 1, trips + 1, econ + 1]);
    assert.equal(p.nextPoll(), 60000);
    assert.match(p.header(), /^Parked · updated /);
    assert.deepEqual(p.errors, []);
  });

  check("after 15 idle minutes the page pauses, and a tap brings back the car, the trips and the economy", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env);
    await p.settle();
    setNow(T0 + 4960);
    await p.poll();
    assert.equal(p.header(), "Paused · tap to resume");
    assert.equal(p.polls().length, 0);
    const [trips, econ] = [p.requests("api/trips"), p.requests("api/economy")];
    p.listeners.pointerdown();
    await p.settle();
    assert.match(p.header(), /^Parked · updated /);
    assert.equal(p.nextPoll(), 60000);
    assert.deepEqual([p.requests("api/trips"), p.requests("api/economy")], [trips + 1, econ + 1]);
    assert.deepEqual(p.errors, []);
  });

  check("history: every preset and metric button draws, and 7 days asks for the last 7 x 24 hours", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    const p = openPage(env, { hash: "history" });
    await p.settle();
    const drawn = () => /^(<svg |<div class="empty">No readings in this period<)/.test(p.$("h-chart").innerHTML);
    const now = T0 + 8000;
    for (const b of p.groups["#h-presets button"]) {
      const before = p.net.log.length;
      b.onclick();
      await p.settle();
      const asked = p.net.log.slice(before).filter((path) => path.startsWith("api/history?"));
      assert.equal(asked.length, 1, `preset ${b.dataset.p}`);
      // 7 days are the last 168 hours, counted from the pinned clock.
      if (b.dataset.p === "7d") assert.equal(asked[0], `api/history?from=${now - 7 * 86400}&to=${now}`);
      assert.ok(b.classList.contains("active"), `preset ${b.dataset.p} is marked`);
      assert.ok(drawn(), `preset ${b.dataset.p}: ${p.$("h-chart").innerHTML.slice(0, 60)}`);
    }
    assert.ok(p.$("h-chart").innerHTML.startsWith("<svg "), "the last preset has readings to draw");
    for (const b of p.groups["#h-metrics button"]) {
      b.onclick();
      assert.ok(b.classList.contains("active"), `metric ${b.dataset.m} is marked`);
      assert.ok(drawn(), `metric ${b.dataset.m}`);
    }
    assert.deepEqual(p.errors, []);
  });

  check("a page older than the deployed one says so, and reloads when it comes back from the background", async () => {
    const env = makeEnv();
    await parkedCar(env);
    // The Worker wrote the id into the page it serves, and names the same id in its answers.
    const id = /const PAGE_ID = "([0-9a-f]{8})";/.exec(html)?.[1];
    assert.ok(id, "the served page carries its id");
    assert.ok(!html.includes("__PAGE_ID__"), "no placeholder is left in the served page");
    assert.equal((await call(env, "api/status")).headers.get("X-Page"), id);

    // The deployed page: no notice, and its id at the end of the Logs footer.
    const cur = openPage(env, { hash: "logs" });
    await cur.settle();
    assert.match(cur.header(), /^Parked · updated /);
    assert.equal(cur.$("reload").hidden, true);
    assert.ok(cur.$("foot").textContent.endsWith(` Page ${id}.`), cur.$("foot").textContent);
    cur.visible(false);
    cur.visible(true);
    await cur.settle();
    assert.equal(cur.reloads(), 0);

    // A page from before the last deploy.
    const old = openPage(env, { page: html.replace(`const PAGE_ID = "${id}";`, () => 'const PAGE_ID = "old";') });
    await old.settle();
    assert.equal(old.header(), "Parked · new version, tap to reload");
    assert.equal(old.$("reload").hidden, false);
    old.visible(false);
    old.visible(true);
    assert.equal(old.reloads(), 1);
    old.$("reload").onclick();
    assert.equal(old.reloads(), 2);
    assert.deepEqual([...cur.errors, ...old.errors], []);
  });

  check("a draw that throws during a poll leaves the next poll set, and the error is still seen", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    const [from, to] = ["d.stats.hour || {}", "d.stats.hourly.x || {}"];
    assert.ok(html.includes(from), "the page changed, so this no longer applies");
    const p = openPage(env, { hash: "logs", page: html.replace(from, () => to) });
    await p.settle();
    await sleep(0);
    assert.ok(p.errors.length + stray.splice(0).length > 0, "no error for the broken Logs view at open");
    await p.poll();
    await sleep(0);
    assert.equal(p.polls().length, 1, "the poll after the error is set");
    assert.ok(p.errors.length + stray.splice(0).length > 0, "no error for the broken Logs view in the poll");
  });

  check("live: a series the page does not know yet starts with gaps, and the polling goes on", async () => {
    const env = makeEnv();
    await upload(env, drive({ n: 120 }), T0 + 140);
    setNow(T0 + 145);
    const p = openPage(env, { hash: "live" });
    await p.settle();
    // A deploy adds a series to the live answer while the page stays open.
    p.net.edit = (path, d) => { if (path.startsWith("api/live") && d.series) d.series.extra = d.series.t.map(() => 1); };
    await upload(env, drive({ n: 20, ms0: 140000 }), T0 + 165);
    setNow(T0 + 166);
    await p.poll();
    assert.equal(p.nextPoll(), 15000);
    assert.equal(p.header(), "Engine running · updated just now");
    assert.deepEqual(p.errors, []);
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
    // Nothing left over from the check before counts against this one.
    stray.length = 0;
    opened.length = 0;
    try {
      await fn();
      await sleep(0);
      if (stray.length) throw stray.splice(0)[0];
      // However a check ends, no page it opened is left with two polls on the way.
      for (const p of opened) {
        const ms = p.polls().map((t) => t.ms);
        assert.ok(ms.length <= 1, `a page of this check ended with ${ms.length} poll timers (${ms})`);
      }
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

// Checks for the dashboard page. Usage: node scripts/check-dash.mjs
// src/dash.html is bundled as text, so neither tsc nor wrangler ever parses its script, and
// the tests in test/ never run it. A mistake there only shows up in the browser. Two stages:
//
// 1. Syntax. Every inline <script> (one without src) is pulled out of the page, written to a
//    folder of this run under .wrangler/check-dash/ (git-ignored) and given to "node --check".
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
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.CHECK_DASH_STAGE === "behavior") process.exit(await behavior());

const self = fileURLToPath(import.meta.url);
const root = join(dirname(self), "..");
const buildRoot = join(root, ".wrangler", "check-dash");
// Every run writes into a folder of its own, like run-tests.mjs. npm run deploy runs this as
// well, and two runs in one checkout used to share one folder: the second deleted the files of
// the first between write and use. A fresh folder also means a removed script cannot leave an
// old file behind.
const outDir = join(buildRoot, `run-${Date.now()}-${process.pid}`);

// Cleaning up is best effort and never fails a run. On Windows a folder that is still in use
// cannot be removed, and then it simply stays for a later run to remove.
const remove = (path, olderThanMs = 0) => {
  try {
    if (olderThanMs && Date.now() - statSync(path).mtimeMs < olderThanMs) return;
    rmSync(path, { recursive: true, force: true });
  } catch { /* still in use, or already gone */ }
};
// Leftovers of runs that were killed. Only old ones: a young folder may belong to a run that
// is still going.
let leftovers = [];
try { leftovers = readdirSync(buildRoot); } catch { /* no build folder yet */ }
for (const name of leftovers) remove(join(buildRoot, name), 10 * 60 * 1000);
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
remove(outDir);
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
  // undefined, so calling it throws as it would in a browser. addEventListener keeps the
  // handler under its event name in `handlers`, so a check can send a pointer event to a chart.
  const NOOP_METHODS = new Set(["removeEventListener", "setAttribute", "getAttribute", "removeAttribute", "scrollIntoView"]);

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
    // Elements whose tag in the markup has the hidden attribute start hidden, as in a browser. So
    // a check that reads hidden false shows that the page itself made the element visible.
    const startHidden = new Set([...text.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/g)]
      .filter((m) => /\shidden[\s>]/.test(m[0])).map((m) => m[1]));
    // The same for an inline style: element.style starts with what the markup sets, under the
    // camelCase names a browser uses. So a check that reads style.visibility "" shows that the
    // page itself made visible what the markup made invisible.
    const startStyle = new Map();
    for (const m of text.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/g)) {
      const s = /\sstyle="([^"]*)"/.exec(m[0]);
      if (!s) continue;
      const style = {};
      for (const decl of s[1].split(";")) {
        const at = decl.indexOf(":");
        if (at > 0) style[decl.slice(0, at).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = decl.slice(at + 1).trim();
      }
      startStyle.set(m[1], style);
    }
    const els = new Map();
    // A browser's dataset holds strings: li.dataset.id = 11 reads back as "11".
    const stringMap = () => new Proxy({}, { set: (o, k, v) => { o[k] = String(v); return true; } });
    function makeEl() {
      const store = { id: "", textContent: "", html: "", hidden: false, style: {}, dataset: stringMap(), children: [], value: "", found: {}, classes: new Set(), next: [] };
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
          if (p === "addEventListener") return (ev, fn) => { (t.handlers ??= {})[ev] = fn; };
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
      if (!els.has(id)) { const e = makeEl(); e.id = id; e.hidden = startHidden.has(id); Object.assign(e.style, startStyle.get(id)); els.set(id, e); }
      return els.get(id);
    };
    // The few groups the page looks up by selector, taken from the markup, so their click
    // handlers can be run. Any other selector finds nothing.
    const buttons = (attr) => [...text.matchAll(new RegExp(`<button data-${attr}="([^"]+)"`, "g"))]
      .map((m) => { const b = makeEl(); b.dataset[attr] = m[1]; return b; });
    const groups = {
      "[data-view]": buttons("view"),
      "#h-presets button[data-p]": buttons("p"),
      "#h-metrics button": buttons("m"),
      ".view": [...text.matchAll(/<section class="view" id="([^"]+)"/g)].map((m) => $(m[1])),
    };

    // reject(path) and hold(path) decide per request. reject may answer "late": the request
    // then fails after the others of the same moment were answered. A held request never
    // answers, so only the page's own time limit can end it. answer(path, res) gives the page a
    // Response of its own in place of the Worker's res, as Cloudflare in front of the Worker would,
    // or another version of the Worker while a deploy rolls out. edit(path, answer) may change a
    // JSON answer in place before the page reads it, as a newer Worker would answer.
    const net = { log: [], busy: 0, reject, hold, answer: null, edit: null };
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
        let res = await call(env, path);
        if (net.answer) res = await net.answer(path, res);
        if (!net.edit || !res.ok) return res;
        const answer = await res.json();
        net.edit(path, answer);
        return new Response(JSON.stringify(answer), { status: res.status, headers: res.headers });
      } finally { net.busy--; }
    };

    // calls: the name of every Leaflet method the page called, in order, and "wheel on" or
    // "wheel off" when it turned the wheel zoom of a map on or off. fills: the fill color of every
    // setStyle call, which is how a marker gets its color. made: the options of every map the
    // page made. dots: the options of every circle marker. mapOn: the arguments of every on()
    // call, an event name and its handler, so a check can run the handlers.
    const timers = [], errors = [], listeners = {}, tooltips = [], calls = [], pushed = [], fills = [], made = [], dots = [], mapOn = [];
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

    // Every Leaflet call answers with Leaflet itself, so any chain of calls works. The wheel zoom
    // of a map is an object with enable and disable, as in Leaflet.
    const wheel = { enable: () => { calls.push("wheel on"); }, disable: () => { calls.push("wheel off"); } };
    const leaflet = new Proxy(function () {}, {
      get: (_, k) => (typeof k === "symbol" ? undefined : k === "scrollWheelZoom" ? wheel : (...args) => {
        calls.push(k);
        if (k === "on") mapOn.push(args);
        if (k === "bindTooltip") tooltips.push(args[0]);
        if (k === "setStyle") fills.push(args[0] && args[0].fillColor);
        if (k === "map") made.push(args[1] || {});
        if (k === "circleMarker") dots.push(args[1] || {});
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
      $, net, errors, tooltips, calls, pushed, fills, made, dots, mapOn, listeners, doc, groups, location: loc,
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
  // What a date field shows for a moment: local wall time to the minute.
  const wall = (ts) => {
    const d = new Date(ts * 1000), two = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
  };

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

  check("history: the odometer distance adds the gap before a trip across the end and what it logged inside the window", async () => {
    const env = makeEnv();
    // A short trip, then an hour later a 10-minute one with the odometer 15 km ahead.
    const first = drive({ boot: 12, n: 60 });
    const second = drive({ boot: 13, n: 600, base: T0 + 3600, odo0: Math.round(first.at(-1).odo_km * 10) + 150 });
    await upload(env, first, T0 + 100);
    await upload(env, second, T0 + 4300);
    setNow(T0 + 4300);
    // The window ends on a minute boundary five minutes into the second trip, so the minute rows
    // split there: its readings up to `to` are inside.
    const to = T0 + 3899;
    const h = await api(env, `api/history?from=${T0 - 600}&to=${to}`);
    const km = (rs) => rs.slice(1).reduce((a, r) => a + r.speed_kph / 3600, 0);
    const inside = km(second.filter((r) => r.epoch <= to));
    const r1 = (x) => Math.round(x * 10) / 10;
    // From the first reading of the first trip to the first of the second, gap included, plus
    // the miles the second logged before the end of the window.
    assert.equal(h.totals.odometer_mi, r1((second[0].odo_km - first[0].odo_km + inside) * 0.621371));
    // So it is about the 9.3 mi of the gap ahead of the logged miles.
    assert.ok(h.totals.odometer_mi - h.totals.miles > 9, `${h.totals.odometer_mi} mi by odometer, ${h.totals.miles} logged`);
    // A window that ends before the second trip holds the first one whole: its odometer alone.
    const before = await api(env, `api/history?from=${T0 - 600}&to=${T0 + 3000}`);
    assert.equal(before.totals.odometer_mi, r1((first.at(-1).odo_km - first[0].odo_km) * 0.621371));
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
    // The trip view gives it a note line, not a tile.
    const p = openPage(env, { hash: "trips" });
    await p.settle();
    assert.match(p.$("t-note").innerHTML, /<div>Battery at power-up 12\.3 V, engine off\.<\/div>/);
    assert.equal((p.$("t-stats").innerHTML.match(/class="stat"/g) ?? []).length, 12);
    assert.deepEqual(p.errors, []);
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

  check("header: the Overview subtitle carries the odometer, a phone hides the others, and the footer stays empty", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const odo = Math.round((await api(env, "api/status")).latest.odo_km.v * 0.621371).toLocaleString();
    const p = openPage(env, { width: 375, touch: true });
    await p.settle();
    assert.equal(p.$("subtitle").textContent, `2024 Stingray · ${odo} mi`);
    assert.ok(!p.$("subtitle").classList.contains("opt"), "the Overview subtitle is hidden");
    // Nothing went wrong and nothing is paused, so the footer has nothing to say.
    assert.equal(p.$("foot").textContent, "");
    p.nav("trips");
    await p.settle();
    assert.equal(p.$("subtitle").textContent, "Each trip with its route and charts");
    assert.ok(p.$("subtitle").classList.contains("opt"), "the Trips subtitle is not marked as optional");
    assert.equal(p.$("t-list-sub").textContent, "A trip is one power-up of the logger in which the engine ran.");
    assert.equal(p.$("foot").textContent, "");
    // A header re-check on another view keeps that view's subtitle.
    p.interval();
    assert.equal(p.$("subtitle").textContent, "Each trip with its route and charts");
    p.nav("overview");
    await p.settle();
    assert.equal(p.$("subtitle").textContent, `2024 Stingray · ${odo} mi`);
    assert.deepEqual(p.errors, []);
  });

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

  check("overview: the Last drive card is the newest drive that moved, and a trip row leads with its distance", async () => {
    const env = makeEnv();
    await parkedCar(env);
    // An hour later the engine idles for two minutes and the car does not move. The odometer
    // ticks once, by 0.1 km, as it can when it stands at a step: under 0.2 mi is no drive. Then
    // the engine stops, before the logger does.
    const idle = drive({ boot: 12, n: 120, gps: false, base: T0 + 3600 }), odo_km = idle[0].odo_km;
    const off = drive({ boot: 12, n: 10, ms0: 142000, stepMs: 2000, flags: F.QUIET, gps: false, base: T0 + 3600 });
    await upload(env, [
      ...idle.map((r, i) => ({ ...r, speed_kph: 0, odo_km: odo_km + (i < 60 ? 0 : 0.1) })),
      ...off.map((r) => ({ ...r, rpm: null, speed_kph: null, odo_km: odo_km + 0.1 })),
    ], T0 + 3780);
    setNow(T0 + 4000);
    assert.equal((await api(env, "api/trips?limit=40")).trips[0].odo_miles, 0.1);
    const p = openPage(env);
    await p.settle();
    assert.match(p.$("o-drive-chip").textContent, /^top \d+ mph$/);
    assert.match(p.$("o-drive-sub").textContent, / · [\d.]+ mi · 5 min engine$/);
    // The idle session is the newest row. It has no distance and no top speed.
    const rows = p.$("o-trips").children;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].querySelector(".m").textContent, "Idle only · 2 min engine");
    assert.equal(rows[0].querySelector(".r").innerHTML, "");
    assert.match(rows[1].querySelector(".r").innerHTML, /^[\d.]+<small>mi<\/small>$/);
    assert.match(rows[1].querySelector(".m").textContent, /^5 min engine · top \d+ mph · [\d.]+ mpg$/);
    // Only the Trips list marks the selected trip. No session was cut off, so no row says so.
    assert.ok(rows.every((li) => !li.classList.contains("sel")), "a Recent trips row is marked");
    assert.ok(rows.every((li) => !li.innerHTML.includes("end not received")), "a row says its end did not arrive");

    // The button keeps its room while it is invisible, and shows once there is a drive to open.
    assert.equal(p.$("o-drive-open").style.visibility, "");
    p.$("o-drive-open").onclick();
    await p.settle();
    assert.deepEqual(p.shown(), ["v-trips"]);
    assert.match(p.$("t-sub").textContent, /^Trip 11 · /);
    assert.match(p.$("t-list").children[0].querySelector(".m").textContent, /idle only/i);
    const marked = () => p.$("t-list").children.filter((li) => li.classList.contains("sel")).map((li) => li.dataset.id);
    assert.deepEqual(marked(), ["11"]);
    // The first 10 s re-check draws the lists again. The selection stays marked.
    p.interval();
    assert.deepEqual(marked(), ["11"]);

    // A drive whose speed readings all failed: its distance comes from the GPS route.
    const gps = makeEnv();
    await upload(gps, drive({ n: 120 }).map((r) => ({ ...r, speed_kph: null })), T0 + 200);
    setNow(T0 + 4000);
    const q = openPage(gps);
    await q.settle();
    assert.match(q.$("o-drive-sub").textContent, / · about [\d.]+ mi by GPS · 2 min engine$/);
    assert.equal(q.$("o-drive-chip").textContent, "no speed readings");
    assert.match(q.$("o-trips").children[0].querySelector(".r").innerHTML, /^[\d.]+<small>mi by GPS<\/small>$/);
    // No trip and no position yet: neither button shows.
    const e = openPage(makeEnv());
    await e.settle();
    assert.deepEqual([e.$("o-drive-open").style.visibility, e.$("o-maps").hidden], ["hidden", true]);
    assert.deepEqual([...p.errors, ...q.errors, ...e.errors], []);
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
    // With a position the Google Maps button shows. The markup starts it hidden.
    assert.equal(p.$("o-maps").hidden, false);
    assert.deepEqual(p.errors, []);
  });

  check("overview: a power-up without the engine is no stop, so a parked car stands since the last RPM reading of the drive before", async () => {
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    const wday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    // A drive whose last RPM reading is at T0 + 319, then quiet readings until T0 + 398, so the
    // stop and the end of the session fall in different minutes.
    const stop = new Date((T0 + 319) * 1000), driven = `Parked since ${wday.format(stop)} ${time.format(stop)}`;
    // Two days later the logger powers up in the driveway, gets a fix, and the engine is never
    // started. `flags` marks that power-up's readings: the adapter link up, or down.
    const base = T0 + 2 * 86400, woke = `Parked since ${time.format(new Date((base + 38) * 1000))}`;
    const woken = async (flags) => {
      const env = makeEnv();
      await upload(env, drive({ boot: 11, inst: 0, fw: 0, n: 300 }), T0 + 320);
      await upload(env, drive({ boot: 11, inst: 0, fw: 0, n: 40, ms0: 320000, stepMs: 2000, flags: F.QUIET }).map((r) => ({ ...r, rpm: null, speed_kph: null })), T0 + 400);
      await upload(env, drive({ boot: 12, n: 10, base, stepMs: 2000, flags }).map((r) => ({ ...r, rpm: null, speed_kph: null })), base + 60);
      setNow(base + 3600);
      return env;
    };
    const env = await woken(F.QUIET);
    const p = openPage(env);
    await p.settle();
    assert.match(p.header(), /^Parked · updated /);
    assert.equal(p.$("o-loc-sub").textContent, driven);
    // The trip list fails at page open, after the status was answered, and comes with the next
    // poll. Until then the line gives the end of the power-up. The list brings the stop.
    let first = true;
    const q = openPage(env, { reject: (path) => { if (!first || !path.startsWith("api/trips")) return false; first = false; return "late"; } });
    await q.settle();
    assert.equal(q.$("o-loc-sub").textContent, woke);
    await q.poll();
    assert.equal(q.$("o-loc-sub").textContent, driven);
    // With the adapter link down the engine may have run unseen, so the line keeps the last report.
    const r = openPage(await woken(F.NO_LINK));
    await r.settle();
    assert.match(r.header(), /^Parked · updated /);
    assert.equal(r.$("o-loc-sub").textContent, woke);
    assert.deepEqual([...p.errors, ...q.errors, ...r.errors], []);
  });

  check("location: a cut-off drive is last known, and a fix behind the newest reading is a grey last fix", async () => {
    // A drive whose end never arrived.
    const cut = makeEnv();
    await upload(cut, drive({ n: 60 }), T0 + 80);
    setNow(T0 + 740);
    const a = openPage(cut);
    await a.settle();
    assert.match(a.header(), /^Parked · offline mid-drive, 11 min ago$/);
    // Its row says so too.
    assert.match(a.$("o-trips").children[0].innerHTML, /<div class="gap"><span class="tag mid">end not received<\/span><\/div>$/);
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
    // Since the last RPM reading, not since the quiet readings after it.
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    assert.equal(c.$("o-loc-sub").textContent, `Parked since ${time.format(new Date((T0 + 259) * 1000))}`);
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

  check("a session cut off while the engine idled is not called a drive, and its trip says that its end did not arrive", async () => {
    const env = makeEnv();
    await parkedCar(env);
    // An hour after the drive the engine idles for two and a half minutes, then the logger goes
    // offline with the engine on. The car stands, so the odometer stays put.
    const idle = drive({ boot: 12, n: 150, gps: false, base: T0 + 3600 });
    await upload(env, idle.map((r) => ({ ...r, speed_kph: 0, odo_km: idle[0].odo_km })), T0 + 3780);
    setNow(T0 + 4500);
    const p = openPage(env);
    await p.settle();
    assert.equal(p.header(), "Parked · offline while idling, 12 min ago");
    // The idle session is the newest row and carries the tag. The drive before it does not, and
    // it is still the Last drive.
    const rows = p.$("o-trips").children;
    assert.deepEqual(rows.map((li) => li.dataset.id), [String(sid(12, INST)), "11"]);
    assert.match(rows[0].querySelector(".m").textContent, /^Idle only · \d+ min engine$/);
    assert.match(rows[0].innerHTML, /<div class="gap"><span class="tag mid">end not received<\/span><\/div>$/);
    assert.doesNotMatch(rows[1].innerHTML, /end not received/);
    assert.match(p.$("o-drive-chip").textContent, /^top \d+ mph$/);
    assert.match(p.$("o-drive-sub").textContent, / · [\d.]+ mi · 5 min engine$/);
    p.nav("live");
    await p.settle();
    assert.match(p.$("l-banner-t").innerHTML,
      /^<b [^>]*>Parked\.<\/b> The logger went offline while the engine idled, so the end of that session is missing\. Showing the last readings from 12 min ago\.$/);
    // Trips opens the drive. The line of the idle session says that its end did not arrive.
    p.nav("trips");
    await p.settle();
    assert.match(p.$("t-sub").textContent, /^Trip 11 · /);
    assert.doesNotMatch(p.$("t-sub").textContent, /end not received/);
    p.$("t-list").children[0].onclick();
    await p.settle();
    assert.match(p.$("t-sub").textContent, new RegExp(`^Trip ${INST}-12 · .+ · end not received · firmware build 2$`));

    // The trip list fails at page open, after the status was answered, and comes with the next
    // poll. Until then the header cannot tell whether the session moved.
    let first = true;
    const q = openPage(env, { reject: (path) => { if (!first || !path.startsWith("api/trips")) return false; first = false; return "late"; } });
    await q.settle();
    assert.match(q.header(), /^No connection to the server/);
    await q.poll();
    assert.equal(q.header(), "Parked · offline while idling, 12 min ago");
    assert.deepEqual([...p.errors, ...q.errors], []);
  });

  check("overview: a parked car says since when, as a time today, a weekday this week, else a date", async () => {
    const env = makeEnv();
    await parkedCar(env);
    // The last RPM reading of the drive. The quiet readings after it have none.
    const stop = new Date((T0 + 319) * 1000);
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    const wday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    const seen = [];
    for (const later of [3600, 2 * 86400, 8 * 86400]) {
      setNow(T0 + 340 + later);
      const p = openPage(env);
      await p.settle();
      assert.match(p.header(), /^Parked · updated /);
      seen.push(p.$("o-loc-sub").textContent);
      assert.deepEqual(p.errors, []);
    }
    assert.deepEqual(seen, [`Parked since ${time.format(stop)}`, `Parked since ${wday.format(stop)} ${time.format(stop)}`, `Parked since ${date.format(stop)}`]);
    // The Location card comes first on a phone, after the cards at the top.
    const narrow = html.slice(html.indexOf("@media (max-width: 1020px) {"));
    assert.match(narrow.slice(0, narrow.indexOf("\n  }")), /#o-loc-card \{ order: -1; \}/);
  });

  check("overview: the map moves to the car after a drive the page did not see, and stays put without one", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env);
    await p.settle();
    // The first view of a new map, then the parked car.
    assert.equal(p.calls.filter((k) => k === "setView").length, 2, "the map is centered on the parked car");
    // A drive ends while the page waits for its next poll. Its end never arrives, so the
    // position is not live when the page sees it. Within 15 minutes of the page open, or it pauses.
    let before = p.calls.length;
    await upload(env, drive({ boot: 12, n: 200, base: T0 + 4005 }), T0 + 4225);
    setNow(T0 + 4830);
    await p.poll();
    assert.match(p.$("o-loc-sub").textContent, /^Last known · /);
    assert.ok(p.calls.slice(before).includes("panTo"), "the map follows the car to where the drive ended");
    // Nothing new: the view stays where it is.
    before = p.calls.length;
    setNow(T0 + 4850);
    await p.poll();
    assert.deepEqual(p.calls.slice(before).filter((k) => k === "panTo" || k === "setView"), []);
    assert.deepEqual(p.errors, []);
  });

  check("maps: no map without a position, and a trip with one position gets a dot that leaves with it", async () => {
    const none = makeEnv();
    await upload(none, drive({ n: 60, gps: false }), T0 + 100);
    setNow(T0 + 4000);
    const p = openPage(none, { hash: "trips" });
    await p.settle();
    assert.equal(p.$("t-detail").hidden, false);
    assert.equal(p.$("t-mapbox").hidden, true);
    assert.equal(p.$("t-route-sub").textContent, "No GPS positions were recorded on this trip");
    // Overview and History make no map either, and Overview has no Google Maps button.
    const o = openPage(none);
    await o.settle();
    assert.equal(o.$("o-loc-sub").textContent, "No GPS fix yet");
    assert.equal(o.$("o-map").innerHTML, '<div class="empty">No GPS position yet.</div>');
    assert.equal(o.$("o-maps").hidden, true);
    const h = openPage(none, { hash: `history/${T0 - 600}-${T0 + 4000}` });
    await h.settle();
    assert.equal(h.$("h-mapbox").hidden, true);
    assert.equal(h.$("h-map-sub").textContent, "No GPS positions in this period");
    assert.ok(![...p.calls, ...o.calls, ...h.calls].includes("map"), "a map was made with nothing to draw");

    // One reading in the middle of the drive had a fix.
    const one = makeEnv();
    const fix = drive({ n: 60 })[30];
    await upload(one, drive({ n: 60, gps: false }).map((r, i) => (i === 30 ? { ...r, lat: fix.lat, lon: fix.lon, sats: 9 } : r)), T0 + 100);
    setNow(T0 + 4000);
    const q = openPage(one, { hash: "trips" });
    await q.settle();
    assert.equal(q.$("t-mapbox").hidden, false);
    assert.equal(q.$("t-route-sub").textContent, "Only one GPS position was recorded on this trip");
    assert.deepEqual(q.tooltips, ["Only GPS position"]);
    // Back on the Trips view the same trip is not drawn again, so a zoomed map stays as it was.
    const layers = () => q.calls.filter((k) => k === "removeLayer").length;
    const removed = layers();
    q.listeners.hashchange();
    await q.settle();
    assert.equal(layers(), removed);
    // A tap on its row fits it again. The dot is in the track layer, which goes when the trip is drawn again.
    q.$("t-list").children[0].onclick();
    await q.settle();
    assert.equal(layers(), removed + 1);
    assert.deepEqual([...p.errors, ...o.errors, ...h.errors, ...q.errors], []);
  });

  check("maps: a legend gives the speed colors, start and end are neutral dots, and a trip in progress ends at the time of its newest position", async () => {
    // The words of a legend in order, and the colors of its swatches.
    const words = (q, id) => [...q.$(id).innerHTML.matchAll(/<span>(?:<i [^>]*><\/i>)?([^<]+)<\/span>/g)].map((m) => m[1]);
    const swatches = (q, id) => [...q.$(id).innerHTML.matchAll(/background:(#[0-9a-f]+)/g)].map((m) => m[1]);
    const bands = ["mph", "under 25", "25 to 44", "45 to 64", "65 to 79", "80 and up"];
    const colors = ["#2fbf71", "#22b8cf", "#3d6ef5", "#e8b423", "#ef4444"];
    const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    const env = makeEnv();
    await threeTrips(env, 126800);
    const p = openPage(env, { hash: "trips" });
    await p.settle();
    // The legend explains the colors, so the subtitle names the trip.
    const start = new Date((await api(env, "api/trips?limit=40")).trips[0].start_ts * 1000);
    assert.equal(p.$("t-route-sub").textContent, `${day.format(start)}, ${time.format(start)}`);
    assert.deepEqual(words(p, "t-legend"), [...bands, "Start", "End"]);
    assert.deepEqual(swatches(p, "t-legend"), colors);
    // Neutral markers: a dark dot with a white ring, then a white dot.
    assert.deepEqual(p.tooltips, ["Start", "End"]);
    assert.deepEqual(p.dots.map((o) => [o.color, o.fillColor]), [["#fff", "#0d0e11"], ["#0d0e11", "#fff"]]);
    // History: the same key without start and end, and no markers on its routes.
    const h = openPage(env, { hash: `history/${T0 - 600}-${T0 + 8000}` });
    await h.settle();
    assert.equal(h.$("h-map-sub").textContent, "3 drives with GPS");
    assert.deepEqual(words(h, "h-legend"), bands);
    assert.deepEqual([h.tooltips, h.dots], [[], []]);

    // A drive in progress whose speed readings stop for ten seconds: its route has grey in it, and
    // its newest point is no end yet. It is the position at the time of the newest reading with a
    // fix, and the subtitle says the route goes up to then.
    const at = (ts) => time.format(new Date(ts * 1000));
    const going = makeEnv();
    await upload(going, drive({ n: 120 }).map((r, i) => (i >= 40 && i < 50 ? { ...r, speed_kph: null } : r)), T0 + 140);
    setNow(T0 + 145);
    const q = openPage(going, { hash: "trips" });
    await q.settle();
    assert.match(q.$("t-sub").textContent, / · in progress/);
    assert.doesNotMatch(q.$("t-sub").textContent, /end not received/);
    assert.deepEqual(words(q, "t-legend"), [...bands, "no speed reading", "Start", `Position at ${at(T0 + 139)}`]);
    assert.deepEqual(swatches(q, "t-legend"), [...colors, "#8b8f9a"]);
    assert.deepEqual(q.tooltips, ["Start", `Position at ${at(T0 + 139)}`]);
    assert.equal(q.$("t-route-sub").textContent, `${day.format(new Date((T0 + 20) * 1000))}, ${at(T0 + 20)} · up to ${at(T0 + 139)}`);
    // The fix is lost a minute before the newest reading. The time is the one of the last fix.
    const lost = makeEnv();
    await upload(lost, [...drive({ n: 60 }), ...drive({ n: 60, ms0: 80000, gps: false })], T0 + 140);
    setNow(T0 + 145);
    const answer = await api(lost, `api/trip/${sid(12, INST)}`);
    assert.deepEqual([answer.track_end_ts, answer.trip.end_ts], [T0 + 79, T0 + 139]);
    const r = openPage(lost, { hash: "trips" });
    await r.settle();
    assert.deepEqual(r.tooltips, ["Start", `Position at ${at(T0 + 79)}`]);
    assert.ok(r.$("t-route-sub").textContent.endsWith(` · up to ${at(T0 + 79)}`), r.$("t-route-sub").textContent);

    // A period whose only GPS position is one point: a white dot and no key.
    const one = makeEnv();
    const fix = drive({ n: 60 })[30];
    await upload(one, drive({ n: 60, gps: false }).map((r, i) => (i === 30 ? { ...r, lat: fix.lat, lon: fix.lon, sats: 9 } : r)), T0 + 100);
    setNow(T0 + 4000);
    const o = openPage(one, { hash: `history/${T0 - 600}-${T0 + 4000}` });
    await o.settle();
    assert.equal(o.$("h-mapbox").hidden, false);
    assert.equal(o.$("h-legend").innerHTML, "");
    assert.deepEqual(o.dots.map((d) => [d.color, d.fillColor]), [["#0d0e11", "#fff"]]);
    assert.deepEqual([...p.errors, ...h.errors, ...q.errors, ...r.errors, ...o.errors], []);
  });

  check("trips: twelve tiles, the unlogged gap on a line of its own, and one note per line that applies", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    const p = openPage(env, { hash: "trips" });
    await p.settle();
    assert.match(p.$("t-sub").textContent, new RegExp(`^Trip ${INST}-14 · `));
    assert.match(p.$("t-gap").innerHTML,
      /^<div class="notice"><i class="dot warn"><\/i><span>The odometer moved [\d.]+ mi before this trip without being logged\.<\/span><\/div>$/);
    // The trip's row in the list shows the gap as a tag, and leads with the distance. Its end never
    // arrived (the logger went offline with the engine on), which is a second tag on the same line.
    assert.match(p.$("t-list").children[0].innerHTML,
      /<div class="gap"><span class="tag mid">[\d.]+ mi unlogged before<\/span> <span class="tag mid">end not received<\/span><\/div>$/);
    assert.match(p.$("o-trips").children[0].querySelector(".r").innerHTML, /^[\d.]+<small>mi<\/small>$/);
    const stats = p.$("t-stats").innerHTML;
    assert.equal((stats.match(/class="stat"/g) ?? []).length, 12);
    assert.match(stats, /Idle<\/div><div class="v">\d+ s \(\d+ %\)</);
    assert.equal(p.$("t-note").innerHTML, "<div>Fuel used and MPG are estimated from engine airflow. They read low at full throttle and high while coasting.</div>" +
      "<div>Distance is added up from speed, about 1% under the odometer.</div>");
    // No trip came before the first one, so there is no gap line.
    p.$("t-list").children[2].onclick();
    await p.settle();
    assert.match(p.$("t-sub").textContent, new RegExp(`^Trip ${INST}-12 · `));
    assert.equal(p.$("t-gap").innerHTML, "");

    // The trip before has no odometer, so the gap is not known. A note says so.
    const unknown = makeEnv();
    await threeTrips(unknown, null);
    const q = openPage(unknown, { hash: "trips" });
    await q.settle();
    assert.equal(q.$("t-gap").innerHTML, "");
    assert.match(q.$("t-note").innerHTML, /^<div>Not known if miles went unlogged before this trip\. An odometer reading is missing\.<\/div>/);

    // A drive whose speed readings failed has no known moving time, so no idle time and no
    // average. Its speed chart says that no readings came, not that they are still to come.
    const gps = makeEnv();
    await upload(gps, drive({ n: 120 }).map((r) => ({ ...r, speed_kph: null })), T0 + 200);
    setNow(T0 + 4000);
    const g = openPage(gps, { hash: "trips" });
    await g.settle();
    const gs = g.$("t-stats").innerHTML;
    assert.match(gs, /Distance<\/div><div class="v">[\d.]+ mi by GPS</);
    assert.match(gs, /Moving<\/div><div class="v">–</);
    assert.match(gs, /Avg moving speed<\/div><div class="v">–</);
    assert.match(gs, /Idle<\/div><div class="v">–</);
    assert.equal(g.$("t-speed").innerHTML, '<div class="empty">No speed readings on this trip</div>');
    assert.match(g.$("t-rpm").innerHTML, /^<svg /);
    assert.equal(g.$("t-note").innerHTML, "<div>No speed readings on this trip. The distance is measured along the GPS route and reads a little short on curves. " +
      "There is no MPG figure.</div><div>Fuel used and MPG are estimated from engine airflow. They read low at full throttle and high while coasting.</div>");
    assert.deepEqual([...p.errors, ...q.errors, ...g.errors], []);
  });

  check("trips: a drive that moved only by the odometer gives that distance, and a session in progress is never called idle", async () => {
    const f1 = (x) => (Math.round(x * 10) / 10).toLocaleString();
    const env = makeEnv();
    // The speed readings fail for the whole drive and there is no GPS fix, but the odometer goes
    // up. Then the engine stops, before the logger does.
    const fields = drive({ n: 180, gps: false }).map((r) => ({ ...r, speed_kph: null }));
    const last = fields[fields.length - 1];
    const off = drive({ n: 10, ms0: last.ms + 2000, stepMs: 2000, flags: F.QUIET, gps: false }).map((r) => ({ ...r, rpm: null, speed_kph: null, odo_km: last.odo_km }));
    await upload(env, [...fields, ...off], T0 + 300);
    setNow(T0 + 4000);
    const t = (await api(env, "api/trips?limit=40")).trips[0];
    assert.ok(t.miles < 0.1 && t.gps_miles == null && t.odo_miles > 1, JSON.stringify(t));
    const p = openPage(env);
    await p.settle();
    const row = p.$("o-trips").children[0];
    assert.equal(row.querySelector(".r").innerHTML, `${f1(t.odo_miles)}<small>mi by odometer</small>`);
    assert.equal(row.querySelector(".m").textContent, "3 min engine");
    assert.match(row.innerHTML, /<svg style="color:var\(--blue\)">/);
    // It is the Last drive, not skipped as an idle session.
    assert.ok(p.$("o-drive-sub").textContent.endsWith(` · ${f1(t.odo_miles)} mi by odometer · 3 min engine`), p.$("o-drive-sub").textContent);
    assert.equal(p.$("o-drive-chip").textContent, "no speed readings");
    p.nav("trips");
    await p.settle();
    const stats = p.$("t-stats").innerHTML;
    assert.ok(stats.includes(`Distance</div><div class="v">${f1(t.odo_miles)} mi by odometer<`), stats);
    assert.ok(stats.includes(`By odometer</div><div class="v">${f1(t.odo_miles)} mi<`), stats);
    assert.match(stats, /Moving<\/div><div class="v">–</);
    assert.match(stats, /Idle<\/div><div class="v">–</);
    assert.equal(p.$("t-speed").innerHTML, '<div class="empty">No speed readings on this trip</div>');
    assert.equal(p.$("t-note").innerHTML, "<div>No speed readings and no GPS route on this trip. The distance is from the odometer. There is no MPG figure.</div>" +
      "<div>Fuel used and MPG are estimated from engine airflow. They read low at full throttle and high while coasting.</div>");

    // Two minutes into a session the car has not moved yet. It may still drive off, so its row
    // gives the engine time and is not called idle.
    const going = makeEnv();
    const still = drive({ n: 120, gps: false });
    await upload(going, still.map((r) => ({ ...r, speed_kph: 0, odo_km: still[0].odo_km })), T0 + 140);
    setNow(T0 + 145);
    const q = openPage(going);
    await q.settle();
    const now = q.$("o-trips").children[0];
    assert.match(now.querySelector(".w").textContent, / · in progress$/);
    assert.equal(now.querySelector(".m").textContent, "2 min engine");
    assert.deepEqual([...p.errors, ...q.errors], []);
  });

  check("trips: a chart without readings says so, and only a trip in progress says yet", async () => {
    // Two minutes into a drive whose speed readings fail from the start.
    const env = makeEnv();
    await upload(env, drive({ n: 120 }).map((r) => ({ ...r, speed_kph: null })), T0 + 140);
    setNow(T0 + 145);
    const p = openPage(env, { hash: "trips" });
    await p.settle();
    assert.match(p.$("t-sub").textContent, / · in progress/);
    assert.equal(p.$("t-speed").innerHTML, '<div class="empty">No speed readings yet</div>');
    // A drive that ended without RPM, coolant or throttle readings.
    const bare = makeEnv();
    await upload(bare, drive({ n: 120 }).map((r) => ({ ...r, rpm: null, coolant_c: null, throttle_pct: null })), T0 + 200);
    setNow(T0 + 4000);
    const q = openPage(bare, { hash: "trips" });
    await q.settle();
    assert.match(q.$("t-speed").innerHTML, /^<svg /);
    assert.deepEqual(["t-rpm", "t-cool", "t-thr"].map((id) => q.$(id).innerHTML),
      ["RPM", "coolant", "throttle"].map((w) => `<div class="empty">No ${w} readings on this trip</div>`));
    assert.deepEqual([...p.errors, ...q.errors], []);
  });

  check("history: the odometer distance beside the logged one, six Details tiles from a floor for unlogged miles, and where the data starts", async () => {
    const f1 = (x) => (Math.round(x * 10) / 10).toLocaleString();
    const env = makeEnv();
    // As in the API check: the gap before the second trip is known, the two around the third are not.
    const trips = [
      drive({ boot: 12, n: 60 }),
      drive({ boot: 13, n: 60, base: T0 + 3600, odo0: 127000 }),
      drive({ boot: 14, n: 60, base: T0 + 7200, odo0: null }),
      drive({ boot: 15, n: 60, base: T0 + 10800, odo0: 127600 }),
    ];
    for (const [i, fields] of trips.entries()) await upload(env, fields, T0 + 100 + i * 3600);
    setNow(T0 + 11500);
    const h = await api(env, `api/history?from=${T0 - 600}&to=${T0 + 11500}`);
    const p = openPage(env, { hash: `history/${T0 - 600}-${T0 + 11500}` });
    await p.settle();
    const kpis = p.$("h-kpis").innerHTML;
    // The odometer moved far more than was logged. One yellow figure says so, on the Distance card.
    assert.ok(kpis.includes(`Distance</div><div class="val">${f1(h.totals.miles)}<small>mi</small></div>` +
      `<div class="delta">4 trips · <span class="warn">${f1(h.totals.odometer_mi)} mi by odometer</span></div>`), kpis);
    assert.equal((kpis.match(/class="warn"/g) ?? []).length, 1);
    // The coolant average is over readings with the engine on.
    assert.match(kpis, /Coolant<\/div><div class="val">\d+<small>°F avg<\/small><\/div><div class="delta">engine on · max \d+ °F<\/div>/);
    // Six tiles, none of them a figure from the cards. The gap is first, a floor in plain text.
    const tiles = (q) => [...q.$("h-extremes").innerHTML.matchAll(/<div class="k">([^<]*)<\/div><div class="v">([^<]*)<\/div>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(tiles(p).map((t) => t[0]), ["Driven but not logged", "Battery range", "Max throttle", "Intake air range", "Readings", "GPS points"]);
    assert.equal(tiles(p)[0][1], `at least ${f1(h.totals.unlogged_mi_at_least)} mi`);
    assert.doesNotMatch(p.$("h-extremes").innerHTML, /warn/);
    // The window starts before the logger's first session, which is not the same as not driven.
    const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    assert.ok(p.$("h-label").textContent.endsWith(` · logger data starts ${day.format(new Date((T0 + 20) * 1000))}`), p.$("h-label").textContent);
    // A window inside the data needs no such note.
    p.location.hash = `history/${T0 + 3000}-${T0 + 11500}`;
    await p.settle();
    assert.doesNotMatch(p.$("h-label").textContent, / · /);

    // A trip without odometer readings in the middle: no gap is known, so the tile is a dash.
    const unknown = makeEnv();
    await threeTrips(unknown, null);
    const q = openPage(unknown, { hash: `history/${T0 - 600}-${T0 + 8000}` });
    await q.settle();
    assert.match(q.$("h-kpis").innerHTML, /<div class="delta">3 trips · <span class="warn">[\d.]+ mi by odometer<\/span><\/div>/);
    assert.deepEqual(tiles(q)[0], ["Driven but not logged", "–"]);
    // No data at all yet.
    const r = openPage(makeEnv(), { hash: "history/24h" });
    await r.settle();
    assert.ok(r.$("h-label").textContent.endsWith(" · no logger data yet"), r.$("h-label").textContent);
    assert.deepEqual([...p.errors, ...q.errors, ...r.errors], []);
  });

  check("history: fuel and MPG are called estimates, an MPG on few miles is rough, and the tank line is a range", async () => {
    const f1 = (x) => (Math.round(x * 10) / 10).toLocaleString();
    const env = makeEnv();
    await parkedCar(env);
    const h = await api(env, `api/history?from=${T0 + 4000 - 86400}&to=${T0 + 4000}`);
    assert.equal(h.mpg_min_miles, 25);
    assert.ok(h.totals.mpg_few_miles && h.totals.gallons < 1 && h.totals.fuel_min < h.totals.fuel_max, JSON.stringify(h.totals));
    const p = openPage(env, { hash: "history/24h" });
    await p.settle();
    const kpis = p.$("h-kpis").innerHTML;
    // The lowest and highest tank reading, lowest first, with no arrow that reads as a start and an end.
    assert.ok(kpis.includes(`Fuel used (est.)</div><div class="val">${h.totals.gallons.toFixed(2)}<small>gal</small></div>` +
      `<div class="delta">tank ${Math.round(h.totals.fuel_min)} to ${Math.round(h.totals.fuel_max)} %</div>`), kpis);
    // Under 25 logged miles: grey, called rough, and no verdict against EPA.
    assert.ok(kpis.includes(`MPG (est.)</div><div class="val rough">${f1(h.totals.mpg)}<small>mpg</small></div>` +
      `<div class="delta">rough, only ${f1(h.totals.miles_down)} of 25 mi logged</div>`), kpis);
    assert.doesNotMatch(kpis, /vs EPA|class="(up|down)"|→|by odometer/);
    const table = p.$("h-daytable").innerHTML;
    assert.match(table, /<th class="num">Gal \(est\.\)<\/th><th class="num">MPG \(est\.\)<\/th>/);
    assert.doesNotMatch(table, / gal</);

    // About 29 logged miles at about 10 mpg: a figure against EPA, in plain text, and the gallons
    // with one decimal.
    const far = makeEnv();
    await upload(far, drive({ n: 2400 }).map((r) => ({ ...r, maf_gs: Math.round(r.maf_gs * 370) / 100 })), T0 + 2500);
    setNow(T0 + 4000);
    const g = await api(far, `api/history?from=${T0 + 4000 - 86400}&to=${T0 + 4000}`);
    assert.ok(!g.totals.mpg_few_miles && g.totals.mpg < 19 && g.totals.gallons >= 1, JSON.stringify(g.totals));
    const q = openPage(far, { hash: "history/24h" });
    await q.settle();
    const pct = Math.round(((g.totals.mpg - 19) / 19) * 100);
    assert.ok(q.$("h-kpis").innerHTML.includes(`MPG (est.)</div><div class="val">${f1(g.totals.mpg)}<small>mpg</small></div><div class="delta">${pct}% vs EPA 19</div>`), q.$("h-kpis").innerHTML);
    assert.ok(q.$("h-kpis").innerHTML.includes(`Fuel used (est.)</div><div class="val">${f1(g.totals.gallons)}<small>gal</small></div>`));
    assert.deepEqual([...p.errors, ...q.errors], []);
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

  check("durations: a full hour is 1 h, an upload gap of days is in days, and an old upload or reading gives its date", async () => {
    const env = makeEnv();
    // Three uploads: one, an hour after it, and five days after that.
    const day5 = 5 * 86400;
    await upload(env, drive({ boot: 12, n: 60 }), T0 + 100);
    await upload(env, drive({ boot: 13, n: 60, base: T0 + 3600 }), T0 + 3700);
    await upload(env, drive({ boot: 14, n: 60, base: T0 + 3600 + day5 }), T0 + 3700 + day5);
    const short = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    const secs = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
    const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    const last = new Date((T0 + 3700 + day5) * 1000);
    const card = (q) => /Last upload<\/div><div class="val [^"]*">[^<]*<\/div><div class="delta">([^<]*)</.exec(q.$("g-health").innerHTML)?.[1];
    setNow(T0 + 3760 + day5);
    const p = openPage(env, { hash: "logs" });
    await p.settle();
    const gaps = [...p.$("g-uploads").innerHTML.matchAll(/<td class="num">([^<]*)<\/td><\/tr>/g)].map((m) => m[1]);
    assert.deepEqual(gaps, ["5 d", "1 h", ""]);
    // An upload from today gives the clock time alone.
    assert.equal(card(p), secs.format(last));
    // The readings span six days, from the first session to the newest.
    assert.equal(p.$("g-raw-chip").textContent, `newest 180 · ${short.format(new Date((T0 + 20) * 1000))} to ${short.format(last)}`);
    // The next day the upload is from yesterday, so it gives the day as well.
    setNow(T0 + 3760 + day5 + 86400);
    const q = openPage(env, { hash: "logs" });
    await q.settle();
    assert.equal(card(q), `${day.format(last)}, ${time.format(last)}`);

    // Readings from one day name that day. History wraps the units of the engine time.
    const one = makeEnv();
    await parkedCar(one);
    const r = openPage(one, { hash: "logs" });
    await r.settle();
    assert.equal(r.$("g-raw-chip").textContent, `newest 200 · ${short.format(new Date(T0 * 1000))}`);
    const h = openPage(one, { hash: "history/24h" });
    await h.settle();
    assert.match(h.$("h-kpis").innerHTML, /Engine on<\/div><div class="val">\d+<small>min<\/small><\/div><div class="delta">\d+ min moving · \d+ (s|min) idle<\/div>/);
    assert.match(h.$("h-daytable").innerHTML, /<td class="num">\d+ min<\/td>/);
    assert.deepEqual([...p.errors, ...q.errors, ...r.errors, ...h.errors], []);
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

  check("live: each gauge has its icon, and hot coolant is one number on the gauge and a labeled line on the charts", async () => {
    const env = makeEnv();
    // The coolant climbs from 90 to about 114 °C (237 °F).
    await upload(env, drive({ n: 120 }).map((r, i) => ({ ...r, coolant_c: 90 + i * 0.2 })), T0 + 140);
    setNow(T0 + 145);
    const p = openPage(env, { hash: "live" });
    await p.settle();
    assert.equal(p.header(), "Engine running · updated just now");
    const g = p.$("l-gauges").innerHTML;
    const icons = [...g.matchAll(/<use href="#([^"]+)"\/><\/svg><\/span>([^<]+)<\/div>/g)].map((m) => `${m[2]} ${m[1]}`);
    assert.deepEqual(icons, ["Speed i-gauge", "Engine speed i-pulse", "Throttle i-pulse", "Coolant i-temp", "Instant MPG i-drop",
      "Airflow i-pulse", "Battery i-batt", "Intake air i-temp", "Fuel i-fuel", "Cell signal i-signal"]);
    assert.match(g, /Coolant<\/div>\s*<div class="val">237<small>°F<\/small><\/div><div class="delta"><span class="down">Hot<\/span>/);
    // The height of the line and of its label in a coolant chart.
    const ref = (id, q) => {
      const svg = q.$(id).innerHTML;
      const line = /<line x1="[^"]+" x2="[^"]+" y1="([\d.]+)" y2="[\d.]+" stroke="#ef4444"/.exec(svg);
      const text = /<text x="[\d.]+" y="([\d.]+)" text-anchor="end" style="fill:#ef4444">Hot 230 °F<\/text>/.exec(svg);
      assert.ok(line && text, `${id}: no labeled line at 230 °F`);
      return [+line[1], +text[1]];
    };
    // Well below the top of the chart, so the label sits above the line.
    let [line, text] = ref("l-cool", p);
    assert.ok(line > 14 && text < line, `${line} ${text}`);
    p.nav("trips");
    await p.settle();
    [line, text] = ref("t-cool", p);
    assert.ok(line > 14 && text < line, `${line} ${text}`);
    // A drive that peaks just under 230 °F: the line runs close to the top, and the label goes below it.
    const near = makeEnv();
    await upload(near, drive({ n: 120 }).map((r, i) => ({ ...r, coolant_c: 90 + i * 0.16 })), T0 + 140);
    const n = openPage(near, { hash: "trips" });
    await n.settle();
    [line, text] = ref("t-cool", n);
    assert.ok(line < 14 && text > line, `${line} ${text}`);
    // A drive that stays well below it draws neither the line nor the label.
    const cool = makeEnv();
    await threeTrips(cool, 126800);
    const q = openPage(cool, { hash: "trips" });
    await q.settle();
    assert.doesNotMatch(q.$("t-cool").innerHTML, /Hot|#ef4444/);
    // One color per quantity on the cards: the battery is pink and speed is blue, as in the charts.
    assert.match(html, /<svg style="color:var\(--pink\)"><use href="#i-batt"\/><\/svg><\/span>Battery<\/div>/);
    q.nav("history");
    await q.settle();
    assert.match(q.$("h-kpis").innerHTML, /<svg style="color:var\(--blue\)"><use href="#i-gauge"\/><\/svg><\/span>Top speed<\/div>/);
    assert.deepEqual([...p.errors, ...n.errors, ...q.errors], []);
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

  check("live: throttle and airflow that stop coming show a dash, the next day with the age of the last reading", async () => {
    // Every fixture record carries throttle and airflow, so the check above never takes them away.
    const none = (r) => ({ ...r, throttle_pct: null, maf_gs: null });
    // The next day a drive without throttle and airflow. `latest` still holds yesterday's. Its own
    // database, so the check above keeps its single grey card.
    const env = makeEnv();
    await parkedCar(env);
    await upload(env, drive({ boot: 12, n: 60, base: T0 + 86400 }).map(none), T0 + 86480);
    setNow(T0 + 86485);
    const p = openPage(env, { hash: "live" });
    await p.settle();
    assert.equal(p.header(), "Engine running · updated just now");
    const g = p.$("l-gauges").innerHTML;
    for (const label of ["Throttle", "Airflow"]) {
      assert.match(g, new RegExp(`<div class="card kpi gauge old">[^\\n]*>${label}<\\/div>\\s*<div class="val">–<small>[^<]*<\\/small><\\/div><div class="delta">Last read 24 h ago<`), label);
    }

    // One session: throttle and airflow stopped 20 s before the newest reading.
    const env2 = makeEnv();
    await upload(env2, [...drive({ n: 60 }), ...drive({ n: 20, ms0: 80000 }).map(none)], T0 + 100);
    setNow(T0 + 105);
    const q = openPage(env2, { hash: "live" });
    await q.settle();
    assert.equal(q.header(), "Engine running · updated just now");
    const h = q.$("l-gauges").innerHTML;
    assert.match(h, /Throttle<\/div>\s*<div class="val">–<small>/);
    assert.match(h, /Airflow<\/div>\s*<div class="val">–<small>/);
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
    // A parked car gives the time it stopped, which does not age.
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    assert.equal(p.$("o-loc-sub").textContent, `Parked since ${time.format(new Date((T0 + 319) * 1000))}`);
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

  check("charts: the y labels are whole steps of 1, 2, 2.5 or 5, every value is inside the plot, and a steady reading stays flat", async () => {
    const env = makeEnv();
    await parkedCar(env);
    // The page writes the labels with toLocaleString, so the same separators read them back.
    const group = (1000).toLocaleString().replace(/\d/g, ""), point = (1.5).toLocaleString().replace(/\d/g, "");
    const num = (s) => +s.split(group).join("").replace(point, ".");
    // The y labels from the bottom up. They end 8 px left of the plot: at 32 in a line chart, 26 in a bar chart.
    const ylabels = (svg, x) => [...svg.matchAll(new RegExp(`<text x="${x}" y="[\\d.]+" text-anchor="end">([^<]*)</text>`, "g"))].map((m) => num(m[1]));
    // `least` is 4 for a bar chart: from 0 the steps always give at least four labels.
    const whole = (name, vals, least = 3) => {
      assert.ok(vals.length >= least, `${name}: ${vals.length} y labels (${vals})`);
      const step = vals[1] - vals[0], k = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
      assert.ok([1, 2, 2.5, 5].some((m) => Math.abs(k - m) < 1e-6), `${name}: a step of ${step} (${vals})`);
      vals.forEach((v, i) => {
        assert.ok(Math.abs(v - (vals[0] + i * step)) < 1e-6, `${name}: ${vals} are not one step apart`);
        assert.ok(Math.abs(v / step - Math.round(v / step)) < 1e-6, `${name}: ${v} is not a whole multiple of ${step}`);
      });
      return vals;
    };
    // Every dot and every point of the line and its fill lies between the top (10) and the bottom of the plot.
    const inside = (name, svg, h) => {
      const ys = [...svg.matchAll(/<circle cx="[\d.]+" cy="(-?[\d.]+)"/g)].map((m) => +m[1]);
      for (const d of svg.matchAll(/<path d="([^"]*)"/g)) for (const m of d[1].matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) ys.push(+m[2]);
      assert.ok(ys.length > 0, `${name}: nothing drawn`);
      assert.ok(ys.every((y) => y >= 10 && y <= h - 22), `${name}: drawn at ${ys.filter((y) => y < 10 || y > h - 22)}`);
    };
    const p = openPage(env);
    await p.settle();
    whole("Last drive", ylabels(p.$("o-drive").innerHTML, 32));
    inside("Last drive", p.$("o-drive").innerHTML, 200);
    assert.equal(whole("MPG by trip", ylabels(p.$("o-econ").innerHTML, 26), 4)[0], 0);
    // History over the ten minutes of that drive, so the chart has many points and not one average.
    const h = openPage(env, { hash: `history/${T0}-${T0 + 600}` });
    await h.settle();
    assert.equal(whole("By day", ylabels(h.$("h-days").innerHTML, 26), 4)[0], 0);
    const metric = (m) => { h.groups["#h-metrics button"].find((b) => b.dataset.m === m).onclick(); return h.$("h-chart").innerHTML; };
    // The battery reads 14.10 to 14.16 V. Its axis spans at least 1 V, so that wobble draws a flat line.
    const volts = whole("History battery", ylabels(metric("battery"), 32));
    assert.ok(volts[volts.length - 1] - volts[0] >= 1, `battery axis ${volts}`);
    inside("History battery", h.$("h-chart").innerHTML, 230);
    // The tank against its full range, and the coolant on its own range instead of from 0.
    assert.deepEqual(whole("History fuel", ylabels(metric("fuel"), 32)), [0, 25, 50, 75, 100]);
    assert.ok(whole("History coolant", ylabels(metric("coolant"), 32))[0] > 0, "the coolant axis starts at 0");
    inside("History coolant", h.$("h-chart").innerHTML, 230);
    // A cold morning: the intake air reads -22 °F. Its axis goes below 0, and the readings stay inside the plot.
    const cold = makeEnv();
    await upload(cold, drive({ n: 120 }).map((r) => ({ ...r, intake_c: -30 })), T0 + 140);
    setNow(T0 + 4000);
    const q = openPage(cold, { hash: "history" });
    await q.settle();
    q.groups["#h-metrics button"].find((b) => b.dataset.m === "intake").onclick();
    const air = whole("History intake", ylabels(q.$("h-chart").innerHTML, 32));
    assert.ok(air[0] < -22, `intake axis ${air}`);
    inside("History intake", q.$("h-chart").innerHTML, 230);
    assert.deepEqual([...p.errors, ...h.errors, ...q.errors], []);
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
    // .btn sets display and comes later. Without !important "Google Maps" is drawn as a dead
    // button until there is a position.
    assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    assert.match(html, /<a class="btn" id="o-maps"[^>]* hidden>/);
  });

  check("shell: a strip under the status bar, side insets, 44 px controls on touch screens and a dark scheme", async () => {
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const root = style.slice(style.indexOf(":root {"), style.indexOf("\n  }", style.indexOf(":root {")));
    assert.match(root, /color-scheme: dark;/);
    assert.equal((style.match(/color-scheme/g) ?? []).length, 1, "color-scheme is set once, on :root");
    assert.match(style, /body::before \{[^}]*position: fixed;[^}]*height: env\(safe-area-inset-top, 0px\);[^}]*background: var\(--bg\);/);
    assert.match(style, /\.app \{[^}]*grid-template-columns: calc\(232px \+ env\(safe-area-inset-left, 0px\)\) 1fr;/);
    assert.match(style, /:focus-visible \{ outline: 2px solid #8fb0ff;/);
    // The touch block uses the same test as TOUCH in the script.
    const query = /matchMedia\("([^"]+)"\)/.exec(html)[1];
    const at = style.indexOf(`@media ${query} {`);
    assert.ok(at > 0, `no CSS block for ${query}`);
    const touch = style.slice(at, style.indexOf("\n  }", at));
    assert.match(touch, /\.btn, \.seg button, \.custom input, \.status button \{ min-height: 44px; \}/);
    assert.match(touch, /\.leaflet-touch \.leaflet-bar a \{ width: 44px; height: 44px; line-height: 44px; \}/);
    assert.match(touch, /\.custom input \{ font-size: 16px; \}/);
  });

  check("scroll boxes: Recent trips never scrolls inside its card, and Logs ends with the raw readings", async () => {
    // The page text from `from` up to the first `to` after it.
    const part = (from, to) => { const a = html.indexOf(from); return a < 0 ? "" : html.slice(a, html.indexOf(to, a)); };
    // At every width, so outside any media query.
    assert.match(part("/* ---------- trips ---------- */", "/* ---------- live ---------- */"), /\n  #o-trips \{ max-height: none; \}/);
    assert.match(part("@media (max-width: 820px) {\n", "\n  }"), /\.tablewrap \{ max-height: min\(320px, 55vh\); \}/);
    const logs = part('<section class="view" id="v-logs">', "</section>");
    const order = ["g-health", "g-uploads", "g-boots", "g-raw"].map((id) => logs.indexOf(`id="${id}"`));
    assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), `Logs order ${order}`);
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
    assert.match(p.header(), /^Parked · offline mid-drive, /);
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
    // The first request of each kind fails. "api/trip/" is the per-minute series of the last drive.
    // Given at open: the trips and the economy are asked for at once, beside the status.
    const p = openPage(env, {
      reject: (path) => {
        const kind = ["api/trips", "api/economy", "api/trip/"].find((k) => path.startsWith(k));
        if (!kind || failedOnce.has(kind)) return false;
        failedOnce.add(kind);
        return true;
      },
    });
    await p.settle();
    assert.deepEqual([p.requests("api/trips"), p.requests("api/economy"), p.requests("api/trip/")], [1, 1, 0]);
    // What did not load says so.
    for (const id of ["o-trips", "t-list"]) assert.equal(p.$(id).innerHTML, '<li class="empty">Could not load the trips. Trying again.</li>');
    assert.equal(p.$("o-econ").innerHTML, '<div class="empty">Could not load the MPG figures.</div>');

    // The next poll asks for trips and economy again. The trip list then asks for the last drive.
    await p.poll();
    assert.deepEqual([p.requests("api/trips"), p.requests("api/economy"), p.requests("api/trip/")], [2, 2, 1]);
    assert.equal(p.$("o-trips-chip").textContent, "1 total");
    assert.match(p.$("o-econ-chip").textContent, /mi logged$/);
    assert.match(p.$("o-econ").innerHTML, /^<svg /);
    assert.equal(p.$("o-drive-chip").textContent, "");
    assert.equal(p.$("o-drive").innerHTML, '<div class="empty">Could not load the last drive.</div>');

    // That one failed too. It is asked again with the next trip list, on the sixth poll.
    for (let i = 0; i < 5; i++) await p.poll();
    assert.deepEqual([p.requests("api/trips"), p.requests("api/trip/")], [3, 2]);
    assert.match(p.$("o-drive-chip").textContent, /^top \d+ mph$/);
    assert.equal(p.header(), "Parked · updated 1.0 h ago");
    assert.deepEqual(p.errors, []);
  });

  check("page open: the trips and the economy are asked for while the status is still on its way", async () => {
    // Room is kept for the two Overview charts, the readout line above the Last drive chart and the
    // button below it, so the cards below them do not jump.
    assert.match(html, /#o-drive \{ min-height: 200px; \}/);
    assert.match(html, /#o-econ \{ min-height: 190px; \}/);
    assert.match(html, /#o-drive-r \{ min-height: 1\.45em; \}/);
    assert.match(html, /<button class="btn mt" id="o-drive-open" type="button" style="visibility:hidden">/);
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env, { hold: (path) => path.startsWith("api/status") });
    await p.settle();
    assert.deepEqual([p.requests("api/status"), p.requests("api/trips"), p.requests("api/economy")], [1, 1, 1]);
    // The lists and both charts are drawn without the car state.
    assert.equal(p.$("o-trips-chip").textContent, "1 total");
    assert.match(p.$("o-drive-chip").textContent, /^top \d+ mph$/);
    assert.match(p.$("o-econ").innerHTML, /^<svg /);
    // The status is given up after 30 s. The next poll brings the car.
    p.net.hold = null;
    assert.deepEqual(p.limits().map((t) => t.ms), [30000]);
    p.limits()[0].fn();
    await p.settle();
    assert.match(p.header(), /^No connection to the server/);
    await p.poll();
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

  // At page open the status is not known yet, so the check above cannot tell the two rules apart:
  // a failure during an outage is not counted, and neither is one before the first answer.
  check("a trip list and economy that failed once while the server answered keep their early retry through a later outage", async () => {
    const env = makeEnv();
    await parkedCar(env);
    // The first trip list and economy requests fail after the status was answered, so each counts once.
    const first = new Set();
    const p = openPage(env, {
      reject: (path) => {
        const kind = ["api/trips", "api/economy"].find((k) => path.startsWith(k));
        if (!kind || first.has(kind)) return false;
        first.add(kind);
        return "late";
      },
    });
    await p.settle();
    // Two polls during an outage. Their failures must not use up the retry.
    p.net.reject = () => true;
    let t = T0 + 4000;
    for (let i = 0; i < 2; i++) { t += p.nextPoll() / 1000; setNow(t); await p.poll(); }
    assert.deepEqual([p.$("o-trips-chip").textContent, p.$("o-econ-chip").textContent], ["", ""]);
    p.net.reject = null;
    t += p.nextPoll() / 1000; setNow(t);
    await p.poll();
    assert.equal(p.$("o-trips-chip").textContent, "1 total");
    assert.match(p.$("o-econ-chip").textContent, /mi logged$/);
    assert.deepEqual(p.errors, []);
  });

  check("failures before the first answer do not count, so one more failure after it still gets an early retry", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env, { reject: () => true });
    await p.settle();
    // The server answers, and the trip list and the economy fail once more after the status.
    p.net.reject = (path) => (path.startsWith("api/trips") || path.startsWith("api/economy")) && "late";
    let t = T0 + 4000;
    t += p.nextPoll() / 1000; setNow(t);
    await p.poll();
    assert.deepEqual([p.$("o-trips-chip").textContent, p.$("o-econ-chip").textContent], ["", ""]);
    p.net.reject = null;
    t += p.nextPoll() / 1000; setNow(t);
    await p.poll();
    assert.equal(p.$("o-trips-chip").textContent, "1 total");
    assert.match(p.$("o-econ-chip").textContent, /mi logged$/);
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

  check("an answer the Worker did not write is an outage in the header, a 429 of that kind names the request limit, and the Worker's own refusal is a note", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env);
    await p.settle();
    const bad = () => p.$("state").parentNode.classList.contains("bad");
    const page = (status, text) => new Response(text, { status, headers: { "Content-Type": "text/html" } });
    // Cloudflare refuses the status request with a page of its own.
    p.net.answer = (path, res) => (path.startsWith("api/status") ? page(429, "<html>Too many requests</html>") : res);
    await p.poll();
    const limit = "Request limit reached (429). It resets at midnight UTC.";
    assert.equal(p.header(), `${limit} · last data 1.0 h ago`);
    assert.ok(bad(), "the header is not marked as failing");
    assert.equal(p.$("foot").textContent, limit);
    assert.equal(p.nextPoll(), 5000);
    // A gateway error page is an outage too.
    p.net.answer = (path, res) => (path.startsWith("api/status") ? page(502, "Bad gateway") : res);
    setNow(T0 + 4005);
    await p.poll();
    assert.equal(p.header(), "Server error 502 · last data 1.0 h ago");
    // The Worker answers again.
    p.net.answer = null;
    setNow(T0 + 4010);
    await p.poll();
    assert.equal(p.header(), "Parked · updated 1.0 h ago");
    assert.ok(!bad(), "the header still says it is failing");
    // The Worker's own refusal, a trip that does not exist, is a note in the footer, and the header
    // stays on the car.
    const json = (status, d) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });
    p.net.answer = (path, res) => (path.startsWith("api/trip/") ? json(404, { error: "not found" }) : res);
    p.nav("trips");
    await p.settle();
    assert.equal(p.header(), "Parked · updated 1.0 h ago");
    assert.equal(p.$("foot").textContent, "not found");
    // The same status from in front of the Worker is an outage.
    p.net.answer = (path, res) => (path.startsWith("api/trip/") ? page(404, "<html>Not found</html>") : res);
    p.$("t-list").children[0].onclick();
    await p.settle();
    assert.equal(p.header(), "Server error 404 · last data 1.0 h ago");
    assert.ok(bad(), "the header is not marked as failing");
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

  check("history: the label changes with the answer, and a trip that is still loading says so", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    const at = (ts) => `${day.format(new Date(ts * 1000))}, ${time.format(new Date(ts * 1000))}`;
    const p = openPage(env, { hash: `history/${T0 - 600}-${T0 + 8000}` });
    await p.settle();
    const shown = p.$("h-label").textContent;
    assert.ok(shown.startsWith(`${at(T0 - 600)}  to  ${at(T0 + 8000)}`), shown);
    // A new range is on its way. The cards still show the old one, and so does the label.
    p.net.hold = (path) => path.startsWith(`api/history?from=${T0 + 3000}&`);
    p.location.hash = `history/${T0 + 3000}-${T0 + 8000}`;
    await p.settle();
    assert.equal(p.$("h-label").textContent, shown);
    // Given up after 30 s, it names the range that could not load.
    p.net.hold = null;
    p.limits()[0].fn();
    await p.settle();
    assert.equal(p.$("h-label").textContent, `${at(T0 + 3000)}  to  ${at(T0 + 8000)} · could not load`);
    p.groups["#h-presets button[data-p]"].find((b) => b.dataset.p === "24h").onclick();
    await p.settle();
    assert.ok(p.$("h-label").textContent.startsWith(`${at(T0 + 8000 - 86400)}  to  ${at(T0 + 8000)}`), p.$("h-label").textContent);

    // Trips: the newest trip is on screen, then the oldest is tapped and its answer is held.
    const q = openPage(env, { hash: "trips" });
    await q.settle();
    const marked = () => q.$("t-list").children.filter((li) => li.classList.contains("sel")).map((li) => li.dataset.id);
    const [newest, oldest] = [sid(14, INST), sid(12, INST)].map(String);
    assert.match(q.$("t-sub").textContent, new RegExp(`^Trip ${INST}-14 · `));
    q.net.hold = (path) => path === `api/trip/${oldest}`;
    q.$("t-list").children[2].onclick();
    await q.settle();
    assert.equal(q.$("t-sub").textContent, "Loading this trip…");
    assert.deepEqual(marked(), [oldest]);
    // Given up, the card names the trip it still shows, and the list marks that trip again.
    q.net.hold = null;
    q.limits()[0].fn();
    await q.settle();
    assert.match(q.$("t-sub").textContent, new RegExp(`^Trip ${INST}-14 · `));
    assert.deepEqual(marked(), [newest]);
    // The same when the request fails at once.
    q.net.reject = (path) => path === `api/trip/${oldest}`;
    q.$("t-list").children[2].onclick();
    await q.settle();
    assert.match(q.$("t-sub").textContent, new RegExp(`^Trip ${INST}-14 · `));
    assert.deepEqual(marked(), [newest]);
    // A tap tries again, and loads it.
    q.net.reject = null;
    q.$("t-list").children[2].onclick();
    await q.settle();
    assert.match(q.$("t-sub").textContent, new RegExp(`^Trip ${INST}-12 · `));
    assert.deepEqual(marked(), [oldest]);
    assert.deepEqual([...p.errors, ...q.errors], []);
  });

  check("history: opens on 30 days, and an empty period is one line with the last trip and a button to its day", async () => {
    const env = makeEnv();
    await parkedCar(env);
    const p = openPage(env, { hash: "history" });
    await p.settle();
    // From local midnight 29 days back, like get_history's last_30_days.
    const now = T0 + 4000, n = new Date(now * 1000);
    const month = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 29).getTime() / 1000;
    assert.deepEqual(p.net.log.filter((path) => path.startsWith("api/history?")), [`api/history?from=${month}&to=${now}`]);
    assert.ok(p.groups["#h-presets button[data-p]"].find((b) => b.dataset.p === "30d").classList.contains("active"), "30 days is not marked");
    assert.deepEqual([p.$("h-none").hidden, p.$("h-body").hidden], [true, false]);

    // An hour after the drive, nothing happened.
    const start = (await api(env, "api/trips?limit=40")).trips[0].start_ts;
    const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    const when = `${day.format(new Date(start * 1000))}, ${time.format(new Date(start * 1000))}`;
    p.location.hash = `history/${T0 + 1000}-${T0 + 3000}`;
    await p.settle();
    assert.deepEqual([p.$("h-none").hidden, p.$("h-body").hidden, p.$("h-none-day").hidden], [false, true, false]);
    assert.equal(p.$("h-none-t").textContent, `No driving in this period. The last trip was ${when}.`);
    // The button opens the local day of that trip, in place of the empty range.
    p.$("h-none-day").onclick();
    await p.settle();
    const s = new Date(start * 1000);
    const [a, b] = [0, 1].map((k) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + k).getTime() / 1000);
    assert.equal(p.location.hash, `#history/${a}-${b - 1}`);
    assert.deepEqual(p.pushed, []);
    assert.deepEqual([p.$("h-none").hidden, p.$("h-body").hidden], [true, false]);
    assert.match(p.$("h-kpis").innerHTML, /<div class="delta">1 trip<\/div>/);

    // The trip list fails at page open and comes with the next poll. The line then names the trip.
    let tripsFailed = false;
    const reject = (path) => {
      if (tripsFailed || !path.startsWith("api/trips")) return false;
      tripsFailed = true;
      return true;
    };
    const q = openPage(env, { hash: `history/${T0 + 1000}-${T0 + 3000}`, reject });
    await q.settle();
    assert.equal(q.$("h-none-t").textContent, "No driving in this period.");
    assert.equal(q.$("h-none-day").hidden, true);
    await q.poll();
    assert.equal(q.$("h-none-t").textContent, `No driving in this period. The last trip was ${when}.`);
    assert.equal(q.$("h-none-day").hidden, false);
    assert.deepEqual([...p.errors, ...q.errors], []);
  });

  check("history: Custom opens the date fields on a phone, a chart is titled like its button, and Apply orders the dates or says what is missing", async () => {
    // On a phone the date fields are folded away until Custom opens them. Elsewhere there is no Custom.
    const phone = html.slice(html.indexOf("/* ---------- history ---------- */"), html.indexOf("/* ---------- responsive ---------- */"));
    assert.match(phone, /@media \(max-width: 820px\) \{[^\n]*\.custom:not\(\.open\) \{ display: none; \}/);
    assert.match(phone, /@media \(min-width: 821px\) \{ #h-custom \{ display: none; \} \}/);
    // Custom has no preset, so the preset buttons and their marks leave it alone.
    assert.match(html, /<button id="h-custom" type="button">Custom<\/button>\s*<\/div>/);
    const env = makeEnv();
    await threeTrips(env, 126800);
    const p = openPage(env, { hash: `history/${T0 - 600}-${T0 + 8000}`, width: 375, touch: true });
    await p.settle();
    const open = () => [p.$("h-dates").classList.contains("open"), p.$("h-custom").classList.contains("active")];
    p.$("h-custom").onclick();
    assert.deepEqual(open(), [true, true]);
    p.$("h-custom").onclick();
    assert.deepEqual(open(), [false, false]);

    const names = new Map([...html.matchAll(/<button data-m="([^"]+)">([^<]+)<\/button>/g)].map((m) => [m[1], m[2]]));
    assert.equal(names.size, 8);
    for (const b of p.groups["#h-metrics button"]) {
      b.onclick();
      assert.equal(p.$("h-metric-title").textContent, names.get(b.dataset.m));
    }

    // The dates the wrong way round are asked for in order.
    p.$("h-from").value = wall(T0 + 3600);
    p.$("h-to").value = wall(T0 - 600);
    const before = p.net.log.length;
    p.$("h-apply").onclick();
    await p.settle();
    assert.deepEqual(p.net.log.slice(before).filter((path) => path.startsWith("api/history?")), [`api/history?from=${T0 - 600}&to=${T0 + 3600}`]);
    // An empty field, then two equal ends: said once each next to the range on screen, and nothing is asked.
    const shown = p.$("h-label").textContent, asked = p.requests("api/history?");
    p.$("h-to").value = "";
    p.$("h-apply").onclick();
    p.$("h-apply").onclick();
    assert.equal(p.$("h-label").textContent, `${shown} · Pick a start and an end.`);
    p.$("h-to").value = p.$("h-from").value;
    p.$("h-apply").onclick();
    assert.equal(p.$("h-label").textContent, `${shown} · Start and end are the same.`);
    await p.settle();
    assert.equal(p.requests("api/history?"), asked);
    assert.deepEqual(p.errors, []);
  });

  check("history: a resize to the same width draws nothing, a new width draws the charts and leaves the map", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    const p = openPage(env, { hash: `history/${T0 - 600}-${T0 + 8000}`, width: 390, touch: true });
    await p.settle();
    const drawn = () => [p.$("h-chart").innerHTML, p.$("h-days").innerHTML];
    const fits = () => p.calls.filter((k) => k === "fitBounds").length;
    const [before, fit] = [drawn(), fits()];
    assert.ok(before[0].startsWith("<svg ") && before[1].startsWith("<svg "), "the History charts are drawn");
    assert.equal(fit, 1, "the routes are fitted once");
    // Safari's toolbar slides in: a resize at the same width.
    p.listeners.resize();
    await p.settle();
    assert.deepEqual(drawn(), before);
    // The phone turns.
    p.setWidth(844);
    p.listeners.resize();
    await p.settle();
    const after = drawn();
    assert.notEqual(after[0], before[0], "h-chart is drawn again at the new width");
    assert.notEqual(after[1], before[1], "h-days is drawn again at the new width");
    assert.equal(fits(), fit, "the map is not fitted again");
    assert.deepEqual(p.errors, []);
  });

  check("charts: a redraw cancels the touch hold of the chart before, and a scroll that starts on a chart clears its value at once", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    const p = openPage(env, { hash: `history/${T0 - 600}-${T0 + 8000}`, width: 390, touch: true });
    await p.settle();
    // A pointer event from the browser to the chart that is drawn in `id` now.
    const send = (id, ev, e = {}) => p.$(id).querySelector("svg").handlers[ev]({ clientX: 200, pointerType: "touch", ...e });
    // The value stays up for 2.5 s after a finger lifts.
    const holds = () => p.polls().filter((t) => t.ms === 2500);
    const speed = p.$("h-readout").innerHTML;
    assert.match(speed, / mph$/);
    send("h-chart", "pointerdown");
    assert.notEqual(p.$("h-readout").innerHTML, speed);
    send("h-chart", "pointerleave");
    assert.equal(holds().length, 1);
    // Within those 2.5 s the RPM button draws a new chart. The hold of the Speed chart goes with
    // it, so it cannot put the Speed summary into the RPM readout later.
    p.groups["#h-metrics button"].find((b) => b.dataset.m === "rpm").onclick();
    const rpm = p.$("h-readout").innerHTML;
    assert.match(rpm, / rpm$/);
    assert.deepEqual(holds(), []);
    // A scroll that starts on the chart: the browser cancels the pointer, and the value goes at once.
    send("h-chart", "pointerdown");
    assert.notEqual(p.$("h-readout").innerHTML, rpm);
    send("h-chart", "pointercancel");
    assert.equal(p.$("h-readout").innerHTML, rpm);
    send("h-chart", "pointerleave");
    assert.deepEqual(holds(), []);
    // The bars of By day: a lifted finger keeps the value up, a mouse that leaves clears it, and so does a scroll.
    send("h-days", "pointerleave");
    assert.equal(holds().length, 1);
    send("h-days", "pointerleave", { pointerType: "mouse" });
    assert.deepEqual(holds(), []);
    send("h-days", "pointercancel");
    send("h-days", "pointerleave");
    assert.deepEqual(holds(), []);
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

  check("charts: MPG by trip keeps its dates past 12 bars, gives each day one label, and says when trips were left out", async () => {
    const env = makeEnv();
    // Two short trips a day, an hour apart, on each of the last 8 days. Only the newest 14 are drawn.
    for (let k = 7; k >= 0; k--) {
      for (const h of [0, 3600]) {
        const base = T0 - k * 86400 + h;
        await upload(env, drive({ boot: 20 + 2 * k + h / 3600, n: 60, base, odo0: null }), base + 100);
      }
    }
    setNow(T0 + 4000);
    const labels = (svg) => [...svg.matchAll(/<text [^>]*y="185"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    for (const [width, count] of [[600, 7], [305, 4]]) {
      const p = openPage(env, { width });
      await p.settle();
      const svg = p.$("o-econ").innerHTML;
      assert.equal((svg.match(/<rect class="bar"/g) ?? []).length, 14);
      const days = labels(svg);
      assert.equal(days.length, count, `width ${width}: ${days}`);
      assert.equal(new Set(days).size, days.length, `a date is drawn twice: ${days}`);
      assert.equal(p.$("o-econ-sub").textContent, "Newest 14 of 16 trips in the last 30 days");
      assert.deepEqual(p.errors, []);
    }
  });

  check("charts: MPG by trip is called an estimate, and on a phone each day keeps its date and the newest day always has one", async () => {
    assert.match(html, /<h3>MPG by trip \(est\.\)<\/h3>/);
    // The dates under the bars from left to right, and the date the page gives a moment.
    const labels = (svg) => [...svg.matchAll(/<text x="([\d.]+)" y="185"[^>]*>([^<]*)<\/text>/g)].map((m) => [+m[1], m[2]]);
    const day = (ts) => new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date(ts * 1000)).replace(/^\w+,?\s*/, "");
    // One trip on a day, then six on the next, ten minutes apart. Seven bars at 305 px.
    const env = makeEnv();
    const starts = [T0 - 86400, ...[0, 1, 2, 3, 4, 5].map((k) => T0 + k * 600)];
    for (const [i, base] of starts.entries()) await upload(env, drive({ boot: 20 + i, n: 60, base, odo0: null }), base + 100);
    setNow(T0 + 4000);
    const p = openPage(env, { width: 305 });
    await p.settle();
    const svg = p.$("o-econ").innerHTML;
    assert.equal((svg.match(/<rect class="bar"/g) ?? []).length, 7);
    const dates = labels(svg);
    assert.deepEqual(dates.map((d) => d[1]), [day(T0 - 86400), day(T0)]);
    // Each date sits under the middle of its bars: the first bar, then the other six.
    const slot = (305 - 34) / 7;
    assert.deepEqual(dates.map((d) => Math.round(d[0] * 10) / 10), [Math.round((34 + 0.5 * slot) * 10) / 10, Math.round((34 + 4 * slot) * 10) / 10]);

    // A trip a day for eight days. There is room for every second date, and the newest is one of them.
    const week = makeEnv();
    for (let k = 7; k >= 0; k--) await upload(week, drive({ boot: 30 + k, n: 60, base: T0 - k * 86400, odo0: null }), T0 - k * 86400 + 100);
    setNow(T0 + 4000);
    const q = openPage(week, { width: 305 });
    await q.settle();
    const eight = labels(q.$("o-econ").innerHTML).map((d) => d[1]);
    assert.deepEqual(eight, [6, 4, 2, 0].map((k) => day(T0 - k * 86400)));
    assert.deepEqual([...p.errors, ...q.errors], []);
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

  check("overview: under 25 logged miles a rough MPG below EPA sets the range, and both cards call it rough", async () => {
    const f1 = (x) => (Math.round(x * 10) / 10).toLocaleString();
    // About 14 miles at about 10 mpg: more airflow for the same speeds.
    const env = makeEnv();
    await upload(env, drive({ n: 1200 }).map((r) => ({ ...r, maf_gs: Math.round(r.maf_gs * 370) / 100 })), T0 + 1300);
    setNow(T0 + 4000);
    const st = await api(env, "api/status");
    assert.ok(st.mpg30 == null && st.mpg30_rough > 9 && st.mpg30_rough < 11, JSON.stringify([st.mpg30, st.mpg30_rough]));
    const p = openPage(env);
    await p.settle();
    const gal = (st.latest.fuel_pct.v / 100) * 18.5;
    assert.equal(p.$("k-range").innerHTML, `${Math.round(gal * st.mpg30_rough).toLocaleString()}<small>mi</small>`);
    assert.equal(p.$("k-range-d").textContent, `rough, at ${f1(st.mpg30_rough)} mpg`);
    assert.equal(p.$("k-mpg").innerHTML, `${f1(st.mpg30_rough)}<small>mpg</small>`);
    assert.ok(p.$("k-mpg").classList.contains("rough"), "the rough figure is grey");
    assert.equal(p.$("k-mpg-d").textContent, `rough, ${f1(st.mpg30_miles)} of 25 mi logged`);
    assert.match(p.$("k-fuel-d").textContent, /^about [\d.]+ of 18\.5 gal · /);

    // A rough figure above EPA: the range stays at EPA, the card still shows it as rough.
    const high = makeEnv();
    await upload(high, drive({ n: 1200 }), T0 + 1300);
    setNow(T0 + 4000);
    const q = openPage(high);
    await q.settle();
    assert.equal(q.$("k-range-d").textContent, "at EPA 19 mpg, too few miles logged yet");
    assert.ok(q.$("k-mpg").classList.contains("rough"));
    assert.match(q.$("k-mpg-d").textContent, /^rough, [\d.]+ of 25 mi logged$/);

    // From 25 miles on: the 30-day estimate, in plain text.
    const far = makeEnv();
    await upload(far, drive({ n: 2400 }), T0 + 2500);
    setNow(T0 + 4000);
    const r = openPage(far);
    await r.settle();
    assert.match(r.$("k-range-d").textContent, /^at your [\d.]+ mpg average$/);
    assert.match(r.$("k-mpg-d").textContent, /^30-day estimate · \+\d+% vs EPA 19$/);
    assert.ok(!r.$("k-mpg").classList.contains("rough"));

    // No status answer yet, only a live one: the EPA figure without a reason.
    const live = openPage(env, { hash: "live", reject: (path) => path.startsWith("api/status") });
    await live.settle();
    live.nav("overview");
    await live.settle();
    assert.equal(live.$("k-range-d").textContent, "at EPA 19 mpg");
    assert.deepEqual([...p.errors, ...q.errors, ...r.errors, ...live.errors], []);
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
      assert.equal((p.$("t-stats").innerHTML.match(/class="stat"/g) ?? []).length, 12);
      assert.match(p.$("t-stats").innerHTML, /Avg moving speed<\/div><div class="v">\d+ mph/);
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
      // The wheel scrolls the page. With a mouse, a click on a map turns its wheel zoom on and
      // leaving the map turns it off.
      assert.equal(p.made.length, 3);
      assert.ok(p.made.every((o) => o.scrollWheelZoom === false), JSON.stringify(p.made));
      assert.equal(p.calls.filter((k) => k === "on").length, touch ? 0 : 6);
      // Runs the handlers of an event on every map, as Leaflet would, and gives what they did.
      const handle = (ev) => { const at = p.calls.length; for (const [e, fn] of p.mapOn) if (e === ev) fn(); return p.calls.slice(at); };
      assert.deepEqual(handle("click"), Array(touch ? 0 : 3).fill("wheel on"));
      assert.deepEqual(handle("mouseout"), Array(touch ? 0 : 3).fill("wheel off"));
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

  check("when a drive ends the trip list and the fuel figures are read once, and an open trip catches up", async () => {
    const env = makeEnv();
    // Two minutes into a drive the trip is opened.
    const start = drive({ n: 120 });
    await upload(env, start, T0 + 140);
    setNow(T0 + 145);
    const p = openPage(env, { hash: "trips" });
    await p.settle();
    p.interval();
    assert.match(p.$("t-sub").textContent, / · in progress/);
    // Reads of a whole trip (not the per-minute series of the Last drive card), and of the list and the fuel figures.
    const full = () => p.net.log.filter((path) => /^api\/trip\/\d+$/.test(path)).length;
    const lists = () => [p.requests("api/trips"), p.requests("api/economy")];
    assert.equal(full(), 1);
    // Eleven more minutes in six uploads, with a poll and a 10 s check after each. The sixth poll
    // reads the list, but the trip in progress is not read again.
    const rest = drive({ n: 660, ms0: 140000, odo0: Math.round(start[start.length - 1].odo_km * 10) });
    for (let k = 0; k < 6; k++) {
      await upload(env, rest.slice(k * 110, (k + 1) * 110), T0 + 250 + 110 * k);
      setNow(T0 + 252 + 110 * k);
      await p.poll();
      p.interval();
      await p.settle();
      assert.match(p.header(), /^Engine running · /);
    }
    assert.equal(full(), 1);
    const before = lists();
    // The engine stops. The next 10 s check reads the list and the fuel figures, and the trip again.
    await upload(env, drive({ n: 10, ms0: 800000, stepMs: 2000, flags: F.QUIET }).map((r) => ({ ...r, rpm: null, speed_kph: null })), T0 + 820);
    setNow(T0 + 825);
    await p.poll();
    p.interval();
    await p.settle();
    assert.match(p.header(), /^Parked · /);
    assert.deepEqual(lists(), [before[0] + 1, before[1] + 1]);
    assert.equal(full(), 2);
    // The details now agree with the trip's row: the same distance, and the end of the drive.
    const row = (await api(env, "api/trips?limit=40")).trips[0];
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    const sub = p.$("t-sub").textContent;
    assert.ok(sub.includes(` to ${time.format(new Date(row.end_ts * 1000))}`) && !sub.includes("in progress"), sub);
    const tile = /Distance<\/div><div class="v">([^<]+)</.exec(p.$("t-stats").innerHTML)[1];
    assert.equal(tile, p.$("t-list").children[0].querySelector(".r").innerHTML.replace("<small>", " ").replace("</small>", ""));
    assert.ok(parseFloat(tile) > 5, tile);
    // Only once: the next poll and check read nothing more.
    const after = [...lists(), full()];
    setNow(T0 + 885);
    await p.poll();
    p.interval();
    await p.settle();
    assert.deepEqual([...lists(), full()], after);

    // The poll brings the stop, then the tab goes to the background before the 10 s check. The
    // hidden page asks for nothing. Back in view the header is the same as at the last check,
    // and the check still reads the list and the fuel figures.
    const env2 = makeEnv();
    await upload(env2, drive({ n: 120 }), T0 + 140);
    setNow(T0 + 145);
    const q = openPage(env2);
    await q.settle();
    q.interval();
    await upload(env2, drive({ n: 10, ms0: 142000, stepMs: 2000, flags: F.QUIET }).map((r) => ({ ...r, rpm: null, speed_kph: null })), T0 + 180);
    setNow(T0 + 185);
    await q.poll();
    assert.match(q.header(), /^Parked · /);
    q.visible(false);
    const asked = q.net.log.length;
    q.interval();
    await q.settle();
    assert.equal(q.net.log.length, asked, "a hidden page asked for something");
    q.visible(true);
    await q.settle();
    const was = [q.requests("api/trips"), q.requests("api/economy")];
    q.interval();
    await q.settle();
    assert.deepEqual([q.requests("api/trips"), q.requests("api/economy")], [was[0] + 1, was[1] + 1]);

    // A page paused by 15 idle minutes asks for nothing either, though by then the drive counts as cut off.
    const env3 = makeEnv();
    await upload(env3, drive({ n: 120 }), T0 + 140);
    setNow(T0 + 145);
    const s = openPage(env3);
    await s.settle();
    s.interval();
    setNow(T0 + 1050);
    await s.poll();
    assert.equal(s.header(), "Paused · tap to resume");
    const idle = s.net.log.length;
    s.interval();
    await s.settle();
    assert.equal(s.net.log.length, idle, "a paused page asked for something");

    // No answers while the drive ends: nothing is tried during the outage, and the first check
    // after the server answers again reads the list and the fuel figures.
    const env4 = makeEnv();
    await upload(env4, drive({ n: 120 }), T0 + 140);
    setNow(T0 + 145);
    const r = openPage(env4);
    await r.settle();
    r.interval();
    r.net.reject = () => true;
    await r.poll();
    // Ten minutes after the last reading the drive counts as cut off: parked, offline mid-drive.
    setNow(T0 + 800);
    const tried = r.net.log.length;
    r.interval();
    await r.settle();
    assert.match(r.header(), /^No connection to the server/);
    assert.equal(r.net.log.length, tried, "the lists were asked for during the outage");
    r.net.reject = null;
    await r.poll();
    assert.match(r.header(), /^Parked · offline mid-drive/);
    const then = [r.requests("api/trips"), r.requests("api/economy")];
    r.interval();
    await r.settle();
    assert.deepEqual([r.requests("api/trips"), r.requests("api/economy")], [then[0] + 1, then[1] + 1]);
    assert.deepEqual([...p.errors, ...q.errors, ...s.errors, ...r.errors], []);
  });

  check("history: every preset and metric button draws, and 7 days asks from local midnight 6 days back", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    const p = openPage(env, { hash: "history" });
    await p.settle();
    const drawn = () => /^(<svg |<div class="empty">No readings in this period<)/.test(p.$("h-chart").innerHTML);
    const now = T0 + 8000;
    // Today and the 6 whole days before it, like get_history, counted from the pinned clock.
    const n = new Date(now * 1000);
    const week = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 6).getTime() / 1000;
    for (const b of p.groups["#h-presets button[data-p]"]) {
      const before = p.net.log.length;
      b.onclick();
      await p.settle();
      const asked = p.net.log.slice(before).filter((path) => path.startsWith("api/history?"));
      assert.equal(asked.length, 1, `preset ${b.dataset.p}`);
      if (b.dataset.p === "7d") assert.equal(asked[0], `api/history?from=${week}&to=${now}`);
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

  check("history: a day is a calendar day across a clock change, and a range over 366 days says it was cut", async () => {
    const env = makeEnv();
    // Monday 00:30, after the night the clocks went forward in the car's zone. Yesterday was 23 hours.
    const mon = new Date(2027, 2, 15, 0, 30).getTime() / 1000;
    const sun = new Date(2027, 2, 14).getTime() / 1000;
    setNow(mon);
    const p = openPage(env, { hash: "history/yesterday" });
    await p.settle();
    assert.deepEqual(p.net.log.filter((path) => path.startsWith("api/history?")), [`api/history?from=${sun}&to=${sun + 23 * 3600 - 1}`]);
    // The date fields show local wall time, also for a moment just after the change.
    assert.deepEqual([p.$("h-from").value, p.$("h-to").value], ["2027-03-14T00:00", "2027-03-14T23:59"]);
    const three = new Date(2027, 2, 14, 3, 0).getTime() / 1000;
    p.location.hash = `history/${three}-${three + 3600}`;
    await p.settle();
    assert.equal(p.$("h-from").value, "2027-03-14T03:00");
    assert.equal(wall(three), "2027-03-14T03:00");

    // Two years. The server answers the newest 366 days, and the label and the fields say so. This
    // database is empty, so the label says that too.
    const q = openPage(env, { hash: `history/${mon - 730 * 86400}-${mon}` });
    await q.settle();
    assert.match(q.$("h-label").textContent, / · only the last 366 days of this range are shown · no logger data yet$/);
    assert.deepEqual([q.$("h-from").value, q.$("h-to").value], [wall(mon - 366 * 86400), wall(mon)]);

    // A trip at noon on that Sunday. Today is empty so far, and the button opens the trip's
    // whole day, which is 23 hours long.
    const dst = makeEnv();
    const noon = new Date(2027, 2, 14, 12, 0).getTime() / 1000;
    await upload(dst, drive({ n: 60, base: noon }), noon + 100);
    setNow(mon);
    const r = openPage(dst, { hash: "history/today" });
    await r.settle();
    assert.equal(r.$("h-none").hidden, false);
    r.$("h-none-day").onclick();
    await r.settle();
    assert.equal(r.location.hash, `#history/${sun}-${sun + 23 * 3600 - 1}`);
    assert.deepEqual([...p.errors, ...q.errors, ...r.errors], []);
  });

  check("a page older than the deployed one says so, and reloads when it comes back from the background and the server answers", async () => {
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
    const stalePage = html.replace(`const PAGE_ID = "${id}";`, () => 'const PAGE_ID = "old";');
    const old = openPage(env, { page: stalePage });
    await old.settle();
    // The car state and its age stay. The notice comes after them, and the button is what reloads.
    assert.equal(old.header(), "Parked · updated 1.0 h ago · new version");
    assert.equal(old.$("reload").hidden, false);
    // Back from the background it reloads, but only once the server has answered.
    old.visible(false);
    old.visible(true);
    assert.equal(old.reloads(), 0);
    await old.settle();
    assert.equal(old.reloads(), 1);
    // Only on the return: the next poll does not reload again.
    await old.poll();
    assert.equal(old.reloads(), 1);
    old.$("reload").onclick();
    assert.equal(old.reloads(), 2);

    // Offline on the return: no reload, which would put the browser's error page in place of the
    // last data. The page says what is wrong, and reloads with the first answer after that.
    const away = openPage(env, { page: stalePage });
    await away.settle();
    away.visible(false);
    away.net.reject = () => true;
    away.visible(true);
    await away.settle();
    assert.equal(away.reloads(), 0);
    assert.match(away.header(), /^No connection to the server/);
    away.net.reject = null;
    await away.poll();
    assert.equal(away.reloads(), 1);

    // A deploy rolling back or out: on the return the first answer comes from a Worker that still
    // serves this page. That is no reason to reload, and the next chance is the next return.
    const roll = openPage(env, { page: stalePage });
    await roll.settle();
    roll.visible(false);
    roll.net.answer = (path, res) => { const h = new Headers(res.headers); h.set("X-Page", "old"); return new Response(res.body, { status: res.status, headers: h }); };
    roll.visible(true);
    await roll.settle();
    assert.equal(roll.reloads(), 0);
    assert.equal(roll.header(), "Parked · updated 1.0 h ago");
    roll.net.answer = null;
    await roll.poll();
    assert.equal(roll.reloads(), 0);
    assert.equal(roll.header(), "Parked · updated 1.0 h ago · new version");
    assert.deepEqual([...cur.errors, ...old.errors, ...away.errors, ...roll.errors], []);
  });

  check("a draw that throws during a poll leaves the next poll set, and the error is still seen", async () => {
    const env = makeEnv();
    await threeTrips(env, 126800);
    const [from, to] = ["d.stats.hour || {}", "d.stats.hourly.x || {}"];
    assert.ok(html.includes(from), "the page changed, so this no longer applies");
    const p = openPage(env, { hash: "logs", page: html.replace(from, () => to) });
    await p.settle();
    await sleep(0);
    // The errors are taken out as they are counted, so the poll has to bring its own.
    assert.ok(p.errors.splice(0).length + stray.splice(0).length > 0, "no error for the broken Logs view at open");
    await p.poll();
    await sleep(0);
    assert.equal(p.polls().length, 1, "the poll after the error is set");
    assert.ok(p.errors.splice(0).length + stray.splice(0).length > 0, "no error for the broken Logs view in the poll");
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
      assert.ok(p.errors.splice(0).length + stray.splice(0).length > 0, `no error for: ${name}`);
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
      // However a check ends, no page it opened is left with two polls on the way, or with an
      // error caught from one of its timers. A check that expects errors takes them out.
      for (const p of opened) {
        const ms = p.polls().map((t) => t.ms);
        assert.ok(ms.length <= 1, `a page of this check ended with ${ms.length} poll timers (${ms})`);
        const errs = p.errors.map((e) => String((e && e.stack) || e));
        assert.deepEqual(errs, [], `a page of this check ended with errors:\n${errs.join("\n")}`);
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

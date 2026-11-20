// The Worker's fetch handler. In front of ingest: the token check, and above all that a
// failure reaches the logger as an error status. The logger deletes its copy on any 2xx.
// In front of the dashboard and the connector: the secret paths, which are their only lock,
// and the headers of the page.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { encodeRecord } from "../scripts/lib/record-encode.mjs";
import worker from "../src/index";
import { makeEnv, one, rows } from "./helpers/d1.mjs";
import { drive, encodeAll, restoreNow, setNow, sid, T0 } from "./helpers/drive.mjs";

// Workers have crypto.subtle.timingSafeEqual, Node does not.
if (!crypto.subtle.timingSafeEqual) crypto.subtle.timingSafeEqual = (a, b) => timingSafeEqual(a, b);

afterEach(restoreNow);

const upload = (env, body, token = env.DEVICE_TOKEN) => worker.fetch(new Request("https://logger.test/ingest", {
  method: "POST",
  headers: token == null ? {} : { Authorization: `Bearer ${token}` },
  body,
}), env);
const count = (env, table) => one(env, `SELECT COUNT(*) AS n FROM ${table}`).n;

test("/ingest needs the device token", async () => {
  setNow(T0 + 100);
  const env = makeEnv();
  const body = encodeAll(drive({ n: 3 }));
  assert.equal((await upload(env, body, null)).status, 401);
  assert.equal(env.DEVICE_TOKEN.length, "test-device-tokeX".length);
  assert.equal((await upload(env, body, "test-device-tokeX")).status, 401, "same length, one character off");
  assert.equal((await upload(env, body, env.DEVICE_TOKEN + "x")).status, 401);
  assert.equal((await upload({ ...env, DEVICE_TOKEN: "" }, body, "")).status, 401, "an unset token never matches");
  assert.equal(env.DB.statements, 0);

  const ok = await upload(env, body);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, records: 3, rejected: 0 });
  assert.equal(count(env, "samples"), 3);

  // Only POST is an upload.
  assert.equal((await worker.fetch(new Request("https://logger.test/ingest"), env)).status, 404);
});

test("a failed write answers 503, never 2xx, and is logged", async (t) => {
  setNow(T0 + 100);
  const logged = t.mock.method(console, "error", () => {});
  const body = encodeAll(drive({ n: 3 }));

  // The batch fails inside the database.
  const env = makeEnv();
  env.DB.sqlite.exec(`CREATE TRIGGER boom BEFORE INSERT ON ingests BEGIN SELECT RAISE(ABORT, 'out of quota'); END`);
  let res = await upload(env, body);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: "ingest failed" });
  assert.equal(count(env, "samples"), 0, "nothing of the failed upload is kept");
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0].arguments[1]), /out of quota/);

  // A read fails before the batch.
  const noReads = makeEnv();
  noReads.DB.prepare = () => { throw new Error("D1 is unreachable"); };
  res = await upload(noReads, body);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: "ingest failed" });
  assert.equal(logged.mock.callCount(), 2);

  // Once the database is back the same upload is stored in full.
  env.DB.sqlite.exec(`DROP TRIGGER boom`);
  res = await upload(env, body);
  assert.equal(res.status, 200);
  assert.equal(count(env, "samples"), 3);
  assert.equal(one(env, "SELECT n FROM trips").n, 3);
});

test("413 and 422 come through the Worker as they are", async (t) => {
  setNow(T0 + 100);
  t.mock.method(console, "warn", () => {});
  const env = makeEnv();
  const big = await upload(env, new Uint8Array(65537));
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { ok: false, error: "too large" });

  const v2 = await upload(env, encodeRecord({ ...drive({ n: 1 })[0], version: 2 }));
  assert.equal(v2.status, 422);
  assert.deepEqual(await v2.json(), { ok: false, error: "unknown record version", unknown: 1 });
  assert.equal(env.DB.statements, 0);
});

test("a crash in the MCP route answers 500 with a JSON-RPC internal error", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const env = makeEnv();
  assert.equal((await worker.fetch(new Request("https://logger.test/mcp/not-the-secret", { method: "POST", body: "{}" }), env)).status, 404);

  // A request that blows up as soon as the handler looks at it.
  const broken = {
    url: `https://logger.test/mcp/${env.MCP_SECRET}`,
    headers: new Headers(),
    get method() { throw new Error("broken request"); },
  };
  const res = await worker.fetch(broken, env);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
  assert.equal(logged.mock.callCount(), 1);
});

test("a failed dashboard request names a used-up daily limit only for D1's two limit errors, any other error as it is", async (t) => {
  setNow(T0 + 100);
  const logged = t.mock.method(console, "error", () => {});
  const same = (text) => [text, text];
  const cases = [
    // The two documented texts, with and without D1's prefix.
    ["D1_ERROR: Your account has exceeded D1's free tier daily row read limit.", "Database read limit reached for today. It resets at midnight UTC."],
    ["Your account has exceeded D1's free tier daily row write limit.", "Database write limit reached for today. It resets at midnight UTC."],
    // A short outage, a timeout and two mistakes in a query are not a used-up day.
    same("D1 DB is overloaded. Too many requests queued."),
    same("D1 DB storage operation exceeded timeout which caused object to be reset."),
    same("D1_ERROR: too many SQL variables"),
    same("D1_ERROR: no such column: odo_start: SQLITE_ERROR"),
  ];
  for (const [text, want] of cases) {
    const env = makeEnv();
    env.DB.prepare = () => { throw new Error(text); };
    const res = await worker.fetch(new Request("https://logger.test/dash/test-dash-secret/api/status"), env);
    assert.equal(res.status, 503, text);
    assert.deepEqual(await res.json(), { error: want }, text);
    // Caught inside handleDash, so the answer still says what it read and which page is deployed.
    assert.equal(res.headers.get("X-Rows-Read"), "0", text);
    assert.match(res.headers.get("X-Page") ?? "", /^[0-9a-f]{8}$/, text);
  }
  assert.equal(logged.mock.callCount(), cases.length);
  // An error before handleDash's own catch reaches the one in index.ts, with the same texts.
  for (const [text, want] of cases) {
    const broken = {
      url: "https://logger.test/dash/test-dash-secret/api/status",
      headers: new Headers(),
      get method() { throw new Error(text); },
    };
    const res = await worker.fetch(broken, makeEnv());
    assert.equal(res.status, 503, text);
    assert.equal(res.headers.get("Cache-Control"), "no-store", text);
    assert.deepEqual(await res.json(), { error: want }, text);
  }
});

test("the dashboard and the connector open only under their secret paths, and the page keeps its headers", async () => {
  setNow(T0 + 100);
  const env = makeEnv();
  const send = (path, e = env, method = "GET", body) => worker.fetch(new Request(`https://logger.test${path}`, { method, body }), e);
  const notFound = async (res, what) => {
    assert.equal(res.status, 404, what);
    assert.equal(await res.text(), "not found", what);
  };
  // A wrong secret, one character off at the same length or one too long, looks like any
  // unknown path, also with a method the dashboard refuses.
  assert.equal(env.DASH_SECRET.length, "test-dash-secreX".length);
  for (const path of ["/dash/", "/dash/not-the-secret/", "/dash/not-the-secret/api/status", "/dash/test-dash-secreX/", "/dash/test-dash-secretx/api/status"]) {
    await notFound(await send(path), `GET ${path}`);
  }
  await notFound(await send("/dash/not-the-secret/api/status", env, "POST"), "POST with a wrong secret");
  // Without a secret set nothing opens, an empty secret path included.
  const unset = { ...env, DASH_SECRET: "", MCP_SECRET: "" };
  for (const path of ["/dash//", "/dash/test-dash-secret/"]) await notFound(await send(path, unset), `${path} with no secret set`);
  // The connector, the same way.
  const list = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const path of ["/mcp/", "/mcp/test-mcp-secreX", "/mcp/test-mcp-secretx"]) await notFound(await send(path, env, "POST", list), `POST ${path}`);
  for (const path of ["/mcp/", "/mcp/test-mcp-secret"]) await notFound(await send(path, unset, "POST", list), `${path} with no secret set`);
  // None of that read the database.
  assert.equal(env.DB.statements, 0);

  // The right secret.
  const bare = await send("/dash/test-dash-secret");
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get("Location"), "https://logger.test/dash/test-dash-secret/");
  const page = await send("/dash/test-dash-secret/");
  assert.equal(page.status, 200);
  // strict-origin, not no-referrer: the map tile servers refuse requests without a referrer.
  for (const [name, value] of [["Content-Type", "text/html; charset=utf-8"], ["Cache-Control", "no-store"],
    ["Referrer-Policy", "strict-origin"], ["X-Robots-Tag", "noindex"], ["X-Content-Type-Options", "nosniff"]]) {
    assert.equal(page.headers.get(name), value, name);
  }
  const html = await page.text();
  assert.ok(html.includes('<meta name="referrer" content="strict-origin">'));
  assert.equal((await send("/dash/test-dash-secret/api/status", env, "POST")).status, 405);
  const api = await send("/dash/test-dash-secret/api/status");
  assert.equal(api.status, 200);
  assert.match(api.headers.get("Content-Type"), /^application\/json/);
  assert.equal(api.headers.get("Cache-Control"), "no-store");
  assert.match(api.headers.get("X-Rows-Read") ?? "", /^\d+$/);
  // The size of the database as D1 gave it with the answer, and the free plan's limit.
  assert.equal(api.headers.get("X-DB-Bytes"), String(env.DB.size()));
  assert.equal(api.headers.get("X-DB-Limit"), "500000000");
  const st = await send("/dash/test-dash-secret/api/storage");
  assert.deepEqual(Object.keys(await st.json()), ["storage", "warn_pct"]);
  // The answer names the page that is served, so an open page can tell when it is out of date.
  assert.match(api.headers.get("X-Page") ?? "", /^[0-9a-f]{8}$/);
  assert.ok(html.includes(`const PAGE_ID = "${api.headers.get("X-Page")}";`));
  const mcp = await send("/mcp/test-mcp-secret", env, "POST", list);
  assert.equal(mcp.status, 200);
  assert.ok((await mcp.json()).result.tools.length > 0);
});

// ------------------------------------------------------------ scripts/fake-device.mjs

// The bundle of this test lives in backend/.wrangler/test-build/<run> (see scripts/run-tests.mjs).
const FAKE_DEVICE = join(import.meta.dirname, "..", "..", "..", "scripts", "fake-device.mjs");

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("the fake device uploads a whole drive through the Worker", async (t) => {
  const env = makeEnv();
  const bodies = [];
  // A throwaway local server in front of the Worker code, alive only for this test.
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    bodies.push(body.length);
    const headers = {};
    for (const h of ["authorization", "content-type", "content-length"]) if (req.headers[h]) headers[h] = req.headers[h];
    const answer = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body }), env);
    res.writeHead(answer.status, { "Content-Type": "application/json" });
    res.end(await answer.text());
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  // New arguments: boot 7 of install 173, firmware build 2, odometer starting at 12000 km.
  const run = await runNode([FAKE_DEVICE, url, env.DEVICE_TOKEN, "7", "0", "173", "2", "12000"]);
  assert.equal(run.code, 0, run.err);
  const lines = run.out.trim().split(/\r?\n/);
  assert.equal(lines.length, 6);
  assert.ok(lines.every((l) => l.startsWith("200 ")), run.out);
  assert.deepEqual(JSON.parse(lines[5].slice(4)), { ok: true, records: 1, rejected: 1 }); // the torn tail

  // 40 records alone, the rest in 300s, then one record with a torn tail. Never more than a segment.
  assert.deepEqual(bodies, [40 * 48, 300 * 48, 300 * 48, 300 * 48, 260 * 48, 68]);
  assert.ok(bodies.every((n) => n <= 341 * 48));

  const trip = one(env, "SELECT * FROM trips");
  assert.equal(trip.boot, sid(7, 173));
  assert.deepEqual([trip.n, trip.engine_n, trip.gps_n, trip.fw, trip.nolink_n, trip.est, trip.odo_start],
    [1200, 1200, 1200, 2, 0, 0, 12000]);
  assert.ok(trip.odo_end > 12010 && trip.odo_end < 12040, `odometer end ${trip.odo_end}`);
  assert.ok(trip.km > 10 && Math.abs(trip.km - (trip.odo_end - trip.odo_start)) < 0.5, `km ${trip.km}`);
  assert.equal(count(env, "samples"), 1200);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM samples WHERE ts_est = 1").n, 0, "the estimated first minute was corrected");
  assert.deepEqual(rows(env, "SELECT records, rejected FROM ingests ORDER BY rowid").map((r) => [r.records, r.rejected]),
    [[40, 0], [300, 0], [300, 0], [300, 0], [260, 0], [1, 1]]);

  // The old command line still means the same: a legacy board without odometer.
  const legacy = await runNode([FAKE_DEVICE, url, env.DEVICE_TOKEN, "8"]);
  assert.equal(legacy.code, 0, legacy.err);
  assert.deepEqual(one(env, "SELECT n, fw, odo_start, odo_end FROM trips WHERE boot = 8"), { n: 1200, fw: 0, odo_start: null, odo_end: null });
  assert.equal(bodies.length, 12);
  assert.ok(bodies.every((n) => n <= 341 * 48));
});

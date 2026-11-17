// Unit tests for the pure helpers of scripts/deploy.mjs and scripts/db-backup.mjs.
// Nothing here starts wrangler or touches the network. Files are written to temp folders only.
// The scripts are loaded at run time from the backend folder: next to this file when it runs
// as written, three levels up when scripts/run-tests.mjs runs its bundled copy.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

const backend = [path.join(import.meta.dirname, ".."), path.join(import.meta.dirname, "..", "..", "..")]
  .find((d) => fs.existsSync(path.join(d, "scripts", "deploy.mjs")));
if (!backend) throw new Error("backend folder not found next to the test");
const load = (f) => import(pathToFileURL(path.join(backend, "scripts", f)).href);
const dep = await load("deploy.mjs");
const bak = await load("db-backup.mjs");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "vette-ops-test-"));
const FAKE_ID = "11111111-2222-3333-4444-555555555555";
const realToml = fs.readFileSync(path.join(backend, "wrangler.toml"), "utf8");
const schemaSql = fs.readFileSync(path.join(backend, "schema.sql"), "utf8");

// ---- wiring ----------------------------------------------------------------------------

test("npm run deploy calls deploy.mjs, and the scripts import only what it exports", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(backend, "package.json"), "utf8"));
  assert.equal(pkg.scripts.deploy, "node scripts/deploy.mjs");
  for (const f of ["setup.mjs", "db-backup.mjs"]) {
    const src = fs.readFileSync(path.join(backend, "scripts", f), "utf8");
    const names = src.match(/import \{([^}]+)\} from "\.\/deploy\.mjs"/)?.[1].split(",").map((s) => s.trim());
    assert.ok(names?.length, `${f} imports from deploy.mjs`);
    for (const n of names) assert.ok(n in dep, `${f} imports ${n}`);
  }
  // Importing the two scripts above ran nothing: a run would have exited or printed by now.
  assert.equal(typeof dep.deployWorker, "function");
  assert.equal(typeof bak.dumpDatabase, "function");
});

test("npm run deploy runs the local checks first, and --skip-checks never reaches wrangler", () => {
  assert.deepEqual(dep.deployArgs([]), { skipChecks: false, wranglerArgs: [] });
  assert.deepEqual(dep.deployArgs(["--skip-checks"]), { skipChecks: true, wranglerArgs: [] });
  assert.deepEqual(dep.deployArgs(["--dry-run", "--skip-checks", "--outdir", "dist"]),
    { skipChecks: true, wranglerArgs: ["--dry-run", "--outdir", "dist"] });
  // localChecks() is never called here: it runs the tests, this file among them. The source
  // shows where it runs instead: in the main block before anything remote, and not inside
  // deployWorker(), which setup uses.
  assert.equal(typeof dep.localChecks, "function");
  const src = fs.readFileSync(path.join(backend, "scripts", "deploy.mjs"), "utf8");
  const main = src.slice(src.indexOf("if (path.basename(process.argv[1]"));
  const at = (s) => main.indexOf(s);
  assert.ok(at("localChecks(") > 0, "the main block runs the checks");
  assert.ok(at("localChecks(") < at("syncLocalConfig(") && at("syncLocalConfig(") < at("deployWorker(wranglerArgs)"), "the checks come first");
  const deployFn = src.slice(src.indexOf("export function deployWorker("), src.indexOf("// ---- stored secrets"));
  assert.ok(deployFn.length > 0 && !deployFn.includes("localChecks"), "setup is not gated");
});

// ---- wrangler.local.toml -------------------------------------------------------------

test("config rebuild keeps the id and picks up a new section", () => {
  const dir = tmpDir();
  // The local copy as an older setup left it: no [observability], real id.
  const oldToml = 'name = "vette-telemetry"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "vette"\ndatabase_id = "REPLACE_AFTER_wrangler_d1_create"\n';
  fs.writeFileSync(path.join(dir, "wrangler.local.toml"), dep.renderLocalConfig(oldToml, FAKE_ID));
  fs.writeFileSync(path.join(dir, "wrangler.toml"), realToml);
  assert.match(realToml, /^\[observability\]/m, "the repo config has the section this test is about");

  assert.equal(dep.syncLocalConfig(dir), true);
  const local = fs.readFileSync(path.join(dir, "wrangler.local.toml"), "utf8");
  assert.match(local, /^\[observability\]\nenabled = true/m);
  assert.equal(dep.readDatabaseId(local), FAKE_ID);
  assert.ok(!local.includes("REPLACE_AFTER"));
  // Only the id line differs from wrangler.toml.
  const diff = local.split("\n").filter((l, i) => l !== realToml.split("\n")[i]);
  assert.deepEqual(diff, [`database_id = "${FAKE_ID}"`]);
  // A second run changes nothing.
  assert.equal(dep.syncLocalConfig(dir), false);
  assert.equal(fs.readFileSync(path.join(dir, "wrangler.toml"), "utf8"), realToml, "wrangler.toml itself is never written");
});

test("config rebuild refuses a checkout that was never set up", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "wrangler.toml"), realToml);
  assert.throws(() => dep.syncLocalConfig(dir), /wrangler\.local\.toml not found\. Run npm run setup/);
  assert.ok(!fs.existsSync(path.join(dir, "wrangler.local.toml")), "nothing is created");
  // A copy that still holds the placeholder has no id either.
  fs.writeFileSync(path.join(dir, "wrangler.local.toml"), realToml);
  assert.throws(() => dep.syncLocalConfig(dir), /holds no database id\. Run npm run setup/);
  fs.writeFileSync(path.join(dir, "wrangler.local.toml"), "name = \"x\"\n# database_id = \"abc\"\n");
  assert.throws(() => dep.syncLocalConfig(dir), /holds no database id/);
});

test("renderLocalConfig replaces exactly the id line", () => {
  assert.throws(() => dep.renderLocalConfig("name = \"x\"\n", FAKE_ID), /no database_id line/);
  const out = dep.renderLocalConfig(realToml, FAKE_ID);
  assert.equal(out.split("\n").length, realToml.split("\n").length);
  assert.equal(out.match(/database_id/g).length, 1);
  // A dollar sign in the value is not a replace pattern.
  assert.match(dep.renderLocalConfig(realToml, "a$&b"), /^database_id = "a\$&b"$/m);
});

// ---- d1 execute --json output ----------------------------------------------------------

// The shape wrangler 3.114 prints for: d1 execute --json --command "PRAGMA table_info(trips)".
const pragma = (names) => JSON.stringify([{
  results: names.map((name, cid) => ({ cid, name, type: "INTEGER", notnull: 0, dflt_value: null, pk: cid === 0 ? 1 : 0 })),
  success: true,
  meta: { served_by: "v3-prod", duration: 0.2, changes: 0, last_row_id: 0, changed_db: false, size_after: 1, rows_read: 0, rows_written: 0 },
}], null, 2);
const OLD_TRIPS = ["boot", "start_ts", "end_ts", "last_ms", "track_ms", "n", "gps_n", "engine_n", "km", "maf_g",
  "engine_s", "moving_s", "max_kph", "max_rpm", "max_coolant", "rpm_sum", "rpm_n", "est"];
const NEW_TRIPS = [...OLD_TRIPS, "odo_start", "odo_end", "fw", "nolink_n"];

test("d1Rows reads the real answer shapes", () => {
  assert.deepEqual(dep.d1Rows(pragma(NEW_TRIPS)).map((r) => r.name), NEW_TRIPS);
  // A notice in front of the JSON, CRLF line ends.
  const noisy = `\u26C5\uFE0F wrangler 3.114.17 (update available 4.1.0)\r\n-----\r\n${pragma(OLD_TRIPS).replaceAll("\n", "\r\n")}\r\n`;
  assert.equal(dep.d1Rows(noisy).length, 18);
  // A table that does not exist gives an empty list, not an error.
  assert.deepEqual(dep.d1Rows(pragma([])), []);
  // Errors and noise are not rows.
  assert.equal(dep.d1Rows(JSON.stringify({ error: { text: "boom" } })), null);
  assert.equal(dep.d1Rows("no json here 5"), null);
  assert.equal(dep.d1Rows(""), null);
  assert.equal(dep.d1Rows("[]"), null);
});

test("schema check: database before 0001 stops with the exact command", () => {
  const gaps = dep.schemaGaps(() => dep.d1Rows(pragma(OLD_TRIPS)).map((r) => r.name));
  assert.deepEqual(gaps.map((g) => g.missing), [["odo_start", "odo_end", "fw", "nolink_n"]]);
  const msg = dep.schemaMessage(gaps);
  assert.match(msg, /Nothing was deployed/);
  assert.match(msg, /missing: trips\.odo_start, trips\.odo_end, trips\.fw, trips\.nolink_n/);
  assert.ok(msg.includes("npx wrangler d1 execute vette --remote --config wrangler.local.toml --file=schema-changes/0001-trips-odometer-fw.sql"));
  assert.match(msg, /npm run db:backup/);
  // The file the message names exists, and its header gives the same command.
  const file = fs.readFileSync(path.join(backend, "schema-changes", "0001-trips-odometer-fw.sql"), "utf8");
  assert.ok(file.includes("npx wrangler d1 execute vette --remote --config wrangler.local.toml --file=schema-changes/0001-trips-odometer-fw.sql"));
});

test("schema check: current database passes, other gaps are named", () => {
  assert.equal(dep.schemaMessage(dep.schemaGaps(() => NEW_TRIPS)), null);
  // No table at all.
  const none = dep.schemaMessage(dep.schemaGaps(() => []));
  assert.match(none, /table trips does not exist/);
  assert.match(none, /npm run db:init:remote/);
  assert.ok(!none.includes("--file=schema-changes"));
  // Half a schema change: the file cannot be run again.
  const half = dep.schemaMessage(dep.schemaGaps(() => [...OLD_TRIPS, "odo_start", "odo_end"]));
  assert.match(half, /missing: trips\.fw, trips\.nolink_n/);
  assert.match(half, /Only part of schema-changes\/0001-trips-odometer-fw\.sql/);
  assert.ok(!half.includes("Run once"));
});

test("REQUIRED_COLUMNS matches schema.sql and is easy to extend", () => {
  // Every required column exists in a database made from schema.sql.
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql);
  const columnsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  assert.deepEqual(dep.schemaGaps(columnsOf), []);
  assert.deepEqual(dep.REQUIRED_COLUMNS[0].columns, ["odo_start", "odo_end", "fw", "nolink_n"]);
  for (const r of dep.REQUIRED_COLUMNS) assert.ok(fs.existsSync(path.join(backend, r.file)), r.file);
  // A second entry is checked the same way.
  const more = [...dep.REQUIRED_COLUMNS, { table: "samples", columns: ["new_col"], file: "schema-changes/0002-x.sql" }];
  const gaps = dep.schemaGaps(columnsOf, more);
  assert.deepEqual(gaps.map((g) => [g.table, g.missing]), [["samples", ["new_col"]]]);
  assert.match(dep.schemaMessage(gaps), /--file=schema-changes\/0002-x\.sql/);
});

// ---- failure text ----------------------------------------------------------------------

const ACCOUNT = "0123456789abcdef0123456789abcdef";
test("failureReason keeps the cause and drops ids, links and paths", () => {
  // wrangler d1 export on a login without the D1 scope.
  const stderr = [
    "",
    `\u2718 [ERROR] A request to the Cloudflare API (/accounts/${ACCOUNT}/d1/database/${FAKE_ID}/export) failed.`,
    "",
    "  Authentication error [code: 10000]",
    "",
    "  If you think this is a bug, please open an issue at: https://github.com/cloudflare/workers-sdk/issues/new/choose",
    "",
    "\uD83E\uDEB5  Logs were written to \"C:\\Users\\someone\\AppData\\Roaming\\xdg.config\\.wrangler\\logs\\wrangler.log\"",
  ].join("\n");
  const stdout = `\uD83C\uDF00 Executing on remote database vette (${FAKE_ID}):\n`;
  const text = dep.failureReason(stdout, stderr);
  assert.match(text, /Authentication error \[code: 10000\]/);
  for (const secret of [ACCOUNT, FAKE_ID, "https://", "someone"]) assert.ok(!text.includes(secret), secret);

  // The same failure from d1 execute --json.
  const json = JSON.stringify({ error: {
    text: `A request to the Cloudflare API (/accounts/${ACCOUNT}/d1/database/${FAKE_ID}/query) failed.`,
    notes: [{ text: "Authentication error [code: 10000]" }], kind: "error", name: "APIError", code: 10000, accountTag: ACCOUNT,
  } }, null, 2);
  const text2 = dep.failureReason(json, "");
  assert.match(text2, /Authentication error \[code: 10000\]/);
  for (const secret of [ACCOUNT, FAKE_ID]) assert.ok(!text2.includes(secret), secret);
  assert.equal(dep.failureReason("", ""), "wrangler gave no reason");
});

test("hideIds masks ids and keeps the Worker URL", () => {
  const out = `- D1 Databases:\n  - DB: vette (${FAKE_ID})\nUploaded vette-telemetry\n  https://vette-telemetry.example.workers.dev\nCurrent Version ID: ${FAKE_ID}\naccount ${ACCOUNT}`;
  const shown = dep.hideIds(out);
  assert.ok(!shown.includes(FAKE_ID) && !shown.includes(ACCOUNT));
  assert.match(shown, /https:\/\/vette-telemetry\.example\.workers\.dev/);
  assert.match(shown, /DB: vette \(<id>\)/);
  // An email is masked. A package version with an @ is not an email.
  assert.equal(dep.hideIds("associated with the email some.one+x@mail.example.com."), "associated with the email <email>.");
  assert.equal(dep.hideIds("npm i -D wrangler@4.1.0"), "npm i -D wrangler@4.1.0");
});

// What wrangler 3.114 prints when a command fails on the login: the error goes to stderr, then
// whoami prints the email and the account table to stdout.
const EMAIL = "someone@example.com";
const authFailure = {
  stdout: [
    `🌀 Executing on remote database vette (${FAKE_ID}):`,
    "",
    "Getting User settings...",
    `👋 You are logged in with an OAuth Token, associated with the email ${EMAIL}.`,
    "┌───┬───┐",
    "│ Account Name │ Account ID │",
    `│ ${EMAIL}'s Account │ ${ACCOUNT} │`,
    "🔓 Token Permissions: If scopes are missing, you may need to logout and re-login.",
    "- d1 (write)",
  ].join("\n"),
  stderr: [
    "",
    `✘ [ERROR] A request to the Cloudflare API (/accounts/${ACCOUNT}/d1/database/${FAKE_ID}/query) failed.`,
    "",
    "  Authentication error [code: 10000]",
  ].join("\n"),
};

test("a failed wrangler call shows the cause without email or ids", () => {
  const text = dep.failureReason(authFailure.stdout, authFailure.stderr);
  assert.match(text, /Authentication error \[code: 10000\]/);
  for (const secret of [EMAIL, ACCOUNT, FAKE_ID, "Account Name"]) assert.ok(!text.includes(secret), secret);
  // The full output, as deploy shows it after a failed wrangler deploy.
  const full = dep.hideIds(`${authFailure.stdout}\n${authFailure.stderr}`);
  for (const secret of [EMAIL, ACCOUNT, FAKE_ID]) assert.ok(!full.includes(secret), secret);
});

test("setup never prints raw wrangler output", () => {
  // setup.mjs runs on import, so its source is checked instead.
  const src = fs.readFileSync(path.join(backend, "scripts", "setup.mjs"), "utf8");
  const wr = src.slice(src.indexOf("function wr("), src.indexOf("function findDb("));
  assert.match(wr, /console\.error\(failureReason\(r\.stdout/);
  const findDb = src.slice(src.indexOf("function findDb("), src.indexOf("// ---- local file steps"));
  assert.match(findDb, /fail\("could not read the D1 list"\)/);
  assert.ok(!/\$\{stdout\}/.test(findDb), "the D1 list is not printed");
  // Anything of wrangler's that setup prints goes through failureReason or hideIds.
  for (const m of src.matchAll(/console\.(?:log|error)\(([^)]*\b(?:out|stdout|stderr|deployOut)\b[^)]*)\)/g)) {
    assert.match(m[1], /^(failureReason|hideIds)\(/, m[0]);
  }
});

// ---- stored secrets ----------------------------------------------------------------------

test("storedSecretsVerdict", () => {
  const never = () => { throw new Error("secret list must not be asked here"); };
  const v = (o) => dep.storedSecretsVerdict({ workerHasIt: never, ...o });
  // Normal re-run on the first machine.
  assert.equal(v({ newSecrets: false, created: 0, live: true }), "store");
  // Rotation: one key deleted, the others still match.
  assert.equal(v({ newSecrets: false, created: 1, live: true }), "store");
  // --new-secrets with nothing to rotate.
  assert.equal(v({ newSecrets: true, created: 0, live: true }), "nothing-new");
  // --new-secrets with a key deleted does its job.
  assert.equal(v({ newSecrets: true, created: 1, live: true }), "store");
  // A deploy.json the live Worker refuses: stop, unless the Worker has no secrets yet.
  assert.equal(dep.storedSecretsVerdict({ newSecrets: false, created: 0, live: false, workerHasIt: () => true }), "mismatch");
  assert.equal(dep.storedSecretsVerdict({ newSecrets: false, created: 2, live: false, workerHasIt: () => true }), "mismatch");
  assert.equal(dep.storedSecretsVerdict({ newSecrets: false, created: 0, live: false, workerHasIt: () => false }), "store");
  // The override.
  assert.equal(v({ newSecrets: true, created: 0, live: false }), "store");
});

// ---- backup ------------------------------------------------------------------------------

test("paging and cost", () => {
  // Count scan plus one read per row: the pages skip nothing.
  assert.equal(bak.rowsRead(0), 0);
  assert.equal(bak.rowsRead(250), 500);
  // About 37 hours of driving (140,000 readings) used to pass the budget. Now 360 hours fit.
  assert.ok(bak.rowsRead(140_000) < bak.READ_BUDGET / 5);
  assert.ok(bak.rowsRead(360 * 4140) < bak.READ_BUDGET);
  // The budget leaves the Worker most of the 5,000,000 rows read of a D1 Free day.
  assert.ok(bak.READ_BUDGET <= 3_000_000);

  // Each page starts after the key of the last row read. Key order is the index order.
  assert.equal(bak.pageSql("samples", ["boot", "ms"], null, 100), "SELECT * FROM samples ORDER BY boot, ms LIMIT 100");
  assert.equal(bak.pageSql("samples", ["boot", "ms"], [12, 19000], 50), "SELECT * FROM samples WHERE (boot, ms) > (12, 19000) ORDER BY boot, ms LIMIT 50");
  assert.equal(bak.pageSql("boots", ["boot"], [12], 10), "SELECT * FROM boots WHERE boot > 12 ORDER BY boot LIMIT 10");
  // A table without a primary key goes by rowid, which is selected along with the row.
  assert.equal(bak.pageSql("ingests", [], null, 100), "SELECT rowid AS _rid, * FROM ingests ORDER BY rowid LIMIT 100");
  assert.equal(bak.pageSql("ingests", [], [7], 100), "SELECT rowid AS _rid, * FROM ingests WHERE rowid > 7 ORDER BY rowid LIMIT 100");
  // Key values go into the text of the query, so only numbers and quoted text are allowed.
  assert.equal(bak.sqlValue(-122.5), "-122.5");
  assert.equal(bak.sqlValue("it's"), "'it''s'");
  for (const v of [null, undefined, NaN, Infinity, {}, true]) assert.throws(() => bak.sqlValue(v), /key value/);
  assert.deepEqual(bak.keyColumns([{ name: "t", pk: 1 }, { name: "x", pk: 0 }, { name: "boot", pk: 2 }]), ["t", "boot"]);
  assert.deepEqual(bak.keyColumns([{ name: "a", pk: 0 }]), []);
  assert.throws(() => bak.keyColumns([{ name: "a b", pk: 1 }]));
});

test("planDump skips SQLite's and Cloudflare's tables and orders the schema", () => {
  const plan = bak.planDump([
    { type: "index", name: "samples_ts", tbl_name: "samples", sql: "CREATE INDEX samples_ts ON samples(ts)" },
    { type: "table", name: "_cf_KV", tbl_name: "_cf_KV", sql: "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID" },
    { type: "table", name: "samples", tbl_name: "samples", sql: "CREATE TABLE samples (boot INTEGER)" },
    { type: "table", name: "sqlite_sequence", tbl_name: "sqlite_sequence", sql: "CREATE TABLE sqlite_sequence(name,seq)" },
    { type: "index", name: "sqlite_autoindex_boots_1", tbl_name: "boots", sql: null },
    { type: "table", name: "boots", tbl_name: "boots", sql: "CREATE TABLE boots (boot INTEGER PRIMARY KEY)" },
  ]);
  assert.deepEqual(plan.tables, ["samples", "boots"]);
  assert.equal(plan.schema, "CREATE TABLE samples (boot INTEGER);\nCREATE TABLE boots (boot INTEGER PRIMARY KEY);\nCREATE INDEX samples_ts ON samples(ts);\n");
  assert.throws(() => bak.planDump([{ type: "table", name: "bad name", tbl_name: "bad name", sql: "CREATE TABLE \"bad name\" (a)" }]));
});

// A database made from the real schema.sql, with a _cf_KV table like D1 has.
function sampleDb(samples = 23) {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql);
  db.exec("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID");
  const ins = db.prepare("INSERT INTO samples (boot, ms, ts, ts_est, lat, lon, flags) VALUES (?, ?, ?, 0, 37.8199, -122.4783, 1)");
  // Inserted out of key order on purpose.
  for (let i = samples - 1; i >= 0; i--) ins.run(i % 2 ? 12 : 11337740, i * 1000, 1794436923 + i);
  db.exec("INSERT INTO boots VALUES (12, 1794436000); INSERT INTO latest VALUES (1, '{}');");
  db.exec("INSERT INTO ingests VALUES (1, 48, 1, 0), (2, 96, 2, 0), (3, 0, 0, 0);");
  db.exec("INSERT INTO trips (boot, n) VALUES (12, 5); INSERT INTO track VALUES (12, 0, 1, 37.8199, -122.4783, NULL);");
  return db;
}
const all = (db, sql) => db.prepare(sql).all().map((r) => ({ ...r }));

test("dumpDatabase writes every table, in pages, and nothing else", () => {
  const db = sampleDb();
  const folder = path.join(tmpDir(), "vette-test");
  const asked = [], logged = [];
  const done = bak.dumpDatabase((sql) => { asked.push(sql); return all(db, sql); }, folder, { size: 10, log: (l) => logged.push(l) });

  assert.deepEqual(done.map((t) => t.table), ["samples", "boots", "latest", "ingests", "trips", "minutes", "track"]);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["boots.json", "ingests.json", "latest.json", "minutes.json", "samples.json", "schema.sql", "track.json", "trips.json"]);
  for (const { table, rows } of done) {
    const saved = JSON.parse(fs.readFileSync(path.join(folder, `${table}.json`), "utf8"));
    assert.equal(saved.length, rows);
    const key = bak.keyColumns(all(db, `PRAGMA table_info(${table})`));
    assert.deepEqual(saved, all(db, `SELECT * FROM ${table} ORDER BY ${key.join(", ") || "rowid"}`), table);
  }
  assert.equal(done[0].rows, 23);
  // 23 rows in pages of 10: three queries, each after the last key of the one before, the last one short.
  assert.deepEqual(asked.filter((s) => s.startsWith("SELECT * FROM samples")), [
    "SELECT * FROM samples ORDER BY boot, ms LIMIT 10",
    "SELECT * FROM samples WHERE (boot, ms) > (12, 19000) ORDER BY boot, ms LIMIT 10",
    "SELECT * FROM samples WHERE (boot, ms) > (11337740, 16000) ORDER BY boot, ms LIMIT 3",
  ]);
  // An empty table costs no page query.
  assert.ok(!asked.some((s) => s.startsWith("SELECT * FROM minutes")));
  assert.equal(fs.readFileSync(path.join(folder, "minutes.json"), "utf8"), "[]\n");
  // Only read-only statements, and never Cloudflare's own table.
  for (const s of asked) assert.match(s, /^(SELECT|PRAGMA table_info\()/);
  assert.ok(!asked.some((s) => /_cf_|sqlite_sequence/.test(s)));
  // Only names and counts are reported.
  assert.deepEqual(logged, ["  samples: 23 rows", "  boots: 1 rows", "  latest: 1 rows", "  ingests: 3 rows", "  trips: 1 rows", "  minutes: 0 rows", "  track: 1 rows"]);
  assert.ok(!logged.join("").includes("37.8"));

  // schema.sql rebuilds the tables and indexes.
  const copy = new DatabaseSync(":memory:");
  copy.exec(fs.readFileSync(path.join(folder, "schema.sql"), "utf8"));
  const names = (d) => d.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(names(copy), names(db));
});

test("dumpDatabase: readings that arrive at the end do not disturb it", () => {
  const db = sampleDb();
  const folder = path.join(tmpDir(), "vette-test");
  let n = 0;
  const done = bak.dumpDatabase((sql) => {
    // An upload lands after the first page of samples was read. Newer session, so it sorts last.
    if (sql.startsWith("SELECT * FROM samples") && n++ === 1) {
      db.exec("INSERT INTO samples (boot, ms, ts, ts_est, flags) VALUES (11337741, 0, 1794437000, 0, 1)");
    }
    return all(db, sql);
  }, folder, { size: 10 });
  assert.equal(done[0].rows, 23);
  const saved = JSON.parse(fs.readFileSync(path.join(folder, "samples.json"), "utf8"));
  assert.ok(!saved.some((r) => r.boot === 11337741), "the late reading is left for the next backup");
  assert.equal(new Set(saved.map((r) => `${r.boot}/${r.ms}`)).size, 23);
});

// With offset paging this insert pushed a row into the next page, which was read twice, so
// the backup had to stop. Paging by key does not see the new row and keeps every counted one.
test("dumpDatabase: a row inserted ahead of the page being read neither repeats nor drops a row", () => {
  const db = sampleDb();
  const before = all(db, "SELECT * FROM samples ORDER BY boot, ms");
  const folder = path.join(tmpDir(), "vette-test");
  let n = 0;
  const done = bak.dumpDatabase((sql) => {
    // Session 5 sorts before every stored row.
    if (sql.startsWith("SELECT * FROM samples") && n++ === 1) {
      db.exec("INSERT INTO samples (boot, ms, ts, ts_est, flags) VALUES (5, 0, 1794437000, 0, 1)");
    }
    return all(db, sql);
  }, folder, { size: 10 });
  assert.equal(done[0].rows, 23);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, "samples.json"), "utf8")), before);
});

test("dumpDatabase reads each page as a key range, also without a primary key", () => {
  const db = sampleDb();
  const folder = path.join(tmpDir(), "vette-test");
  const asked = [];
  // Pages of 2, so every table that has rows needs a second page.
  bak.dumpDatabase((sql) => { asked.push(sql); return all(db, sql); }, folder, { size: 2 });
  const ingests = JSON.parse(fs.readFileSync(path.join(folder, "ingests.json"), "utf8"));
  assert.deepEqual(ingests, all(db, "SELECT * FROM ingests ORDER BY rowid"), "the rowid is not written");
  assert.ok(asked.includes("SELECT rowid AS _rid, * FROM ingests WHERE rowid > 2 ORDER BY rowid LIMIT 1"));
  // SQLite walks the primary key from the last key on. It never sorts and never scans from the start.
  const pages = asked.filter((s) => s.startsWith("SELECT ") && / LIMIT \d+$/.test(s));
  assert.ok(pages.filter((s) => s.includes(" WHERE ")).length >= 2);
  for (const s of pages) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${s}`).all().map((r) => r.detail).join(" | ");
    assert.ok(!/TEMP B-TREE/.test(plan), `${s}: ${plan}`);
    if (s.includes(" WHERE ")) assert.match(plan, /^SEARCH \w+ USING (INTEGER )?PRIMARY KEY/, s);
  }
});

test("dumpDatabase backs up 140,000 readings, which offset paging refused", () => {
  const db = sampleDb(0);
  const ins = db.prepare("INSERT INTO samples (boot, ms, ts, ts_est, flags) VALUES (?, ?, ?, 0, 1)");
  db.exec("BEGIN");
  for (let i = 0; i < 140_000; i++) ins.run(12 + Math.floor(i / 20_000), (i % 20_000) * 1000, 1794436923 + i);
  db.exec("COMMIT");
  const folder = path.join(tmpDir(), "vette-test");
  let queries = 0;
  const done = bak.dumpDatabase((sql) => { queries++; return all(db, sql); }, folder);
  assert.equal(done[0].rows, 140_000);
  // 7 counts, 7 PRAGMAs, the table list, 28 pages of samples and one page each for 5 small tables.
  assert.equal(queries, 1 + 7 + 7 + 28 + 5);
  const saved = JSON.parse(fs.readFileSync(path.join(folder, "samples.json"), "utf8"));
  assert.equal(saved.length, 140_000);
  assert.deepEqual(saved.at(-1), all(db, "SELECT * FROM samples ORDER BY boot DESC, ms DESC LIMIT 1")[0]);
  assert.equal(new Set(saved.map((r) => `${r.boot}/${r.ms}`)).size, 140_000);
});

test("dumpDatabase: a deleted row is caught", () => {
  const db = sampleDb();
  let n = 0;
  assert.throws(() => bak.dumpDatabase((sql) => {
    if (sql.startsWith("SELECT * FROM samples") && n++ === 2) db.exec("DELETE FROM samples WHERE boot = 11337740 AND ms >= 20000");
    return all(db, sql);
  }, path.join(tmpDir(), "vette-test"), { size: 10 }), /23 rows counted, 21 read/);
});

test("dumpDatabase stops before reading when the cost is too high", () => {
  const db = sampleDb();
  const folder = path.join(tmpDir(), "vette-test");
  const asked = [];
  assert.throws(() => bak.dumpDatabase((sql) => { asked.push(sql); return all(db, sql); }, folder, { size: 10, budget: 50 }), /rows read/);
  assert.ok(!fs.existsSync(folder), "no folder that could pass for a backup");
  assert.ok(!asked.some((s) => s.startsWith("SELECT * FROM")));
});

test("dumpDatabase passes a failed query on", () => {
  assert.throws(() => bak.dumpDatabase(() => { throw new Error("Authentication error [code: 10000]"); }, path.join(tmpDir(), "x")), /10000/);
});

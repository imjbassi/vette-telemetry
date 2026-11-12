// Deploys the Worker:   npm run deploy
//
//   1. rebuilds wrangler.local.toml from wrangler.toml and keeps the database id it holds, so
//      every edit of wrangler.toml reaches the Worker
//   2. checks that the remote database has every column this code needs (REQUIRED_COLUMNS).
//      A missing schema change stops the deploy and prints the command to run.
//   3. wrangler deploy --config wrangler.local.toml
//
// Needs a logged-in wrangler and a checkout that npm run setup has run on. Arguments are
// handed to wrangler deploy. The database id is never printed.
//
// setup.mjs and db-backup.mjs import their config, wrangler and schema helpers from here.
// Importing this file runs nothing.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG = "wrangler.local.toml";
export const DB = "vette";
// Where a query runs. Tests pass a local database instead.
const REMOTE = ["--remote", "--config", CONFIG];

// Columns the Worker reads or writes that schema.sql cannot add, because it never alters a
// table that already exists. One entry per file in schema-changes/. Add to this list with
// every new file.
export const REQUIRED_COLUMNS = [
  { table: "trips", columns: ["odo_start", "odo_end", "fw", "nolink_n"], file: "schema-changes/0001-trips-odometer-fw.sql" },
];

// ---- wrangler.local.toml -----------------------------------------------------------

const ID_LINE = /^database_id\s*=.*$/m;

// wrangler.toml with a real database id in place of the placeholder.
export function renderLocalConfig(toml, databaseId) {
  if (!ID_LINE.test(toml)) throw new Error("wrangler.toml has no database_id line");
  return toml.replace(ID_LINE, () => `database_id = "${databaseId}"`);
}

// The database_id value of a config text, or null when there is none.
export function readDatabaseId(toml) {
  return toml.match(/^database_id\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

// Rebuilds wrangler.local.toml in `dir` from wrangler.toml with the id the old copy holds.
// Returns true when the file changed.
export function syncLocalConfig(dir = backend) {
  const toml = fs.readFileSync(path.join(dir, "wrangler.toml"), "utf8");
  const file = path.join(dir, CONFIG);
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const id = old === null ? null : readDatabaseId(old);
  // The placeholder of wrangler.toml is not an id.
  if (!id || id === readDatabaseId(toml)) {
    throw new Error(`${CONFIG} ${old === null ? "not found" : "holds no database id"}. Run npm run setup on this machine first.`);
  }
  const next = renderLocalConfig(toml, id);
  if (next !== old) fs.writeFileSync(file, next);
  return next !== old;
}

// ---- wrangler ----------------------------------------------------------------------

// Runs the wrangler that npm installed, through node itself. No shell is involved, so an
// argument with spaces or brackets (a SQL command) arrives as written on every OS.
// The output is captured, because wrangler prints the database id and download links.
export function wrangler(args, cwd = backend) {
  const bin = path.join(cwd, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!fs.existsSync(bin)) throw new Error("wrangler is not installed. Run npm install in backend/ first.");
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 ** 3,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  const stdout = r.stdout ?? "", stderr = r.stderr ?? "";
  return { ok: r.status === 0, status: r.status, stdout, stderr, out: `${stdout}${stderr}` };
}

// Account ids, database ids, version ids and email addresses replaced by a marker. After an
// authentication error wrangler prints the login email and the account table.
export function hideIds(text) {
  return text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{32}\b/gi, "<id>")
    // The domain must end in letters, so a version like wrangler@4.1.0 stays.
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b/gi, "<email>");
}

// JSON that wrangler printed, also when a notice stands in front of it. Null when there is none.
function parseJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* try the part that looks like JSON */ }
  const at = t.search(/^[[{]/m);
  if (at < 0) return null;
  try { return JSON.parse(t.slice(at)); } catch { return null; }
}

// Why a wrangler call failed, safe to print: no ids, no links, no local paths.
export function failureReason(stdout, stderr = "") {
  // With --json the error is an object: { error: { text, notes: [{ text }] } }.
  const e = parseJson(stdout)?.error;
  const text = e
    ? [e.text, ...(Array.isArray(e.notes) ? e.notes.map((n) => n?.text) : [])].filter(Boolean).join("\n")
    : `${stdout}\n${stderr}`;
  const lines = hideIds(text).split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /[a-z]/i.test(l) && !/https?:\/\//i.test(l) && !/logs were written/i.test(l));
  const at = lines.findIndex((l) => /error|failed/i.test(l));
  return (at < 0 ? lines.slice(-3) : lines.slice(at, at + 3)).join("\n") || "wrangler gave no reason";
}

// The rows of a `wrangler d1 execute --json` answer: [ { results: [...], success, meta } ].
// Null when the text is not such an answer.
export function d1Rows(stdout) {
  const v = parseJson(stdout);
  const results = Array.isArray(v) ? v.at(-1)?.results : null;
  return Array.isArray(results) ? results : null;
}

// One query on the database, the remote one unless `target` says otherwise. Returns the rows.
export function d1Query(sql, target = REMOTE, cwd = backend) {
  const r = wrangler(["d1", "execute", DB, ...target, "--json", "--command", sql], cwd);
  const rows = r.ok ? d1Rows(r.stdout) : null;
  if (!rows) throw new Error(`query failed (${sql.slice(0, 60)}):\n${failureReason(r.stdout, r.stderr)}`);
  return rows;
}

// ---- schema check ------------------------------------------------------------------

// What is missing. `columnsOf(table)` gives the column names of a table, empty when the
// table does not exist. Returns [{ table, file, missing: [names], noTable, partial }].
export function schemaGaps(columnsOf, required = REQUIRED_COLUMNS) {
  const gaps = [];
  for (const { table, columns, file } of required) {
    const have = columnsOf(table);
    const missing = columns.filter((c) => !have.includes(c));
    if (missing.length) gaps.push({ table, file, missing, noTable: have.length === 0, partial: missing.length < columns.length && have.length > 0 });
  }
  return gaps;
}

// The text for the operator, or null when nothing is missing.
export function schemaMessage(gaps) {
  if (!gaps.length) return null;
  const lines = ["the remote database does not have what this code needs. Nothing was deployed."];
  for (const g of gaps) {
    if (g.noTable) {
      lines.push(`  table ${g.table} does not exist. Load the schema:  npm run db:init:remote`);
      continue;
    }
    lines.push(`  missing: ${g.missing.map((c) => `${g.table}.${c}`).join(", ")}`);
    lines.push(g.partial
      ? `  Only part of ${g.file} is in place. Run its remaining statements by hand.`
      : `  Run once:  npx wrangler d1 execute ${DB} --remote --config ${CONFIG} --file=${g.file}`);
  }
  lines.push("Take a backup first (npm run db:backup). Then run this again.");
  lines.push("Until the columns exist the new Worker would answer 503 on every upload.");
  return lines.join("\n");
}

// Throws with the full message when the database lacks a required column.
export function checkSchema(target = REMOTE, cwd = backend) {
  const columnsOf = (table) => d1Query(`PRAGMA table_info(${table})`, target, cwd).map((r) => r.name);
  const message = schemaMessage(schemaGaps(columnsOf));
  if (message) throw new Error(message);
}

// ---- deploy ------------------------------------------------------------------------

// Schema check, then wrangler deploy. Returns wrangler's output (setup reads the Worker URL
// from it). Throws when the check or the deploy fails.
export function deployWorker(extraArgs = []) {
  checkSchema();
  const r = wrangler(["deploy", "--config", CONFIG, ...extraArgs]);
  if (!r.ok) throw new Error(`wrangler deploy exited with ${r.status}:\n${hideIds(r.out).trim()}`);
  return r.out;
}

// ---- stored secrets (setup.mjs) ----------------------------------------------------

// What setup does with secrets that deploy.json held before the run, after it tried one of
// them on the live Worker. Lives here so it can be tested without running setup.
//   created      how many secrets this run generated
//   live         the live Worker accepted the stored secret
//   workerHasIt  () => the Worker already has a secret of that name. Asked only when needed.
// "store": go on. "mismatch": the file belongs to another Worker or is out of date.
// "nothing-new": --new-secrets was given and has nothing to do.
export function storedSecretsVerdict({ newSecrets, created, live, workerHasIt }) {
  if (live) return newSecrets && !created ? "nothing-new" : "store";
  // --new-secrets is the documented way to replace what is live.
  if (newSecrets) return "store";
  // A Worker without secrets is a first setup that stopped early. Nothing can be replaced.
  return workerHasIt() ? "mismatch" : "store";
}

// Only when started as a script. The name test keeps an import from ever deploying.
if (path.basename(process.argv[1] ?? "") === "deploy.mjs") {
  try {
    console.log(syncLocalConfig() ? `${CONFIG} rebuilt from wrangler.toml` : `${CONFIG} is up to date`);
    console.log("checking the remote database, then deploying the Worker");
    console.log(hideIds(deployWorker(process.argv.slice(2))).trim());
    console.log("\nDone.");
  } catch (e) {
    console.error(`\nDEPLOY FAILED: ${e.message}`);
    process.exit(1);
  }
}

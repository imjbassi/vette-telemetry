// Backs up the remote D1 database (schema and data) into backend/.secrets/backups/:
//   vette-<UTC timestamp>.sql   one file, from "wrangler d1 export"
//   vette-<UTC timestamp>/      when the export is refused: schema.sql and one <table>.json
//                               per table, read through plain SELECT queries
// A Cloudflare login can lack the permission for the export and still be allowed to run
// queries (the export answers "Authentication error [code: 10000]"). The folder form covers
// that case. Running "npx wrangler login" again brings the single-file export back.
//
// The backup holds every reading and every position, so it stays inside the gitignored
// .secrets folder. Only table names and row counts are printed: no data, no link, no id.
//
//   npm run db:backup
//
// Requires a logged-in wrangler and wrangler.local.toml (written by npm run setup).
// Importing this file runs nothing.
import fs from "node:fs";
import path from "node:path";
import { backend, CONFIG, d1Query, DB, failureReason, wrangler } from "./deploy.mjs";

// Rows per query of the folder form. Each query starts its own wrangler, so larger pages are faster.
export const PAGE_ROWS = 5000;
// D1 Free allows 5,000,000 rows read per day for everything. This leaves 2,000,000 for the
// Worker on the day of a backup. At about 2 rows read per stored row (see rowsRead) it is
// reached after about 360 hours of driving at one reading per second.
export const READ_BUDGET = 3_000_000;
// The rowid of a table without a primary key, selected under this name and removed before writing.
const RID = "_rid";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const internal = (name) => /^(sqlite_|_cf_)/i.test(name ?? "");

// From the rows of sqlite_master: the tables to read and the text of schema.sql.
// SQLite's and Cloudflare's own tables are left out. D1 refuses to read them.
export function planDump(master) {
  const own = master.filter((m) => m.sql && !internal(m.name) && !internal(m.tbl_name));
  const tables = own.filter((m) => m.type === "table");
  for (const t of tables) {
    // The name goes into a query as it is.
    if (!NAME.test(t.name)) throw new Error("a table name has characters this script does not handle");
  }
  // Tables first, so an index never comes before its table.
  const schema = [...tables, ...own.filter((m) => m.type !== "table")].map((m) => `${m.sql};\n`).join("");
  return { tables: tables.map((t) => t.name), schema };
}

// Rows D1 counts for one table: the count reads every row once, and the pages read every row
// once more. Each page starts at the key where the last one ended, so it skips nothing.
export function rowsRead(count) {
  return 2 * count;
}

// Primary key columns in key order, from the rows of PRAGMA table_info. Empty without a key.
export function keyColumns(info) {
  const key = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (key.some((c) => !NAME.test(c))) throw new Error("a column name has characters this script does not handle");
  return key;
}

// A key value written into a query. wrangler d1 execute takes no parameters.
export function sqlValue(v) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  throw new Error("a key value has a type this script does not handle");
}

// One page in key order, starting after the key values in `after` (null for the first page).
// A table without a primary key is read in rowid order, with the rowid as RID.
export function pageSql(table, key, after, limit) {
  const cols = key.length ? key : ["rowid"];
  let where = "";
  if (after) {
    const vals = after.map(sqlValue);
    where = cols.length > 1 ? ` WHERE (${cols.join(", ")}) > (${vals.join(", ")})` : ` WHERE ${cols[0]} > ${vals[0]}`;
  }
  return `SELECT ${key.length ? "*" : `rowid AS ${RID}, *`} FROM ${table}${where} ORDER BY ${cols.join(", ")} LIMIT ${limit}`;
}

// Reads every table through `query(sql)`, which returns rows, and writes the folder.
// Returns [{ table, rows }]. Throws before or while writing when anything does not add up.
export function dumpDatabase(query, folder, { size = PAGE_ROWS, budget = READ_BUDGET, log = () => {} } = {}) {
  const { tables, schema } = planDump(query("SELECT type, name, tbl_name, sql FROM sqlite_master"));
  if (!tables.length) throw new Error("the database has no tables");
  const counts = tables.map((t) => Number(query(`SELECT COUNT(*) AS n FROM ${t}`)[0]?.n));
  if (counts.some((n) => !Number.isInteger(n) || n < 0)) throw new Error("could not count the rows of a table");
  const cost = counts.reduce((sum, n) => sum + rowsRead(n), 0);
  if (cost > budget) {
    throw new Error(`reading the tables page by page would cost about ${cost} rows read, and D1 Free allows 5,000,000 a day for everything.`);
  }

  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "schema.sql"), schema);
  return tables.map((table, i) => {
    const key = keyColumns(query(`PRAGMA table_info(${table})`));
    const count = counts[i];
    // Written page by page, so memory holds one page however large the table grows.
    const fd = fs.openSync(path.join(folder, `${table}.json`), "w");
    let read = 0;
    try {
      let after = null;
      while (read < count) {
        // The limit never reaches past the counted rows, so readings that arrive at the end
        // while the backup runs are left for the next one.
        const limit = Math.min(size, count - read);
        const page = query(pageSql(table, key, after, limit));
        if (!page.length) break;
        const last = page.at(-1);
        after = key.length ? key.map((c) => last[c]) : [last[RID]];
        if (!key.length) for (const r of page) delete r[RID];
        // One row per line.
        fs.writeSync(fd, `${read ? ",\n" : "[\n"}${page.map((r) => JSON.stringify(r)).join(",\n")}`);
        read += page.length;
        if (page.length < limit) break;
      }
      fs.writeSync(fd, read ? "\n]\n" : "[]\n");
    } finally {
      fs.closeSync(fd);
    }
    // Fewer rows: something was deleted meanwhile. Each page starts after the last key read,
    // so no row is read twice, and a row inserted behind that key is not read at all.
    // A row inserted between stored rows further on would push the last counted row out
    // unseen. Uploads add rows at the end, and the board is off while the car is parked.
    if (read !== count) {
      throw new Error(`table ${table} changed while it was read (${count} rows counted, ${read} read). Run this again while the car is parked.`);
    }
    log(`  ${table}: ${read} rows`);
    return { table, rows: read };
  });
}

// ---- main --------------------------------------------------------------------------

function main() {
  const fail = (m) => { console.error(`\nBACKUP FAILED: ${m}`); process.exit(1); };
  const shown = (f) => `backend/${path.relative(backend, f).replaceAll("\\", "/")}`;

  if (!fs.existsSync(path.join(backend, CONFIG))) {
    fail(`${CONFIG} not found. It holds the real database id. Run npm run setup on this machine first.`);
  }

  const dir = path.join(backend, ".secrets", "backups");
  fs.mkdirSync(dir, { recursive: true });
  // 2026-11-11T20:30:00.000Z becomes 20261111T203000Z. No colons, so the name works on Windows.
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  const file = path.join(dir, `vette-${stamp}.sql`);
  const folder = path.join(dir, `vette-${stamp}`);
  if (fs.existsSync(file) || fs.existsSync(folder)) fail(`${shown(folder)} already exists. Run this again in a moment.`);

  console.log(`exporting remote database "${DB}" to ${shown(file)}`);
  // Wrangler's own output is not shown. On success it holds a download link for the whole
  // database, and on failure the account id and the database id.
  let exp;
  try { exp = wrangler(["d1", "export", DB, "--remote", "--config", CONFIG, `--output=${path.relative(backend, file)}`]); }
  catch (e) { fail(e.message); }
  const size = exp.ok && fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size > 0) {
    console.log(`\nDone. ${(size / 1024).toFixed(1)} KB in ${shown(file)}`);
    console.log("This file holds location history. Keep it out of shared folders.");
    return;
  }
  // A failed export can leave an empty or partial file that would pass for a backup.
  fs.rmSync(file, { force: true });
  const reason = exp.ok ? "wrangler reported success but wrote no data" : failureReason(exp.stdout, exp.stderr);
  console.log(`the single-file export did not work:\n${reason}`);
  // The case this fallback exists for: the login may run queries but not export.
  const noPermission = /authentication error|code: 10000/i.test(reason);

  console.log(`\nreading the tables one by one instead (read-only queries) into ${shown(folder)}/`);
  let done;
  try {
    done = dumpDatabase((sql) => d1Query(sql), folder, { log: console.log });
  } catch (e) {
    // Half a folder would pass for a backup.
    fs.rmSync(folder, { recursive: true, force: true });
    fail([
      e.message,
      "If this is an authentication error too: npx wrangler whoami must list d1 (write).",
      "Run npx wrangler login again, or give CLOUDFLARE_API_TOKEN the permission Account > D1 > Edit.",
      "No backup was made. Do not run a schema change or a repair now.",
    ].join("\n"));
  }
  const total = done.reduce((sum, t) => sum + t.rows, 0);
  console.log(`\nDone. ${done.length} tables, ${total} rows in ${shown(folder)}/ (schema.sql and one .json per table)`);
  console.log("This folder holds location history. Keep it out of shared folders.");
  console.log(noPermission
    ? 'This login may not export. Running "npx wrangler login" again would restore the single-file export.'
    : "The single-file export failed for another reason. Try npm run db:backup again later to get one.");
}

// Only when started as a script. The name test keeps an import from ever touching the database.
if (path.basename(process.argv[1] ?? "") === "db-backup.mjs") main();

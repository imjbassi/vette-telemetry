// A small look-alike of the Cloudflare D1 binding on top of node:sqlite, for tests.
// It covers what the Worker uses: prepare, bind, first, all, run, raw, batch and exec, with
// results and meta shaped like D1. Where D1 is stricter than SQLite this is strict too, so a
// statement that passes here should not fail on the real thing for one of these reasons:
//   - at most 100 bound values per statement
//   - the number of bound values must match the placeholders
//   - undefined, NaN and plain objects cannot be bound
// Like D1, numbers are bound as REAL (node:sqlite does the same), and a batch is one
// transaction: if any statement fails, nothing of the batch is kept.
// Not the same as D1: meta.rows_read is the number of rows returned, not rows scanned, and
// meta.rows_written is the number of changed rows without index writes. meta.size_after is
// the size of the in-memory database (pages times page size), or sizeAfter when a test sets it
// to stand for a database of that size.
import { DatabaseSync } from "node:sqlite";
import schemaSql from "../../schema.sql";

const MAX_BOUND = 100;

// Highest placeholder index in a statement, by SQLite's numbering rules. Text in quotes and
// comments is skipped. Only "?" and "?NNN" are supported, the Worker uses nothing else.
function countPlaceholders(sql) {
  const bare = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  let max = 0;
  for (const m of bare.matchAll(/\?(\d*)/g)) max = Math.max(max, m[1] ? Number(m[1]) : max + 1);
  return max;
}

function checkValue(v, i) {
  if (v === null || typeof v === "string") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`D1_TYPE_ERROR: value ${i + 1} is ${v}, which cannot be stored`);
    return v;
  }
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return v;
  throw new Error(`D1_TYPE_ERROR: Type '${typeof v}' not supported for value ${i + 1} ('${String(v)}')`);
}

const plain = (row) => ({ ...row });

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values) {
    if (values.length > MAX_BOUND) throw new Error(`D1_ERROR: too many SQL variables (${values.length}, limit ${MAX_BOUND})`);
    return new Statement(this.db, this.sql, values.map(checkValue));
  }

  // Runs the statement now. Shared by the single-statement methods and by batch().
  _exec() {
    // The Worker binds one prepared statement hundreds of times per upload, so compile it once.
    let c = this.db.compiled.get(this.sql);
    if (!c) {
      const st = this.db.sqlite.prepare(this.sql);
      c = { st, want: countPlaceholders(this.sql), reads: st.columns().length > 0 };
      this.db.compiled.set(this.sql, c);
    }
    if (c.want !== this.params.length) {
      throw new Error(`D1_ERROR: Wrong number of parameter bindings for SQL query (${this.params.length} given, ${c.want} wanted): ${this.sql}`);
    }
    const st = c.st;
    const started = Date.now();
    let results = [];
    let changes = 0;
    let lastRowId = 0;
    if (c.reads) {
      results = st.all(...this.params).map(plain);
    } else {
      const info = st.run(...this.params);
      changes = Number(info.changes);
      lastRowId = Number(info.lastInsertRowid);
    }
    this.db.statements++;
    return {
      success: true,
      results,
      meta: {
        served_by: "node:sqlite test double",
        duration: Date.now() - started,
        changes,
        last_row_id: lastRowId,
        changed_db: changes > 0,
        size_after: this.db.sizeAfter ?? this.db.size(),
        rows_read: results.length,
        rows_written: changes,
      },
    };
  }

  async all() {
    return this._exec();
  }

  async run() {
    return this._exec();
  }

  async first(column) {
    const row = this._exec().results[0];
    if (row === undefined) return null;
    if (column === undefined) return row;
    if (!(column in row)) throw new Error(`D1_ERROR: Column not found (${column})`);
    return row[column];
  }

  async raw() {
    return this._exec().results.map((r) => Object.values(r));
  }
}

export class TestD1 {
  // `sqlite` is the node:sqlite handle, for tests that want to look at tables directly.
  constructor(sqlite) {
    this.sqlite = sqlite;
    this.compiled = new Map();
    this.statements = 0; // statements executed so far, in and out of batches
    this.batches = []; // statement count of every batch() call so far
    this.sizeAfter = null; // bytes to report as meta.size_after in place of the real size
    this.pageCount = sqlite.prepare("PRAGMA page_count");
    this.pageSize = sqlite.prepare("PRAGMA page_size").get().page_size;
  }

  // Bytes the database takes now, as D1 reports it in meta.size_after.
  size() {
    return this.pageCount.get().page_count * this.pageSize;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    this.batches.push(statements.length);
    this.sqlite.exec("BEGIN");
    try {
      const out = statements.map((s) => s._exec());
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }

  async exec(sql) {
    this.sqlite.exec(sql);
    return { count: sql.split(";").filter((s) => s.trim()).length, duration: 0 };
  }
}

// An empty in-memory database with schema.sql applied (or the SQL text passed in).
export function openD1(schema = schemaSql) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  return new TestD1(sqlite);
}

// The Worker's `env` with a fresh database. Pass `schema` for other SQL than schema.sql, and
// any binding to override it: makeEnv({ LOCAL_TZ: "UTC" }).
export function makeEnv({ schema, ...vars } = {}) {
  return {
    DB: openD1(schema),
    DEVICE_TOKEN: "test-device-token",
    MCP_SECRET: "test-mcp-secret",
    DASH_SECRET: "test-dash-secret",
    LOCAL_TZ: "America/Los_Angeles",
    ...vars,
  };
}

// Direct reads for assertions, outside the D1 interface: rows(env, sql, ...params).
export function rows(env, sql, ...params) {
  return env.DB.sqlite.prepare(sql).all(...params).map(plain);
}

export function one(env, sql, ...params) {
  return rows(env, sql, ...params)[0] ?? null;
}

// Runs a SQL file (several statements, comments allowed) the way "wrangler d1 execute --file" would.
export function execFile(env, sqlText) {
  env.DB.sqlite.exec(sqlText);
}

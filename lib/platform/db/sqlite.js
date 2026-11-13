/* Cloudflare D1-compatible database on a local SQLite file, using Node's built-in node:sqlite (Node 22.5+; on 22.5–22.12
   start Node with --experimental-sqlite, e.g. NODE_OPTIONS=--experimental-sqlite). No npm dependency, nothing to compile.

   Interface (what lib/ uses): db.prepare(sql).bind(...).first(col?) / .all() / .run() / .raw(), db.batch([stmts]) (atomic),
   db.exec(sql). Same SQL dialect as D1, because D1 *is* SQLite. */
let sqliteModule = null;
export async function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  try { sqliteModule = await import("node:sqlite"); return sqliteModule; }
  catch (e) {
    const err = new Error(`node:sqlite is not available in Node ${process.versions.node} (needs Node 22.13+, or 22.5+ with NODE_OPTIONS=--experimental-sqlite). Use DB_DRIVER=mysql instead.`);
    err.code = "SQLITE_UNAVAILABLE"; err.cause = e;
    throw err;
  }
}
export async function sqliteAvailable() { try { await loadSqlite(); return true; } catch { return false; } }

function norm(v) {
  if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v;
}
const plain = (r) => (r ? { ...r } : r);
const returnsRows = (sql) => /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);

class Stmt {
  constructor(db, sql, params = []) { this.d1 = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.d1, this.sql, params.map(norm)); }
  _s() { return this.d1._prepare(this.sql); }
  async first(col) { const r = this._s().get(...this.params); if (!r) return null; return col ? r[col] : plain(r); }
  async all() { const rows = this._s().all(...this.params).map(plain); return { success: true, results: rows, meta: { rows_read: rows.length } }; }
  async raw() { return this._s().all(...this.params).map((r) => Object.values(r)); }
  async run() { return this._sync(); }
  _sync() {
    const s = this._s();
    if (returnsRows(this.sql)) { const rows = s.all(...this.params).map(plain); return { success: true, results: rows, meta: { changes: rows.length } }; }
    const r = s.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class SqliteD1 {
  /** @param {import("node:sqlite").DatabaseSync} raw */
  constructor(raw, { file = ":memory:" } = {}) {
    this.db = raw; // the underlying DatabaseSync (tests and tools use it directly)
    this.file = file;
    this.driver = "sqlite";
    this.cache = new Map();
  }
  static async open(file = ":memory:", { busyTimeoutMs = 5000 } = {}) {
    const { DatabaseSync } = await loadSqlite();
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
    if (file !== ":memory:") { raw.exec("PRAGMA journal_mode = WAL"); raw.exec("PRAGMA synchronous = NORMAL"); }
    raw.exec("PRAGMA foreign_keys = ON");
    return new SqliteD1(raw, { file });
  }
  _prepare(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }
  prepare(sql) { return new Stmt(this, sql); }
  /** All statements in one transaction (like D1): everything commits or nothing does. Runs synchronously, so no other
      request in this process can interleave; BEGIN IMMEDIATE takes the write lock up front for other processes. */
  async batch(stmts) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const out = stmts.map((s) => s._sync()); this.db.exec("COMMIT"); return out; }
    catch (e) { try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw e; }
  }
  async exec(sql) { this.db.exec(sql); return { count: 1 }; }
  async close() { this.cache.clear(); this.db.close(); }
}

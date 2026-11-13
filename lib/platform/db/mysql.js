/* Cloudflare D1-compatible database on MySQL / MariaDB (what every cPanel host provides), via the pure-JS `mysql2` driver.
   Each SQLite-dialect statement from the shared code is translated once (./mysql-translate.js) and run with inlined,
   escaped parameters. batch() runs in a real transaction on one connection, like D1. Errors are reworded into SQLite's
   messages ("UNIQUE constraint failed: table.col", "CHECK constraint failed: …") because lib/admin/tx.js and
   lib/admin/audit.js recognise conflicts by those messages. */
import { cachedPlan, render, splitStatements } from "./mysql-translate.js";

const SESSION_SQL_MODE = "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,PIPES_AS_CONCAT,ERROR_FOR_DIVISION_BY_ZERO";
const RETRYABLE = new Set([1213, 1205]); // deadlock, lock wait timeout → the whole transaction was rolled back; safe to retry

/** Parse mysql://user:pass@host:port/db?socket=/path into mysql2 options. */
export function parseMysqlUrl(url) {
  const u = new URL(url);
  if (!/^mysqls?:|^mariadb:/.test(u.protocol)) throw new Error(`DATABASE_URL must start with mysql:// (got ${u.protocol})`);
  const o = { host: u.hostname || "localhost", port: u.port ? Number(u.port) : 3306, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.replace(/^\//, "")) };
  if (u.searchParams.get("socket")) o.socketPath = u.searchParams.get("socket");
  if (u.protocol === "mysqls:" || u.searchParams.get("ssl") === "true") o.ssl = {};
  return o;
}

const plain = (r) => ({ ...r });

class Stmt {
  constructor(db, sql, params = []) { this.d1 = db; this.sql = sql; this.params = params; }
  bind(...params) {
    for (const v of params) if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
    return new Stmt(this.d1, this.sql, params);
  }
  async first(col) { const { results } = await this.all(); const r = results[0]; if (!r) return null; return col ? r[col] : r; }
  async all() { return this.d1._run(this); }
  async run() { return this.d1._run(this); }
  async raw() { const { results } = await this.all(); return results.map((r) => Object.values(r)); }
}

export class MysqlD1 {
  constructor(pool, options = {}) { this.pool = pool; this.driver = "mysql"; this.options = options; this.keyCols = new Map(); }

  static async open(options) {
    let mysql;
    try { mysql = (await import("mysql2/promise")).default; }
    catch (e) { const err = new Error("The mysql2 package is missing — run `npm install` (cPanel: 'Run NPM Install')"); err.cause = e; throw err; }
    const conn = typeof options === "string" ? parseMysqlUrl(options) : { ...options };
    const pool = mysql.createPool({
      ...conn, charset: "utf8mb4", supportBigNumbers: true, bigNumberStrings: false, decimalNumbers: true, dateStrings: true,
      multipleStatements: false, waitForConnections: true, connectionLimit: Number(conn.connectionLimit) || 5, maxIdle: 2, idleTimeout: 60_000,
      enableKeepAlive: true, connectTimeout: 10_000, timezone: "Z"
    });
    pool.pool.on("connection", (c) => { c.query(`SET SESSION sql_mode = '${SESSION_SQL_MODE}', SESSION time_zone = '+00:00'`); });
    const db = new MysqlD1(pool, conn);
    return db;
  }

  prepare(sql) { return new Stmt(this, sql); }

  async _exec(conn, stmt) {
    const p = cachedPlan(stmt.sql);
    const { sql, followup } = render(p, stmt.params);
    let res;
    try { [res] = await conn.query(sql); }
    catch (e) { throw await this._normalize(e, p, conn); }
    if (Array.isArray(res)) return { success: true, results: res.map(plain), meta: { rows_read: res.length, changes: 0 } };
    if (p.guard && res.affectedRows > 0) throw new Error("CHECK constraint failed: tx_guard (ok = 1)");
    const meta = { changes: res.affectedRows, last_row_id: res.insertId, rows_written: res.affectedRows };
    if (followup) {
      const [rows] = await conn.query(followup);
      return { success: true, results: rows.map(plain), meta };
    }
    return { success: true, results: [], meta };
  }

  async _run(stmt) {
    const p = cachedPlan(stmt.sql);
    if (!p.returning) { const conn = this.pool; return this._exec(conn, stmt); }
    return this._tx([stmt]).then((r) => r[0]); // upsert + re-select must see the same row
  }

  async _tx(stmts) {
    for (let attempt = 0; ; attempt++) {
      const conn = await this.pool.getConnection();
      try {
        await conn.query("START TRANSACTION");
        const out = [];
        for (const s of stmts) out.push(await this._exec(conn, s));
        await conn.query("COMMIT");
        return out;
      } catch (e) {
        try { await conn.query("ROLLBACK"); } catch { /* connection may be gone */ }
        if (RETRYABLE.has(e.errno) && attempt < 3) { await new Promise((r) => setTimeout(r, 20 * (attempt + 1) + Math.random() * 30)); continue; }
        throw e;
      } finally { conn.release(); }
    }
  }

  /** All statements in one transaction (like D1.batch). */
  async batch(stmts) { return this._tx(stmts); }

  /** Run a multi-statement script (not transactional, like D1.exec). */
  async exec(script) {
    const conn = await this.pool.getConnection();
    let count = 0;
    try { for (const sql of splitStatements(script)) { await this._exec(conn, new Stmt(this, sql)); count++; } }
    finally { conn.release(); }
    return { count };
  }

  /** Raw MySQL (no translation) — migrations and tools. */
  async rawQuery(sql, values) { const [rows] = await this.pool.query(sql, values); return rows; }

  async _normalize(e, p, conn) {
    if (!e || !e.errno) return e;
    let msg = e.message;
    if (e.errno === 1062) {
      const key = (/for key '(?:[^'.]*\.)?([^']+)'/.exec(e.message) || [])[1] || "PRIMARY";
      const cols = p.table ? await this._keyColumns(conn, p.table, key) : [key];
      msg = `UNIQUE constraint failed: ${cols.map((c) => `${p.table}.${c}`).join(", ")} (${e.message})`;
    } else if (e.errno === 3819 || e.errno === 4025) msg = `CHECK constraint failed: ${p.table || ""} (${e.message})`;
    else if (e.errno === 1451 || e.errno === 1452) msg = `FOREIGN KEY constraint failed (${e.message})`;
    else if (e.errno === 1146) msg = `no such table (${e.message})`;
    if (msg === e.message) return e;
    const out = new Error(msg);
    out.code = e.code; out.errno = e.errno; out.sqlState = e.sqlState; out.cause = e;
    return out;
  }
  async _keyColumns(conn, table, key) {
    const id = `${table}.${key}`;
    if (!this.keyCols.has(id)) {
      try {
        const [rows] = await conn.query("SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? ORDER BY ORDINAL_POSITION", [table, key]);
        this.keyCols.set(id, rows.length ? rows.map((r) => r.c) : [key]);
      } catch { return [key]; }
    }
    return this.keyCols.get(id);
  }

  async close() { await this.pool.end(); }
}

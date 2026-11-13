/* Migration runner for both drivers.
   SQLite: applies migrations/*.sql (the same files Cloudflare D1 uses) and records them in `d1_migrations`, the table
   wrangler uses, so a database exported from D1 keeps its migration state.
   MySQL/MariaDB: applies migrations/mysql/*.sql (hand-translated copies with the same file names). */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "../config.js";

export const MIGRATIONS_DIR = join(APP_ROOT, "migrations");
const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort() : []);

/** Split a MySQL script into statements, honouring `DELIMITER x` lines and `-- @optional` markers. */
export function parseMysqlScript(text) {
  const out = [];
  let delim = ";", buf = [], optional = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const dm = /^DELIMITER\s+(\S+)\s*$/i.exec(t);
    if (dm) { delim = dm[1]; continue; }
    if (!buf.length && /^--\s*@optional\b/i.test(t)) { optional = true; continue; }
    if (!buf.length && (t === "" || t.startsWith("--"))) continue;
    buf.push(line);
    if (t.endsWith(delim)) {
      const sql = buf.join("\n").trim().slice(0, -delim.length).trim();
      if (sql) out.push({ sql, optional });
      buf = []; optional = false;
    }
  }
  const rest = buf.join("\n").trim();
  if (rest) out.push({ sql: rest, optional });
  return out;
}

const TOLERATED = new Map([[1050, "table already exists"], [1060, "column already exists"], [1061, "index already exists"], [1359, "trigger already exists"], [1826, "constraint already exists"]]);

/**
 * Apply pending migrations. @returns {{ applied: string[], skipped: string[], warnings: string[] }}
 * @param {object} db  SqliteD1 or MysqlD1
 */
export async function migrate(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const applied = [], warnings = [];
  if (db.driver === "mysql") {
    await db.rawQuery("CREATE TABLE IF NOT EXISTS d1_migrations (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL UNIQUE, applied_at BIGINT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    // several app processes may start at once: serialise on a named lock
    const conn = await db.pool.getConnection();
    try {
      const [[l]] = await conn.query("SELECT GET_LOCK('tinycomet_migrate', 60) AS ok");
      if (!l || Number(l.ok) !== 1) throw new Error("Could not get the migration lock (another process is migrating?)");
      return await migrateMysql(db, dir, log, applied, warnings);
    } finally { try { await conn.query("SELECT RELEASE_LOCK('tinycomet_migrate')"); } catch { /* ignore */ } conn.release(); }
  }
  return migrateSqlite(db, dir, log, applied, warnings);
}

async function migrateMysql(db, dir, log, applied, warnings) {
  {
    const done = new Set((await db.rawQuery("SELECT name FROM d1_migrations")).map((r) => r.name));
    const files = list(join(dir, "mysql"));
    for (const f of files) {
      if (done.has(f)) continue;
      log(`applying ${f} (mysql)`);
      for (const { sql, optional } of parseMysqlScript(readFileSync(join(dir, "mysql", f), "utf8"))) {
        try { await db.rawQuery(sql); }
        catch (e) {
          if (TOLERATED.has(e.errno)) { warnings.push(`${f}: ${TOLERATED.get(e.errno)} — skipped (${e.message})`); continue; }
          if (optional) { warnings.push(`${f}: optional statement failed — ${e.message}. ${/TRIGGER/i.test(sql) ? "The audit log is still hash-chained, so Audit › Verify detects edits; ask your host for the TRIGGER privilege to also block them." : ""}`); continue; }
          throw new Error(`Migration ${f} failed: ${e.message}\n--- statement ---\n${sql.slice(0, 400)}`);
        }
      }
      await db.rawQuery("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)", [f, Date.now()]);
      applied.push(f);
    }
    return { applied, skipped: files.filter((f) => done.has(f)), warnings };
  }
}

function migrateSqlite(db, dir, log, applied, warnings) {
  const raw = db.db;
  raw.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  const files = list(dir);
  const done = new Set(raw.prepare("SELECT name FROM d1_migrations").all().map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    raw.exec("BEGIN IMMEDIATE"); // takes the write lock; re-check in case another process just applied it
    if (raw.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(f)) { raw.exec("COMMIT"); done.add(f); continue; }
    log(`applying ${f} (sqlite)`);
    try {
      raw.exec(readFileSync(join(dir, f), "utf8"));
      raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
      raw.exec("COMMIT");
    } catch (e) { try { raw.exec("ROLLBACK"); } catch { /* ignore */ } throw new Error(`Migration ${f} failed: ${e.message}`); }
    applied.push(f);
  }
  return { applied, skipped: files.filter((f) => done.has(f)), warnings };
}

/** True when the schema exists (used by the server to give a helpful message instead of crashing). */
export async function schemaReady(db) {
  try { await db.prepare("SELECT 1 FROM site_state LIMIT 1").all(); return true; } catch { return false; }
}

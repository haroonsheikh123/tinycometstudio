/* Pick and open the database driver from configuration.
   DB_DRIVER=sqlite  → SQLite file (SQLITE_FILE, default ~/tinycomet-data/site.db) via node:sqlite (Node 22.5+)
   DB_DRIVER=mysql   → MySQL/MariaDB via mysql2 (DATABASE_URL=mysql://user:pass@host/db, or MYSQL_HOST/USER/PASSWORD/DATABASE)
   DB_DRIVER=auto    → (default) MySQL if a MySQL URL/database is configured, else SQLite if this Node has node:sqlite. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteD1, sqliteAvailable } from "./sqlite.js";

export async function chooseDriver(dbConfig) {
  const d = dbConfig.driver;
  if (d === "sqlite" || d === "mysql") return d;
  if (d !== "auto") throw new Error(`Unknown DB_DRIVER "${d}" — use sqlite or mysql`);
  if (dbConfig.url || dbConfig.mysql.database) return "mysql";
  if (await sqliteAvailable()) return "sqlite";
  throw new Error(`No database configured: this Node (${process.versions.node}) has no built-in SQLite. Create a MySQL database in cPanel and set DB_DRIVER=mysql plus DATABASE_URL (see docs/DEPLOY_CPANEL.md), or pick Node 22.13+.`);
}

/** @returns {Promise<SqliteD1|import("./mysql.js").MysqlD1>} */
export async function openDatabase(dbConfig) {
  const driver = await chooseDriver(dbConfig);
  if (driver === "mysql") {
    const { MysqlD1 } = await import("./mysql.js");
    const m = dbConfig.mysql;
    if (!dbConfig.url && !(m.database && m.user)) throw new Error("DB_DRIVER=mysql needs DATABASE_URL=mysql://user:password@localhost/dbname (or MYSQL_DATABASE + MYSQL_USER + MYSQL_PASSWORD)");
    return MysqlD1.open(dbConfig.url || m);
  }
  if (dbConfig.sqliteFile !== ":memory:") mkdirSync(dirname(dbConfig.sqliteFile), { recursive: true, mode: 0o700 });
  return SqliteD1.open(dbConfig.sqliteFile);
}

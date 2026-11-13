/* SQLite → MySQL translation (lib/platform/db/mysql-translate.js). Pure string tests — they always run.
   The whole suite also runs on a real server with: TEST_DB_DRIVER=mysql MYSQL_URL=mysql://user:pass@host/x npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { translate, splitStatements, literal, mask } from "../lib/platform/db/mysql-translate.js";
import { parseMysqlScript } from "../lib/platform/db/migrate.js";
import { parseMysqlUrl } from "../lib/platform/db/mysql.js";
import { readFileSync } from "node:fs";

const t = (sql, params = []) => translate(sql, params).sql;

test("mysql: upserts → ON DUPLICATE KEY UPDATE / INSERT IGNORE / REPLACE", () => {
  assert.equal(t("INSERT INTO site_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", ["k", "v", 1]),
    "INSERT INTO site_state (`key`, value, updated_at) VALUES ('k', 'v', 1) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)");
  assert.equal(t("INSERT INTO site_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING", ["k", "v", 1]), "INSERT IGNORE INTO site_state (`key`, value, updated_at) VALUES ('k', 'v', 1)");
  assert.equal(t("INSERT OR IGNORE INTO analytics_uniques (day, visitor) VALUES (?, ?)", ["2026-01-01", "ab"]), "INSERT IGNORE INTO analytics_uniques (day, visitor) VALUES ('2026-01-01', 'ab')");
  assert.equal(t("INSERT OR REPLACE INTO idempotency (id, status) VALUES (?, ?)", ["x", 200]), "REPLACE INTO idempotency (id, status) VALUES ('x', 200)");
  assert.match(t("INSERT INTO pages (slug, title) VALUES (?, ?) ON CONFLICT (slug) DO UPDATE SET title = excluded.title, version = pages.version + 1", ["a", "b"]), /ON DUPLICATE KEY UPDATE title = VALUES\(title\), version = pages\.version \+ 1$/);
  // multi-line SQL, as in the analytics collector
  assert.match(t("INSERT INTO analytics_daily (day, count) VALUES (?, 1)\n      ON CONFLICT (day) DO UPDATE SET count = count + 1", ["d"]), /ON DUPLICATE KEY UPDATE count = count \+ 1$/);
});

test("mysql: RETURNING on an upsert becomes a follow-up SELECT by the conflict key", () => {
  const r = translate("INSERT INTO rate_limits (bucket, window, count) VALUES (?, ?, ?) ON CONFLICT (bucket, window) DO UPDATE SET count = count + excluded.count RETURNING count", ["ip:x", 1700000000, 1]);
  assert.equal(r.sql, "INSERT INTO rate_limits (bucket, `window`, count) VALUES ('ip:x', 1700000000, 1) ON DUPLICATE KEY UPDATE count = count + VALUES(count)");
  assert.equal(r.followup, "SELECT count FROM rate_limits WHERE bucket = 'ip:x' AND `window` = 1700000000");
});

test("mysql: casts, integer division, FROM DUAL, case-insensitive LIKE, reserved words", () => {
  assert.equal(t("UPDATE site_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'v'"), "UPDATE site_state SET value = CAST(CAST(value AS SIGNED) + 1 AS CHAR) WHERE `key` = 'v'");
  assert.match(t("SELECT (ts / 60000) * 60000 AS m FROM analytics_events"), /\(ts\s+DIV 60000\) \* 60000/);
  assert.equal(t("INSERT INTO tx_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM games WHERE id = ?)", ["a"]), "INSERT INTO tx_guard (ok) SELECT 0 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM games WHERE id = 'a')");
  assert.equal(t("SELECT 1 FROM games WHERE data LIKE ?", ["%x%"]), "SELECT 1 FROM games WHERE data LIKE '%x%' COLLATE utf8mb4_general_ci");
  assert.equal(t("SELECT seq, before, after FROM audit_log"), "SELECT seq, `before`, after FROM audit_log");
  assert.equal(t('SELECT "key" FROM site_state'), "SELECT `key` FROM site_state");
  assert.equal(translate("INSERT INTO tx_guard (ok) SELECT 0 WHERE 1").sql.includes("FROM DUAL"), true);
});

test("mysql: literals and parameters are escaped, '?' inside strings is never a placeholder", () => {
  assert.equal(t("SELECT 'what?' AS q, ? AS p", ["it's"]), "SELECT 'what?' AS q, 'it\\'s' AS p");
  assert.equal(t("SELECT 'a\\nb'"), "SELECT 'a\\\\nb'", "SQLite has no backslash escapes: keep the bytes");
  assert.equal(literal(null), "NULL");
  assert.equal(literal(true), "1");
  assert.equal(literal(12.5), "12.5");
  assert.equal(literal(new Uint8Array([1, 255])), "X'01ff'");
  assert.equal(literal("x\\y\n'\"\0"), "'x\\\\y\\n\\'\\\"\\0'");
  assert.throws(() => literal(undefined), /D1_TYPE_ERROR/);
  assert.throws(() => t("SELECT ?, ?", [1]), /parameters/);
  assert.throws(() => t("SELECT ?", [1, 2]), /parameters/);
  assert.throws(() => mask("SELECT 'oops"), /Unterminated/);
});

test("mysql: script splitting keeps strings, CASE … END and trigger bodies intact", () => {
  const parts = splitStatements("UPDATE a SET x = CASE WHEN y THEN 1 ELSE 2 END; INSERT INTO t VALUES ('semi;colon', 'it''s');\nCREATE TRIGGER g BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, 'no; way'); END;\n-- comment; here\nSELECT 1");
  assert.equal(parts.length, 4);
  assert.equal(parts[1], "INSERT INTO t VALUES ('semi;colon', 'it''s')");
  assert.match(parts[2], /END$/);
  const seedLike = splitStatements("INSERT OR IGNORE INTO pages (slug, source) VALUES ('p', '# Title; with semicolons\n\n- and ''quotes''');");
  assert.equal(seedLike.length, 1);
  assert.match(t(seedLike[0]), /^INSERT IGNORE INTO pages/);
});

test("mysql: migration files parse (DELIMITER blocks, optional triggers) and mirror the SQLite tables", () => {
  const stmts = parseMysqlScript(readFileSync(new URL("../migrations/mysql/0001_init.sql", import.meta.url), "utf8"));
  const tables = stmts.map((s) => /^CREATE TABLE (\w+)/.exec(s.sql)?.[1]).filter(Boolean).sort();
  const sqlite = [...readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8").matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(tables, sqlite);
  const triggers = stmts.filter((s) => /^CREATE TRIGGER/.test(s.sql));
  assert.equal(triggers.length, 2);
  assert.ok(triggers.every((s) => s.optional));
  assert.match(triggers[1].sql, /END$/);
});

test("mysql: DATABASE_URL parsing", () => {
  assert.deepEqual(parseMysqlUrl("mysql://cp_user:p%40ss@localhost:3307/cp_db"), { host: "localhost", port: 3307, user: "cp_user", password: "p@ss", database: "cp_db" });
  assert.equal(parseMysqlUrl("mysql://u:p@localhost/db?socket=/var/lib/mysql/mysql.sock").socketPath, "/var/lib/mysql/mysql.sock");
  assert.throws(() => parseMysqlUrl("postgres://x@y/z"), /mysql:\/\//);
});

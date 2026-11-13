#!/usr/bin/env node
/* Database backup for the Node host → ~/tinycomet-data/backups/ (keeps the newest BACKUP_KEEP, default 14).
   SQLite: a consistent copy made with VACUUM INTO (safe while the site is running).
   MySQL/MariaDB: a plain .sql dump (CREATE TABLE + INSERTs; restore with phpMyAdmin › Import or `mysql db < file`).
   Media files live in ~/tinycomet-data/media — included in cPanel's own "Backup" (home directory) downloads.
   Usage: npm run backup   ·   cron: 17 3 * * * cd ~/tinycomet-app && <node> tools/backup.mjs */
import { mkdirSync, readdirSync, rmSync, createWriteStream, statSync } from "node:fs";
import { join } from "node:path";
import { openHostDb, say, fail } from "./lib-host.mjs";

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
try {
  const { db, config } = await openHostDb();
  const dir = join(config.dataDir, "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let file;
  if (db.driver === "sqlite") {
    file = join(dir, `site-${stamp}.db`);
    db.db.prepare("VACUUM INTO ?").run(file);
  } else {
    file = join(dir, `site-${stamp}.sql`);
    const out = createWriteStream(file, { mode: 0o600 });
    const w = (s) => new Promise((r) => (out.write(s) ? r() : out.once("drain", r)));
    await w(`-- Tiny Comet Studio MySQL backup ${new Date().toISOString()}\nSET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n`);
    const tables = (await db.rawQuery("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")).map((r) => Object.values(r)[0]);
    for (const t of tables) {
      const [create] = await db.rawQuery(`SHOW CREATE TABLE \`${t}\``);
      await w(`DROP TABLE IF EXISTS \`${t}\`;\n${create["Create Table"]};\n`);
      for (let off = 0; ; off += 500) {
        const rows = await db.rawQuery(`SELECT * FROM \`${t}\` LIMIT 500 OFFSET ${off}`);
        if (!rows.length) break;
        const cols = Object.keys(rows[0]).map((c) => `\`${c}\``).join(", ");
        const vals = rows.map((r) => `(${Object.values(r).map((v) => db.pool.escape(v)).join(", ")})`).join(",\n");
        await w(`INSERT INTO \`${t}\` (${cols}) VALUES\n${vals};\n`);
      }
      await w("\n");
    }
    const triggers = await db.rawQuery("SHOW TRIGGERS");
    for (const tr of triggers) {
      const [c] = await db.rawQuery(`SHOW CREATE TRIGGER \`${tr.Trigger}\``);
      await w(`DELIMITER //\n${c["SQL Original Statement"].replace(/\s+DEFINER=\S+/, "")}//\nDELIMITER ;\n`);
    }
    await w("SET FOREIGN_KEY_CHECKS = 1;\n");
    await new Promise((r) => out.end(r));
  }
  await db.close();
  const keep = Number(process.env.BACKUP_KEEP || 14);
  const all = readdirSync(dir).filter((f) => /^site-\d{8}-\d{6}\.(db|sql)$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, old));
  say(`✔ Backup written: ${file} (${Math.round(statSync(file).size / 1024)} KB) · keeping the newest ${keep}`);
} catch (e) { fail(e); }

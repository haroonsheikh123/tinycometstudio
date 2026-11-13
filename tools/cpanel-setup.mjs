#!/usr/bin/env node
/* One-click first-time setup for cPanel (Setup Node.js App → Run JS script → setup), or `npm run setup` over SSH.
   1. creates the private data folder (default ~/tinycomet-data, outside public_html)
   2. writes ~/tinycomet-data/.env with freshly generated secrets — unless they are already set in the cPanel screen
   3. creates the database tables and imports content/ (never overwrites anything already there)
   4. prints what's left to do (Turnstile keys, cron line for this exact server, /admin/setup)
   Safe to run again: existing secrets and data are kept. */
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { hostConfig, say, fail } from "./lib-host.mjs";
import { parseDotEnv, APP_ROOT } from "../lib/platform/config.js";

const gen = { SIGNING_KEY: () => randomBytes(48).toString("base64url"), ENCRYPTION_KEY: () => randomBytes(32).toString("base64url"), SETUP_TOKEN: () => randomBytes(24).toString("hex") };

try {
  let { config } = hostConfig();
  const dataDir = config.dataDir;
  mkdirSync(join(dataDir, "media"), { recursive: true, mode: 0o700 });
  try { chmodSync(dataDir, 0o700); } catch { /* not ours to change */ }
  say(`Data folder: ${dataDir}`);
  if (dataDir.includes("public_html")) say("  ⚠ This folder is inside public_html — move it (set DATA_DIR) so the database and .env can never be downloaded.");

  const envFile = process.env.ENV_FILE || join(dataDir, ".env");
  const existing = existsSync(envFile) ? parseDotEnv(readFileSync(envFile, "utf8")) : {};
  const add = [];
  let newToken = null;
  for (const [k, make] of Object.entries(gen)) {
    if (process.env[k] || existing[k]) continue;
    const v = make();
    add.push(`${k}=${v}`);
    if (k === "SETUP_TOKEN") newToken = v;
  }
  if (!existsSync(envFile) || add.length) {
    const header = existsSync(envFile) ? "" : `# Tiny Comet Studio — private settings (generated ${new Date().toISOString()}). Keep this file secret.\n# Values set in cPanel's Node.js app screen override these. See .env.example for every option.\n\n`;
    const dbLine = !existing.DB_DRIVER && !process.env.DB_DRIVER ? (process.env.DATABASE_URL || process.env.MYSQL_DATABASE ? "DB_DRIVER=mysql\n" : "") : "";
    writeFileSync(envFile, (existsSync(envFile) ? readFileSync(envFile, "utf8").replace(/\n*$/, "\n") : header) + dbLine + add.join("\n") + (add.length ? "\n" : ""), { mode: 0o600 });
    try { chmodSync(envFile, 0o600); } catch { /* ignore */ }
    say(`✔ ${add.length ? `Generated ${add.map((l) => l.split("=")[0]).join(", ")} in` : "Created"} ${envFile}`);
  } else say(`✔ Secrets already configured (${envFile})`);
  ({ config } = hostConfig());

  // database
  const { openDatabase, chooseDriver } = await import("../lib/platform/db/index.js");
  let driver;
  try { driver = await chooseDriver(config.db); }
  catch (e) { say(`✖ ${e.message}`); process.exit(1); }
  const db = await openDatabase(config.db);
  const { migrate } = await import("../lib/platform/db/migrate.js");
  const r = await migrate(db);
  for (const w of r.warnings) say(`  ⚠ ${w}`);
  say(`✔ Database ready (${driver === "sqlite" ? config.db.sqliteFile : "MySQL/MariaDB"})${r.applied.length ? ` — created tables (${r.applied.join(", ")})` : ""}`);
  const seeded = await db.prepare("SELECT value FROM site_state WHERE key = 'seeded_at'").first();
  if (!seeded) { const { seedDatabase } = await import("../lib/platform/node-server.js"); await seedDatabase(db); say("✔ Imported the site's content (games, news, team, pages)"); }
  else say("✔ Content already imported");
  const owner = await db.prepare("SELECT COUNT(*) AS n FROM users").first();
  await db.close();

  // what's left
  say("\nNext steps:");
  say("  1. Restart the app (Setup Node.js App → Restart) so it picks up the new settings.");
  if (!Number(owner?.n)) say(`  2. Open https://<your-domain>/admin/setup and create the owner account${newToken ? ` with this setup token:\n\n       ${newToken}\n` : " (the SETUP_TOKEN is in " + envFile + ")"}`);
  else say("  2. The owner account exists — sign in at /admin/.");
  const v = config.vars;
  if (!v.TURNSTILE_SECRET) say("  3. Add your Cloudflare Turnstile keys: TURNSTILE_SECRET (env/.env) and the site key in Admin › Settings (free at dash.cloudflare.com → Turnstile).");
  say(`  4. Cron job (cPanel → Cron Jobs, every 5 minutes):\n       cd ${APP_ROOT} && ${process.execPath} tools/tick.mjs >> ${join(dataDir, "tick.log")} 2>&1`);
  if (newToken) say("\n  Keep the setup token private; it only works until the owner account exists.");
} catch (e) { fail(e); }

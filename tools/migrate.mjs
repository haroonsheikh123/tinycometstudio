#!/usr/bin/env node
/* Apply database migrations on the Node host (SQLite file or MySQL/MariaDB — from DB_DRIVER / DATABASE_URL / .env).
   Usage: npm run migrate            (cPanel: Setup Node.js App → Run JS script → migrate)
          node tools/migrate.mjs --seed   also import content/ into an empty database
   Safe to run any number of times. On Cloudflare D1 use: npx wrangler d1 migrations apply tinycomet --remote */
import { openHostDb, say, fail } from "./lib-host.mjs";
import { migrate } from "../lib/platform/db/migrate.js";
import { seedDatabase } from "../lib/platform/node-server.js";

try {
  const { db, where, files } = await openHostDb();
  say(`Database: ${db.driver} (${where})${files.length ? ` · config from ${files.join(", ")}` : ""}`);
  const r = await migrate(db, { log: (m) => say(`  · ${m}`) });
  for (const w of r.warnings) say(`  ⚠ ${w}`);
  say(r.applied.length ? `✔ Applied ${r.applied.length} migration(s): ${r.applied.join(", ")}` : "✔ Already up to date");
  if (process.argv.includes("--seed")) {
    const seeded = await db.prepare("SELECT value FROM site_state WHERE key = 'seeded_at'").first();
    if (seeded) say("✔ Content already imported (seed skipped — it never overwrites admin edits)");
    else { await seedDatabase(db); say("✔ Imported content/ (games, news, team, pages, settings)"); }
  }
  await db.close();
} catch (e) { fail(e); }

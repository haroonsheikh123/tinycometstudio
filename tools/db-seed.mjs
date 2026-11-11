#!/usr/bin/env node
/* Seed D1 from the repo's content/ folder (first-time import).
   Usage:
     node tools/db-seed.mjs --local            # apply migrations + seed the local D1 (wrangler pages dev)
     node tools/db-seed.mjs --remote           # same, on the real D1 database
     node tools/db-seed.mjs --sql > seed.sql   # just print the SQL
   Options: --db <name> (default: tinycomet, the database_name in wrangler.toml)
   It only ADDS rows that don't exist yet (INSERT OR IGNORE), so it never overwrites edits made in the admin.
   To push later changes from files into D1 (audited, with diffs) use: node tools/content-sync.mjs push */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newsFromMarkdown } from "../lib/admin/content.js";
import { parseFrontMatter } from "./render/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

export async function buildSeedSql(root = ROOT, now = Date.now()) {
  const read = (p) => readFile(join(root, p), "utf8");
  const settings = JSON.parse(await read("content/settings.json"));
  const games = JSON.parse(await read("content/games.json"));
  const team = JSON.parse(await read("content/team.json"));
  const newsFiles = (await readdir(join(root, "content/news")).catch(() => [])).filter((f) => f.endsWith(".md")).sort();
  const pageFiles = (await readdir(join(root, "content/pages")).catch(() => [])).filter((f) => f.endsWith(".md")).sort();
  const sql = [];
  const rev = (type, id, data) => sql.push(`INSERT INTO revisions (resource_type, resource_id, version, data, created_at, actor) SELECT ${q(type)}, ${q(id)}, 1, ${q(JSON.stringify(data))}, ${now}, 'seed' WHERE NOT EXISTS (SELECT 1 FROM revisions WHERE resource_type = ${q(type)} AND resource_id = ${q(id)});`);
  sql.push(`INSERT OR IGNORE INTO settings (id, data, version, updated_at, updated_by) VALUES ('site', ${q(JSON.stringify(settings))}, 1, ${now}, 'seed');`);
  rev("settings", "site", settings);
  games.forEach((g, i) => {
    sql.push(`INSERT OR IGNORE INTO games (id, position, title, status, data, version, created_at, updated_at, created_by, updated_by) VALUES (${q(g.id)}, ${i}, ${q(g.title)}, ${q(g.status)}, ${q(JSON.stringify(g))}, 1, ${now}, ${now}, 'seed', 'seed');`);
    rev("game", g.id, g);
  });
  team.forEach((m, i) => {
    sql.push(`INSERT OR IGNORE INTO team (id, position, name, data, version, created_at, updated_at, created_by, updated_by) VALUES (${q(m.id)}, ${i}, ${q(m.name)}, ${q(JSON.stringify(m))}, 1, ${now}, ${now}, 'seed', 'seed');`);
    rev("team_member", m.id, m);
  });
  for (const f of newsFiles) {
    const n = newsFromMarkdown(f, await read(`content/news/${f}`));
    const data = { excerpt: n.excerpt, cover: n.cover, updated: n.updated, placeholder: n.placeholder };
    const pub = n.publish_at ? Date.parse(n.publish_at) : n.status === "published" ? Date.parse(n.date) : null;
    sql.push(`INSERT OR IGNORE INTO news (slug, title, status, publish_at, date, category, game, author, data, body, version, created_at, updated_at, created_by, updated_by) VALUES (${[n.slug, n.title, n.status].map(q).join(", ")}, ${q(pub)}, ${[n.date, n.category, n.game, n.author, JSON.stringify(data), n.body].map(q).join(", ")}, 1, ${now}, ${now}, 'seed', 'seed');`);
    rev("news", n.slug, { ...n, publish_at: pub ? new Date(pub).toISOString() : null });
  }
  for (const f of pageFiles) {
    const slug = f.replace(/\.md$/, "");
    const source = await read(`content/pages/${f}`);
    const title = String(parseFrontMatter(source).data.title || slug);
    sql.push(`INSERT OR IGNORE INTO pages (slug, title, source, version, created_at, updated_at, created_by, updated_by) VALUES (${q(slug)}, ${q(title)}, ${q(source)}, 1, ${now}, ${now}, 'seed', 'seed');`);
    rev("page", slug, { slug, title, source });
  }
  sql.push(`INSERT OR IGNORE INTO site_state (key, value, updated_at) VALUES ('seeded_at', ${q(JSON.stringify(now))}, ${now});`);
  sql.push(`INSERT OR IGNORE INTO site_state (key, value, updated_at) VALUES ('content_version', '1', ${now});`);
  sql.push(`INSERT INTO site_state (key, value, updated_at) VALUES ('next_publish_at', COALESCE((SELECT CAST(MIN(publish_at) AS TEXT) FROM news WHERE status = 'scheduled' AND deleted_at IS NULL), '0'), ${now}) ON CONFLICT (key) DO UPDATE SET value = excluded.value;`);
  return sql.join("\n") + "\n";
}

async function main() {
  const args = process.argv.slice(2);
  const sql = await buildSeedSql();
  if (args.includes("--sql")) { process.stdout.write(sql); return; }
  const where = args.includes("--remote") ? "--remote" : "--local";
  const db = args[args.indexOf("--db") + 1] && args.includes("--db") ? args[args.indexOf("--db") + 1] : "tinycomet";
  const file = join(ROOT, ".wrangler", "seed.sql");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, sql);
  const run = (cmd) => { console.log("$ npx " + cmd.join(" ")); const r = spawnSync("npx", ["--yes", ...cmd], { stdio: "inherit", cwd: ROOT }); if (r.status !== 0) process.exit(r.status || 1); };
  run(["wrangler@4", "d1", "migrations", "apply", db, where]);
  run(["wrangler@4", "d1", "execute", db, where, `--file=${file}`]);
  console.log(`✔ Seeded ${db} (${where.slice(2)}) from content/. Next: open /admin/setup and create the owner with your SETUP_TOKEN.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/* Tiny Comet Studio — static site generator (zero dependencies, Node 18+).

   Reads   content/settings.json, content/games.json, content/team.json,
           content/news/*.md, content/pages/*.md
   Writes  public/index.html, public/<slug>/index.html, public/<slug>/gate/index.html,
           public/news/**, public/press/, public/privacy/, public/404.html,
           public/sitemap.xml, public/robots.txt, public/manifest.webmanifest,
           public/news/feed.xml, lib/games.generated.js

   Usage:  node tools/build.mjs           (build)
           node tools/build.mjs --check   (validate content only, write nothing)

   All HTML comes from the pure render functions in tools/render/ — this file
   only does file I/O. */
import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as R from "./render/index.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public");
const CONTENT = join(ROOT, "content");
const CHECK_ONLY = process.argv.includes("--check");

const readJson = async (p) => JSON.parse(await readFile(join(ROOT, p), "utf8"));
const exists = (p) => stat(p).then(() => true, () => false);
const written = [];
async function out(rel, data) {
  const file = join(OUT, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  written.push(rel);
}

async function main() {
  const settings = await readJson("content/settings.json");
  const games = await readJson("content/games.json");
  const team = await readJson("content/team.json");

  const newsDir = join(CONTENT, "news");
  const files = (await readdir(newsDir).catch(() => [])).filter((f) => f.endsWith(".md")).sort();
  const posts = R.sortPosts(await Promise.all(files.map(async (f) => R.parsePost(f, await readFile(join(newsDir, f), "utf8")))));

  // ---- validate ----
  const errors = [...R.validateSettings(settings), ...R.validateGames(games), ...R.validateTeam(team)];
  const slugs = new Set();
  for (const p of posts) {
    if (!R.SLUG_RE.test(p.slug)) errors.push(`news/${p.slug}: invalid slug`);
    if (slugs.has(p.slug)) errors.push(`news: duplicate slug "${p.slug}"`);
    slugs.add(p.slug);
    if (!/^\d{4}-\d{2}-\d{2}/.test(p.date)) errors.push(`news/${p.slug}: "date" must be YYYY-MM-DD`);
    if (p.game && !games.some((g) => g.id === p.game)) errors.push(`news/${p.slug}: unknown game "${p.game}"`);
    if (p.author && !team.some((m) => m.id === p.author)) errors.push(`news/${p.slug}: unknown author "${p.author}" (use an id from content/team.json)`);
  }
  const warnings = [];
  for (const g of games) {
    if (g.webPlay?.enabled && !(await exists(join(OUT, g.id, "play", "index.html")))) {
      warnings.push(`${g.id}: webPlay is enabled but public/${g.id}/play/index.html does not exist yet`);
    }
  }
  if (errors.length) {
    console.error("✖ Content problems:\n  - " + errors.join("\n  - "));
    process.exit(1);
  }
  warnings.forEach((w) => console.warn("⚠ " + w));
  if (CHECK_ONLY) { console.log(`✔ Content OK — ${games.length} games, ${posts.length} posts, ${team.length} team members.`); return; }

  // ---- cache-busting version from CSS/JS contents ----
  const h = createHash("sha256");
  for (const f of ["css/style.css", "js/main.js", "js/gate.js"]) h.update(await readFile(join(OUT, f)).catch(() => ""));
  const version = h.digest("hex").slice(0, 10);
  const base = { settings, version };

  // ---- remove pages of games/posts that were deleted since the last build ----
  const manifestPath = join(ROOT, "lib", "build-manifest.json");
  const prev = JSON.parse(await readFile(manifestPath, "utf8").catch(() => "{}"));
  for (const id of prev.games || []) {
    if (!games.some((g) => g.id === id)) {
      await rm(join(OUT, id, "index.html"), { force: true });
      await rm(join(OUT, id, "gate"), { recursive: true, force: true });
      if (await exists(join(OUT, id, "play"))) console.warn(`⚠ ${id} was removed from games.json — its play build is still in public/${id}/play/ (delete it if no longer needed).`);
      else await rm(join(OUT, id), { recursive: true, force: true });
    }
  }
  for (const slug of prev.posts || []) {
    if (!posts.some((p) => p.slug === slug)) await rm(join(OUT, "news", slug), { recursive: true, force: true });
  }

  const byGame = (id) => posts.filter((p) => p.game === id);
  const author = (id) => team.find((m) => m.id === id);

  // ---- pages ----
  await out("index.html", R.renderHomePage({ ...base, games, team, news: posts }));
  for (const g of games) {
    await out(`${g.id}/index.html`, R.renderGamePage({ ...base, game: g, news: byGame(g.id) }));
    if (g.webPlay?.enabled) await out(`${g.id}/gate/index.html`, R.renderGatePage({ ...base, game: g }));
    else await rm(join(OUT, g.id, "gate"), { recursive: true, force: true });
  }
  await out("news/index.html", R.renderNewsIndex({ ...base, posts }));
  for (const p of posts) {
    await out(`news/${p.slug}/index.html`, R.renderNewsPost({
      ...base, post: p, author: author(p.author), game: games.find((g) => g.id === p.game), related: R.relatedPosts(p, posts)
    }));
  }
  await out("press/index.html", R.renderPressPage({ ...base, games, team }));
  const privacy = await readFile(join(CONTENT, "pages", "privacy.md"), "utf8");
  await out("privacy/index.html", R.renderMarkdownPage({ ...base, source: privacy, path: "/privacy/" }));
  await out("404.html", R.render404Page(base));

  // ---- feeds & metadata ----
  await out("sitemap.xml", R.renderSitemap({ settings, games, posts }));
  await out("news/feed.xml", R.renderRss({ settings, posts }));
  await out("robots.txt", R.renderRobots({ settings }));
  await out("manifest.webmanifest", R.renderManifest({ settings }));

  // ---- data the Pages Functions need (web-play allow-list) ----
  const play = Object.fromEntries(games.filter((g) => g.webPlay?.enabled).map((g) => [g.id, { title: g.title }]));
  await mkdir(join(ROOT, "lib"), { recursive: true });
  await writeFile(join(ROOT, "lib", "games.generated.js"),
    `/* GENERATED by tools/build.mjs from content/games.json — do not edit by hand. */\n` +
    `/** Games that have "webPlay": { "enabled": true }. Only these slugs can be unlocked at /<slug>/play/. */\n` +
    `export const PLAY_GAMES = ${JSON.stringify(play, null, 2)};\n`);
  await writeFile(join(ROOT, "lib", "site.generated.js"),
    `/* GENERATED by tools/build.mjs — do not edit by hand. */\n` +
    `/** Cache-busting version of css/js (same ?v= the static pages use), for pages rendered by Pages Functions from D1. */\n` +
    `export const ASSET_VERSION = ${JSON.stringify(version)};\n`);
  await writeFile(manifestPath, JSON.stringify({ games: games.map((g) => g.id), posts: posts.map((p) => p.slug) }, null, 2) + "\n");

  console.log(`✔ Built ${written.length} files into public/ (version ${version}) — ${games.length} games, ${posts.length} posts.`);
}

main().catch((e) => { console.error(e); process.exit(1); });

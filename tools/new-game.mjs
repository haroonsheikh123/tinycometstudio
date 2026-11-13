#!/usr/bin/env node
/* Scaffold a new game:  node tools/new-game.mjs <slug> "<Title>" [--app] [--web]
   - adds an entry to the TOP of content/games.json
   - creates public/assets/games/<slug>/ for cover + screenshots
   - with --web: enables webPlay and creates a placeholder public/<slug>/play/index.html
   - then rebuilds the site */
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { SLUG_RE, RESERVED_SLUGS } from "./render/validate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [slug, title] = args.filter((a) => !a.startsWith("--"));

if (!slug || !title) {
  console.log('Usage: node tools/new-game.mjs <slug> "<Title>" [--app] [--web]\nExample: node tools/new-game.mjs comet-dash "Comet Dash" --web');
  process.exit(1);
}
if (!SLUG_RE.test(slug) || RESERVED_SLUGS.includes(slug)) {
  console.error(`✖ "${slug}" is not a valid slug. Use lowercase letters, numbers and dashes (not: ${RESERVED_SLUGS.join(", ")}).`);
  process.exit(1);
}
const file = join(ROOT, "content", "games.json");
const games = JSON.parse(await readFile(file, "utf8"));
if (games.some((g) => g.id === slug)) { console.error(`✖ A game with id "${slug}" already exists.`); process.exit(1); }

const web = flags.has("--web");
games.unshift({
  id: slug,
  placeholder: false,
  title,
  tagline: "One short, friendly line about the game.",
  kind: flags.has("--app") ? "App" : "Game",
  status: "coming-soon",
  platforms: web ? ["android", "ios", "web"] : ["android", "ios"],
  genres: [],
  colors: ["#6C4BFF", "#FF5E6E"],
  releaseDate: "",
  description: ["Describe your game here: what the player does, what makes it special, and who it's for."],
  links: { android: "", ios: "", steam: "", itch: "" },
  webPlay: { enabled: web },
  cover: "",
  screenshots: [],
  trailer: ""
});
await writeFile(file, JSON.stringify(games, null, 2) + "\n");

const assets = join(ROOT, "public", "assets", "games", slug);
await mkdir(assets, { recursive: true });
await writeFile(join(assets, "README.txt"),
  `Put images for "${title}" here, e.g.\n  cover.webp      (1600x900, shown on cards and the game page)\n  shot-1.webp ... (screenshots, 16:9)\nThen reference them in content/games.json as "/assets/games/${slug}/cover.webp".\n`);

if (web) {
  const play = join(ROOT, "public", slug, "play");
  await mkdir(play, { recursive: true });
  const idx = join(play, "index.html");
  if (!(await stat(idx).then(() => true, () => false))) {
    await writeFile(idx, `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} — play</title>\n<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#17183F;color:#FFF8EC;font-family:system-ui,sans-serif;text-align:center}a{color:#FFE07A}</style></head>\n<body><main><h1>${title}</h1><p>Replace this folder with your HTML5/WebGL build (it must contain an index.html).</p><p><a href="/${slug}/">Back to the game page</a></p></main></body></html>\n`);
  }
}

console.log(`✔ Added "${title}" (${slug}) to content/games.json`);
console.log(`  → Images:   public/assets/games/${slug}/`);
if (web) console.log(`  → Web build: public/${slug}/play/  (replace the placeholder index.html)`);
execFileSync(process.execPath, [join(ROOT, "tools", "build.mjs")], { stdio: "inherit" });
console.log(`\nNext: edit the entry in content/games.json, run "node tools/build.mjs", then commit & push.`);

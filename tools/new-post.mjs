#!/usr/bin/env node
/* Scaffold a news post:  node tools/new-post.mjs "<Title>" [--category=Devlog] [--game=<slug>]
   Creates content/news/YYYY-MM-DD-<slug>.md with front-matter. Run the build afterwards. */
import { writeFile, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=");
const title = args.find((a) => !a.startsWith("--"));
if (!title) { console.log('Usage: node tools/new-post.mjs "<Title>" [--category=Announcement|Devlog|Release|Update|Press] [--game=<slug>]'); process.exit(1); }
const date = new Date().toISOString().slice(0, 10);
const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const file = join(ROOT, "content", "news", `${date}-${slug}.md`);
if (await stat(file).then(() => true, () => false)) { console.error("✖ " + file + " already exists"); process.exit(1); }
await writeFile(file, `---
title: "${title.replace(/"/g, '\\"')}"
date: ${date}
category: ${opt("category") || "Update"}
author: haroon-sheikh
excerpt: "One or two sentences shown on cards and in search results."
cover: ""
game: "${opt("game")}"
draft: false
---

Write your post here in **Markdown**.
`);
console.log("✔ Created " + file + "\n  Edit it, then run: node tools/build.mjs");

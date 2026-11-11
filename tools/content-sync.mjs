#!/usr/bin/env node
/* Keep content/ (the repo) and D1 (the live source of truth) in sync — through the public Control API.
     node tools/content-sync.mjs pull   [--url https://tinycometstudio.com]   D1 → content/ files (then commit them)
     node tools/content-sync.mjs push   [--url …] [--prune] [--dry-run]      content/ files → D1 (audited, with diffs)
   Auth: an API key in TC_API_KEY (pull needs `system:read`; push needs `system:manage`).
   After `pull`, run `node tools/build.mjs` so the static fallback in public/ matches too. */
import { readFile, writeFile, readdir, mkdir, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const base = (opt("--url", process.env.TC_API_URL || "http://localhost:8788")).replace(/\/+$/, "") + "/api/v1";
const key = process.env.TC_API_KEY;

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Agent-Name": "content-sync", ...(args.includes("--dry-run") ? { "X-Dry-Run": "true" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error?.code}: ${json.error?.message}`);
  return json;
}

async function localFiles() {
  const files = {};
  for (const f of ["settings.json", "games.json", "team.json"]) files[`content/${f}`] = await readFile(join(ROOT, "content", f), "utf8");
  for (const dir of ["news", "pages"]) for (const f of (await readdir(join(ROOT, "content", dir)).catch(() => [])).filter((x) => x.endsWith(".md"))) files[`content/${dir}/${f}`] = await readFile(join(ROOT, "content", dir, f), "utf8");
  return files;
}

async function main() {
  if (!key || !["pull", "push"].includes(cmd)) {
    console.error("Usage: TC_API_KEY=tck_… node tools/content-sync.mjs pull|push [--url https://…] [--prune] [--dry-run]");
    process.exit(2);
  }
  if (cmd === "pull") {
    const { data } = await api("GET", "/export/content");
    const wanted = new Set(Object.keys(data.files));
    for (const dir of ["news", "pages"]) for (const f of (await readdir(join(ROOT, "content", dir)).catch(() => []))) if (f.endsWith(".md") && !wanted.has(`content/${dir}/${f}`)) { await rm(join(ROOT, "content", dir, f)); console.log(`- content/${dir}/${f}`); }
    for (const [p, text] of Object.entries(data.files)) {
      if (!/^content\/[\w./-]+$/.test(p) || p.includes("..")) throw new Error(`refusing unsafe path ${p}`);
      await mkdir(dirname(join(ROOT, p)), { recursive: true });
      const prev = await readFile(join(ROOT, p), "utf8").catch(() => null);
      if (prev !== text) { await writeFile(join(ROOT, p), text); console.log(`${prev === null ? "+" : "~"} ${p}`); }
    }
    console.log("✔ Pulled. Now: node tools/build.mjs && git diff content/");
  } else {
    const res = await api("POST", "/import/content", { files: await localFiles(), prune: args.includes("--prune") });
    console.log(res.meta?.dry_run ? "Dry run — would change:" : "✔ Pushed.", JSON.stringify(res.meta?.would_change?.map((c) => `${c.action} ${c.resource_id ?? ""}`) ?? res.data, null, 2));
  }
}
main().catch((e) => { console.error("✖", e.message); process.exit(1); });

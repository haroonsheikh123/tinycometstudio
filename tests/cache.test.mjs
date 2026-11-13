/* Render cache (lib/platform/cache.js) and its purge-on-save wiring through the real API + renderPublic. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RenderCache, LruMap } from "../lib/platform/cache.js";
import { renderPublic } from "../lib/site-render.js";
import { makeEnv, bootstrapOwner, ORIGIN } from "./helpers.mjs";

test("cache: LRU evicts by entries and bytes", () => {
  const l = new LruMap({ maxEntries: 2, maxBytes: 10 });
  l.set("a", 1, 4); l.set("b", 2, 4); l.get("a"); l.set("c", 3, 4);
  assert.deepEqual([...l.map.keys()], ["a", "c"], "least recently used goes first");
  l.set("d", 4, 9);
  assert.deepEqual([...l.map.keys()], ["d"]);
  assert.equal(l.bytes, 9);
});

test("cache: match/put like the Cache API, file tier survives a restart, purge drops old versions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tc-cache-"));
  try {
    const c = new RenderCache({ dir });
    const key = new Request("https://x/__tc_render/v7/news/");
    assert.equal(await c.match(key), undefined);
    await c.put(key, new Response("<h1>news</h1>", { status: 200, headers: { "Content-Type": "text/html", ETag: '"e1"' } }));
    const hit = await c.match(key);
    assert.equal(await hit.text(), "<h1>news</h1>");
    assert.equal(hit.headers.get("etag"), '"e1"');
    assert.ok(existsSync(join(dir, "v7")));
    const fresh = new RenderCache({ dir }); // another process / after a restart
    assert.equal(await (await fresh.match(key)).text(), "<h1>news</h1>");
    assert.equal(fresh.stats.fileHits, 1);
    await c.put(new Request("https://x/__tc_render/v8/"), new Response("home"));
    await c.purge(8);
    assert.deepEqual(readdirSync(dir), ["v8"]);
    assert.equal(c.lru.size, 0);
    await c.purge();
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cache: rendered pages are cached, and a content save purges + re-renders (no stale page)", async () => {
  const cache = new RenderCache();
  const env = await makeEnv({ extra: { RENDER_CACHE: cache, PUBLIC_STATE_MEMO_MS: "0" } });
  const get = (p) => renderPublic({ request: new Request(ORIGIN + p), env });
  const a = await get("/project-nova/");
  assert.equal(a.headers.get("X-Cache"), "MISS");
  const b = await get("/project-nova/");
  assert.equal(b.headers.get("X-Cache"), "HIT");
  assert.equal(await a.text(), await b.text());
  const owner = await bootstrapOwner(env);
  const purgesBefore = cache.stats.purges;
  const r = await owner.req("PATCH", "/games/project-nova", { body: { title: "Project Nova Turbo" } });
  assert.equal(r.status, 200);
  assert.equal(cache.stats.purges, purgesBefore + 1, "content change → purge");
  const c = await get("/project-nova/");
  assert.equal(c.headers.get("X-Cache"), "MISS");
  assert.match(await c.text(), /Project Nova Turbo/);
});

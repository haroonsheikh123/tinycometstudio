/* Render cache for the Node host — stands in for Cloudflare's edge Cache API (caches.default) in lib/site-render.js.
   Same contract: match(Request) → Response | undefined, put(Request, Response). Keys already contain the content
   version (/__tc_render/v<N>/<path>), so a content change makes old entries unreachable at once; purge() (called on
   every content change, like the Cloudflare zone purge) also frees them.
   Tier 1: in-process LRU (bounded by entries and bytes). Tier 2 (optional): files under <dir>/v<N>/ shared by all app
   processes and surviving restarts — Passenger may run several processes and idles the app when there's no traffic. */
import { createHash } from "node:crypto";
import { promises as fsp, mkdirSync } from "node:fs";
import { join } from "node:path";

export class LruMap {
  constructor({ maxEntries = 500, maxBytes = 64 * 1024 * 1024 } = {}) { this.map = new Map(); this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.bytes = 0; }
  get(k) { const v = this.map.get(k); if (v === undefined) return undefined; this.map.delete(k); this.map.set(k, v); return v; }
  set(k, v, size = 0) {
    if (this.map.has(k)) this.delete(k);
    this.map.set(k, { v, size });
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) { const first = this.map.keys().next().value; this.delete(first); }
    return this;
  }
  delete(k) { const e = this.map.get(k); if (e) { this.bytes -= e.size; this.map.delete(k); } }
  clear() { this.map.clear(); this.bytes = 0; }
  get size() { return this.map.size; }
}

const versionOf = (url) => (/\/__tc_render\/v(\d+)\//.exec(url) || [])[1] ?? null;
const keyOf = (req) => (typeof req === "string" ? req : req.url);

export class RenderCache {
  /** @param {{ maxEntries?: number, maxBytes?: number, dir?: string|null }} opts */
  constructor({ maxEntries = 300, maxBytes = 48 * 1024 * 1024, dir = null } = {}) {
    this.lru = new LruMap({ maxEntries, maxBytes });
    this.dir = dir;
    this.stats = { hits: 0, fileHits: 0, misses: 0, puts: 0, purges: 0 };
    if (dir) { try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { this.dir = null; } }
  }
  _file(url) { const v = versionOf(url); return v && this.dir ? join(this.dir, `v${v}`, createHash("sha1").update(url).digest("hex") + ".json") : null; }

  static toResponse(e) { return new Response(e.body, { status: e.status, headers: e.headers }); }

  /** Raw cached entry { status, headers, body } (the server uses this to skip Response objects). */
  async lookup(req) {
    const url = keyOf(req);
    const hit = this.lru.get(url);
    if (hit) { this.stats.hits++; return hit.v; }
    const f = this._file(url);
    if (f) {
      try {
        const e = JSON.parse(await fsp.readFile(f, "utf8"));
        this.lru.set(url, e, e.body.length);
        this.stats.fileHits++;
        return e;
      } catch { /* not cached on disk */ }
    }
    this.stats.misses++;
    return undefined;
  }
  async match(req) { const e = await this.lookup(req); return e ? RenderCache.toResponse(e) : undefined; }

  async put(req, res) {
    const url = keyOf(req);
    const body = await res.text();
    const e = { status: res.status, headers: Object.fromEntries(res.headers), body };
    this.lru.set(url, e, body.length);
    this.stats.puts++;
    const f = this._file(url);
    if (f) {
      try {
        await fsp.mkdir(join(f, ".."), { recursive: true });
        const tmp = `${f}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(e));
        await fsp.rename(tmp, f);
      } catch { /* the file tier is best-effort */ }
    }
  }
  async delete(req) { const url = keyOf(req); this.lru.delete(url); const f = this._file(url); if (f) await fsp.rm(f, { force: true }); return true; }

  /** Drop everything (memory) and every on-disk version except `keepVersion`. */
  async purge(keepVersion = null) {
    this.lru.clear();
    this.stats.purges++;
    if (!this.dir) return;
    let dirs = [];
    try { dirs = await fsp.readdir(this.dir); } catch { return; }
    await Promise.all(dirs.filter((d) => /^v\d+$/.test(d) && d !== `v${keepVersion}`).map((d) => fsp.rm(join(this.dir, d), { recursive: true, force: true })));
  }
}

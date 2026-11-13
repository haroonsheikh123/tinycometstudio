/* Static file server for public/ with Cloudflare Pages' asset semantics (it backs env.ASSETS on the Node host):
   pretty URLs (/x/index.html → /x/, /x.html → /x, /x → /x/ when it is a folder), the nearest 404.html with status 404,
   _headers rules, ETag + Last-Modified → 304, single byte ranges → 206, and gzip/brotli (Node zlib) for text types,
   memoised per file version so each file is compressed once. Config files (_headers, _redirects, _routes.json) and
   dotfiles are never served. */
import { promises as fsp, createReadStream } from "node:fs";
import { join, resolve, sep, extname, dirname } from "node:path";
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { LruMap } from "./cache.js";
import { headersFor } from "./site-config.js";
import { parseRange } from "./storage/fs-bucket.js";

const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);

export const TYPES = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", map: "application/json; charset=utf-8", webmanifest: "application/manifest+json; charset=utf-8", xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", pdf: "application/pdf", zip: "application/zip",
  wasm: "application/wasm", data: "application/octet-stream", bin: "application/octet-stream", pck: "application/octet-stream", unityweb: "application/octet-stream",
  glb: "model/gltf-binary", gltf: "model/gltf+json", gz: "application/gzip"
};
export const typeFor = (p) => TYPES[extname(p).slice(1).toLowerCase()] || "application/octet-stream";
export const compressible = (type) => /^(text\/|application\/(json|javascript|xml|manifest\+json|rss\+xml|atom\+xml|x-ndjson)|image\/svg\+xml)/i.test(type || "");
const BLOCKED = new Set(["_headers", "_redirects", "_routes.json", "_worker.js"]);

/** Pick the best encoding the client accepts. */
export function negotiate(acceptEncoding) {
  const ae = String(acceptEncoding || "").toLowerCase();
  const q = (name) => { const m = new RegExp(`(?:^|,)\\s*${name}\\s*(?:;\\s*q=([0-9.]+))?`).exec(ae); return m ? (m[1] === undefined ? 1 : Number(m[1])) : 0; };
  if (q("br") > 0) return "br";
  if (q("gzip") > 0) return "gzip";
  return null;
}

export class StaticServer {
  constructor(root, { headerRules = [], maxMemoBytes = 32 * 1024 * 1024 } = {}) {
    this.root = resolve(root);
    this.headerRules = headerRules;
    this.compressed = new LruMap({ maxEntries: 2000, maxBytes: maxMemoBytes });
    this.small = new LruMap({ maxEntries: 2000, maxBytes: maxMemoBytes });
  }

  async _stat(rel) {
    const p = resolve(this.root, "." + rel);
    if (p !== this.root && !p.startsWith(this.root + sep)) return null;
    try { const st = await fsp.stat(p); return { p, st }; } catch { return null; }
  }
  async _file(rel) { const f = await this._stat(rel); return f && f.st.isFile() ? f : null; }

  /** Resolve a URL path like Pages' asset server → { kind: "file", rel, file } | { kind: "redirect", to } | { kind: "notfound" } */
  async resolvePath(pathname) {
    let path;
    try { path = decodeURIComponent(pathname); } catch { return { kind: "notfound" }; }
    if (path.includes("\0") || path.includes("\\") || path.split("/").some((s) => s === ".." || (s.startsWith(".") && s !== ".well-known"))) return { kind: "notfound" };
    const base = path.split("/").pop();
    if (BLOCKED.has(base) && dirname(path) === "/") return { kind: "notfound" };
    if (path.endsWith("/index.html")) { if (await this._file(path)) return { kind: "redirect", to: path.slice(0, -"index.html".length) }; }
    else if (path.endsWith(".html") && path !== "/404.html") { if (await this._file(path)) return { kind: "redirect", to: path.slice(0, -5) }; }
    if (path.endsWith("/")) { const f = await this._file(path + "index.html"); return f ? { kind: "file", rel: path + "index.html", file: f } : { kind: "notfound" }; }
    let f = await this._file(path);
    if (f) return { kind: "file", rel: path, file: f };
    f = await this._file(path + ".html");
    if (f) return { kind: "file", rel: path + ".html", file: f };
    if (await this._file(path + "/index.html")) return { kind: "redirect", to: path + "/" };
    return { kind: "notfound" };
  }

  async _notFoundPage(pathname) {
    let dir = pathname.endsWith("/") ? pathname : dirname(pathname);
    for (;;) {
      const f = await this._file(join(dir, "404.html").split(sep).join("/"));
      if (f) return { rel: "/404.html", file: f };
      if (dir === "/" || dir === "." || !dir) return null;
      dir = dirname(dir);
    }
  }

  async _bytes(file) {
    const key = `${file.p}|${file.st.mtimeMs}|${file.st.size}`;
    const hit = this.small.get(key);
    if (hit) return hit.v;
    const b = await fsp.readFile(file.p);
    if (b.length <= 512 * 1024) this.small.set(key, b, b.length);
    return b;
  }
  async _encoded(file, enc) {
    const key = `${file.p}|${file.st.mtimeMs}|${file.st.size}|${enc}`;
    const hit = this.compressed.get(key);
    if (hit) return hit.v;
    const raw = await this._bytes(file);
    const out = enc === "br" ? await brotli(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : await gzip(raw, { level: 9 });
    this.compressed.set(key, out, out.length);
    return out;
  }

  /**
   * Serve a request. @returns {Promise<{ status:number, headers:object, body: Buffer|null|{ path, start, end } }>}
   * `body.path` = stream that file range (big files).
   */
  async serve({ method = "GET", pathname, search = "", headers = new Headers() }) {
    if (method !== "GET" && method !== "HEAD") return { status: 405, headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }, body: Buffer.from("Method not allowed") };
    const r = await this.resolvePath(pathname);
    if (r.kind === "redirect") return { status: 308, headers: { Location: r.to + search, "Cache-Control": "public, max-age=0, must-revalidate" }, body: null };
    let status = 200, rel, file;
    if (r.kind === "file") ({ rel, file } = r);
    else {
      const nf = await this._notFoundPage(pathname);
      if (!nf) return { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, body: Buffer.from("Not found") };
      ({ rel, file } = nf); status = 404;
    }
    const type = typeFor(rel);
    const etag = `"${createHash("sha1").update(`${file.st.size}-${file.st.mtimeMs}-${rel}`).digest("hex").slice(0, 20)}"`;
    const h = {
      "Content-Type": type, "Cache-Control": "public, max-age=0, must-revalidate", ETag: etag,
      "Last-Modified": new Date(Math.floor(file.st.mtimeMs / 1000) * 1000).toUTCString(), "Accept-Ranges": "bytes",
      ...headersFor(this.headerRules, pathname)
    };
    if (status === 404) { h["Cache-Control"] = "no-store"; delete h.ETag; delete h["Last-Modified"]; }
    const canCompress = compressible(type) && file.st.size > 512;
    if (canCompress) h.Vary = "Accept-Encoding";

    if (status === 200) {
      const inm = headers.get("If-None-Match");
      const ims = headers.get("If-Modified-Since");
      if ((inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "").replace(/-(br|gzip)"$/, '"') === etag)) || (!inm && ims && Date.parse(ims) >= Math.floor(file.st.mtimeMs / 1000) * 1000)) {
        return { status: 304, headers: h, body: null };
      }
      const range = headers.get("Range");
      if (range && (!headers.get("If-Range") || headers.get("If-Range") === etag)) {
        const pr = parseRange(range, file.st.size);
        if (pr === "invalid") return { status: 416, headers: { ...h, "Content-Range": `bytes */${file.st.size}` }, body: null };
        if (pr) {
          return { status: 206, headers: { ...h, "Content-Range": `bytes ${pr.offset}-${pr.offset + pr.length - 1}/${file.st.size}`, "Content-Length": String(pr.length) },
            body: method === "HEAD" ? null : { path: file.p, start: pr.offset, end: pr.offset + pr.length - 1 } };
        }
      }
    }
    const enc = canCompress && file.st.size <= 8 * 1024 * 1024 ? negotiate(headers.get("Accept-Encoding")) : null;
    if (enc) {
      const body = await this._encoded(file, enc);
      h["Content-Encoding"] = enc;
      if (h.ETag) h.ETag = h.ETag.replace(/"$/, `-${enc}"`);
      h["Content-Length"] = String(body.length);
      delete h["Accept-Ranges"];
      return { status, headers: h, body: method === "HEAD" ? null : body };
    }
    h["Content-Length"] = String(file.st.size);
    if (method === "HEAD") return { status, headers: h, body: null };
    if (file.st.size <= 512 * 1024) return { status, headers: h, body: await this._bytes(file) };
    return { status, headers: h, body: { path: file.p, start: 0, end: file.st.size - 1 } };
  }

  /** As a web Response (for env.ASSETS.fetch). */
  async fetch(input, init) {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    const r = await this.serve({ method: req.method, pathname: url.pathname, search: url.search, headers: req.headers });
    return toWebResponse(r);
  }
}

export function toWebResponse(r) {
  let body = null;
  if (Buffer.isBuffer(r.body)) body = r.body;
  else if (r.body && r.body.path) body = lazyFileStream(r.body.path, r.body.start, r.body.end);
  const res = new Response(body, { status: r.status, headers: r.headers });
  // hints so the Node writer can send the file/buffer directly when the Response comes back unchanged
  if (r.body && r.body.path) Object.defineProperty(res, "__file", { value: r.body });
  else if (Buffer.isBuffer(r.body)) Object.defineProperty(res, "__buffer", { value: r.body });
  return res;
}

/** A web ReadableStream over a file range that only opens the file when first read. */
export function lazyFileStream(path, start, end) {
  let it;
  return new ReadableStream({
    async pull(c) {
      it ??= createReadStream(path, { start, end })[Symbol.asyncIterator]();
      const { value, done } = await it.next();
      if (done) c.close(); else c.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    },
    async cancel() { await it?.return?.(); }
  });
}

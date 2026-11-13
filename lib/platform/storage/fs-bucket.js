/* Local-disk replacement for the Cloudflare R2 bucket binding (env.MEDIA), implementing the subset of the R2 API the app
   uses: put / get (with byte ranges) / head / delete / list, httpMetadata + customMetadata, streaming bodies.

   Layout under the root directory (default ~/tinycomet-data/media, outside public_html):
     <root>/<key>                 the object's bytes (so the folder is easy to browse and back up)
     <root>/.meta/<key>.json      { size, etag (MD5, like R2), uploaded, httpMetadata, customMetadata }
   Writes go to <root>/.tmp first and are renamed into place, so readers never see half-written files.
   Keys are validated and every resolved path must stay inside the root (no "..", no absolute paths, no NUL, no "\"). */
import { createReadStream, createWriteStream, promises as fsp } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve, sep, dirname, relative } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const META = ".meta", TMP = ".tmp";

export class InvalidKeyError extends Error { constructor(key) { super(`Invalid object key: ${JSON.stringify(String(key).slice(0, 200))}`); this.code = "INVALID_KEY"; } }

/** Validate an object key. Allowed: non-empty "/"-separated segments without ".", "..", control chars or backslashes. */
export function checkKey(key) {
  const k = String(key ?? "");
  if (!k || k.length > 1024 || k.startsWith("/") || k.includes("\\") || /[\u0000-\u001f\u007f]/.test(k)) throw new InvalidKeyError(k);
  const segs = k.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) throw new InvalidKeyError(k);
  if (segs[0] === META || segs[0] === TMP) throw new InvalidKeyError(k);
  return k;
}

/** Parse an HTTP Range header (single range) for an object of `size` bytes → { offset, length } | null | "invalid". */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === "" && m[2] === "")) return "invalid";
  let start, end;
  if (m[1] === "") { const n = Number(m[2]); if (!n) return "invalid"; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start >= size || end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

function toRange(range, size) {
  if (!range) return null;
  if (typeof range.get === "function") { const r = parseRange(range.get("Range"), size); return r && r !== "invalid" ? r : null; } // Headers, like R2
  if (range.suffix != null) { const n = Math.min(size, Number(range.suffix)); return { offset: size - n, length: n }; }
  const offset = Math.min(Number(range.offset || 0), size);
  const length = range.length != null ? Math.min(Number(range.length), size - offset) : size - offset;
  return { offset, length };
}

function writeHttpMetadata(meta) {
  return (headers) => {
    const h = meta.httpMetadata || {};
    if (h.contentType) headers.set("Content-Type", h.contentType);
    if (h.contentLanguage) headers.set("Content-Language", h.contentLanguage);
    if (h.contentDisposition) headers.set("Content-Disposition", h.contentDisposition);
    if (h.contentEncoding) headers.set("Content-Encoding", h.contentEncoding);
    if (h.cacheControl) headers.set("Cache-Control", h.cacheControl);
    if (h.cacheExpiry) headers.set("Expires", new Date(h.cacheExpiry).toUTCString());
  };
}

export class FsBucket {
  constructor(root) { this.root = resolve(root); this._ready = null; }

  _path(key, base = this.root) {
    const k = checkKey(key);
    const p = resolve(base, ...k.split("/"));
    if (!p.startsWith(base + sep)) throw new InvalidKeyError(k);
    return p;
  }
  _metaPath(key) { return this._path(key, join(this.root, META)) + ".json"; }
  /** Absolute file path of an object (or throws on an invalid key). The server uses it for efficient range reads. */
  filePath(key) { return this._path(key); }

  async _init() { if (!this._ready) this._ready = Promise.all([fsp.mkdir(join(this.root, META), { recursive: true }), fsp.mkdir(join(this.root, TMP), { recursive: true })]); return this._ready; }

  async put(key, value, opts = {}) {
    const file = this._path(key);
    await this._init();
    const tmp = join(this.root, TMP, randomBytes(12).toString("hex"));
    const md5 = createHash("md5");
    let size = 0;
    let src;
    if (value == null) src = Readable.from([]);
    else if (typeof value === "string") src = Readable.from([Buffer.from(value)]);
    else if (value instanceof ArrayBuffer) src = Readable.from([Buffer.from(value)]);
    else if (ArrayBuffer.isView(value)) src = Readable.from([Buffer.from(value.buffer, value.byteOffset, value.byteLength)]);
    else if (typeof value.getReader === "function") src = Readable.fromWeb(value);
    else if (typeof value.stream === "function") src = Readable.fromWeb(value.stream());
    else throw new TypeError("FsBucket.put: unsupported value type");
    const count = new Transform({ transform(chunk, _e, cb) { size += chunk.length; md5.update(chunk); cb(null, chunk); } });
    try {
      await pipeline(src, count, createWriteStream(tmp, { mode: 0o640 }));
      await fsp.mkdir(dirname(file), { recursive: true });
      const meta = { key: checkKey(key), size, etag: md5.digest("hex"), uploaded: new Date().toISOString(), httpMetadata: { ...(opts.httpMetadata instanceof Headers ? { contentType: opts.httpMetadata.get("Content-Type") } : opts.httpMetadata || {}) }, customMetadata: { ...(opts.customMetadata || {}) } };
      const mp = this._metaPath(key);
      await fsp.mkdir(dirname(mp), { recursive: true });
      await fsp.writeFile(mp + ".tmp", JSON.stringify(meta));
      await fsp.rename(tmp, file);
      await fsp.rename(mp + ".tmp", mp);
      return this._object(meta);
    } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
  }

  async _meta(key) {
    let file;
    try { file = this._path(key); } catch { return null; }
    let st;
    try { st = await fsp.stat(file); } catch { return null; }
    if (!st.isFile()) return null;
    try {
      const m = JSON.parse(await fsp.readFile(this._metaPath(key), "utf8"));
      if (m.size === st.size) return m;
    } catch { /* missing/stale sidecar: synthesise */ }
    return { key, size: st.size, etag: `${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}`, uploaded: st.mtime.toISOString(), httpMetadata: {}, customMetadata: {} };
  }

  _object(m, extra = {}) {
    return {
      key: m.key, version: m.etag, size: m.size, etag: m.etag, httpEtag: `"${m.etag}"`, uploaded: new Date(m.uploaded), checksums: { md5: m.etag },
      httpMetadata: { ...m.httpMetadata }, customMetadata: { ...m.customMetadata }, storageClass: "Standard", writeHttpMetadata: writeHttpMetadata(m), ...extra
    };
  }

  async head(key) { const m = await this._meta(key); return m ? this._object(m) : null; }

  /** @param {{ range?: {offset?, length?, suffix?} | Headers }} [opts] */
  async get(key, opts = {}) {
    const m = await this._meta(key);
    if (!m) return null;
    const range = toRange(opts.range, m.size);
    const file = this._path(key);
    const start = range ? range.offset : 0, length = range ? range.length : m.size;
    let used = false;
    const open = () => {
      if (used) throw new TypeError("Body already used");
      used = true;
      if (!length) return Readable.from([]);
      return createReadStream(file, { start, end: start + length - 1 });
    };
    let bodyStream = null;
    const obj = this._object(m, { range: range || undefined });
    Object.defineProperties(obj, {
      body: { enumerable: true, get() { if (!bodyStream) bodyStream = Readable.toWeb(open()); return bodyStream; } },
      bodyUsed: { enumerable: true, get() { return used; } }
    });
    Object.assign(obj, {
      async arrayBuffer() { const b = await streamToBuffer(open()); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
      async text() { return (await streamToBuffer(open())).toString("utf8"); },
      async json() { return JSON.parse((await streamToBuffer(open())).toString("utf8")); },
      async blob() { return new Blob([await streamToBuffer(open())], { type: m.httpMetadata?.contentType || "" }); }
    });
    obj.filePath = file; obj.offset = start; obj.length = length;
    return obj;
  }

  async delete(keys) {
    for (const key of [].concat(keys)) {
      let file;
      try { file = this._path(key); } catch { continue; }
      await fsp.rm(file, { force: true });
      await fsp.rm(this._metaPath(key), { force: true });
      await this._prune(dirname(file), this.root);
      await this._prune(dirname(this._metaPath(key)), join(this.root, META));
    }
  }
  async _prune(dir, stop) {
    while (dir.startsWith(stop + sep)) {
      try { await fsp.rmdir(dir); } catch { return; } // not empty (or gone)
      dir = dirname(dir);
    }
  }

  /** R2-style listing: lexicographic, `limit` (≤ 1000), opaque `cursor`, optional `delimiter`. */
  async list({ prefix = "", limit = 1000, cursor, delimiter, startAfter } = {}) {
    limit = Math.max(1, Math.min(1000, Number(limit) || 1000));
    const after = cursor ? Buffer.from(cursor, "base64url").toString("utf8") : startAfter || "";
    // start walking at the deepest directory implied by the prefix
    const dirPart = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    let base = this.root;
    if (dirPart) { try { base = this._path(dirPart); } catch { return { objects: [], truncated: false, delimitedPrefixes: [] }; } }
    const keys = [];
    const walk = async (dir) => {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (dir === this.root && (e.name === META || e.name === TMP)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) keys.push(relative(this.root, p).split(sep).join("/"));
      }
    };
    await walk(base);
    keys.sort();
    const objects = [], prefixes = new Set();
    let truncated = false, last = null;
    for (const k of keys) {
      if (!k.startsWith(prefix) || (after && k <= after)) continue;
      if (delimiter) {
        const i = k.indexOf(delimiter, prefix.length);
        if (i >= 0) { prefixes.add(k.slice(0, i + delimiter.length)); continue; }
      }
      if (objects.length >= limit) { truncated = true; break; }
      const m = await this._meta(k);
      if (m) { objects.push(this._object(m)); last = k; }
    }
    return { objects, truncated, cursor: truncated && last ? Buffer.from(last).toString("base64url") : undefined, delimitedPrefixes: [...prefixes].sort() };
  }
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

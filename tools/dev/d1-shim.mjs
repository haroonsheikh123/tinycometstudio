/* DEV/TEST ONLY — a synchronous-constructor wrapper around the production SQLite adapter (lib/platform/db/sqlite.js,
   node:sqlite), plus an in-memory R2 bucket mock. Lets the Pages Functions run in plain Node tests.
   Production on Node uses lib/platform/db + lib/platform/storage; on Cloudflare the real D1/R2 bindings. */
// node:sqlite only exists on Node 22.5+; on older Node the mock R2 still works and tests use TEST_DB_DRIVER=mysql.
let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch { /* Node < 22.5 */ }
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteD1 } from "../../lib/platform/db/sqlite.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export class D1Shim extends SqliteD1 {
  constructor(file = ":memory:") {
    if (!DatabaseSync) throw new Error(`node:sqlite is not available in Node ${process.versions.node} — run the tests with TEST_DB_DRIVER=mysql`);
    const raw = new DatabaseSync(file);
    raw.exec("PRAGMA foreign_keys = ON");
    super(raw, { file });
  }
  migrate() {
    const dir = join(ROOT, "migrations");
    for (const f of readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort()) this.db.exec(readFileSync(join(dir, f), "utf8"));
    return this;
  }
}

export class R2Mock {
  constructor() { this.objects = new Map(); }
  async put(key, value, opts = {}) {
    let bytes;
    if (value instanceof ReadableStream) bytes = new Uint8Array(await new Response(value).arrayBuffer());
    else if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else if (value && typeof value.arrayBuffer === "function") bytes = new Uint8Array(await value.arrayBuffer());
    else bytes = new Uint8Array(0);
    const obj = { key, size: bytes.length, httpMetadata: opts.httpMetadata || {}, customMetadata: opts.customMetadata || {}, uploaded: new Date(), etag: String(bytes.length) + "-" + key.length, bytes };
    this.objects.set(key, obj);
    return this._wrap(obj);
  }
  _wrap(o) {
    return { key: o.key, size: o.size, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, uploaded: o.uploaded, etag: o.etag, httpEtag: `"${o.etag}"`,
      body: new Response(o.bytes).body, arrayBuffer: async () => o.bytes.slice().buffer, text: async () => new TextDecoder().decode(o.bytes),
      writeHttpMetadata(h) { if (o.httpMetadata.contentType) h.set("Content-Type", o.httpMetadata.contentType); } };
  }
  async get(key) { const o = this.objects.get(key); return o ? this._wrap(o) : null; }
  async head(key) { const o = this.objects.get(key); return o ? this._wrap(o) : null; }
  async delete(keys) { for (const k of [].concat(keys)) this.objects.delete(k); }
  async list({ prefix = "", limit = 1000 } = {}) {
    const objects = [...this.objects.values()].filter((o) => o.key.startsWith(prefix)).slice(0, limit).map((o) => this._wrap(o));
    return { objects, truncated: false };
  }
}

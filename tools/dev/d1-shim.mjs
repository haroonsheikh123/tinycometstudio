/* DEV/TEST ONLY — a Cloudflare D1-compatible wrapper around Node's built-in node:sqlite,
   plus an in-memory R2 bucket mock. Lets the Pages Functions run in plain Node (tests, tools/dev-server.mjs).
   Not used in production (Cloudflare provides the real D1/R2 bindings). */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function norm(v) {
  if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}
class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params.map(norm)); }
  _s() { return this.db.prepare(this.sql); }
  async first(col) { const r = this._s().get(...this.params); if (!r) return null; return col ? r[col] : { ...r }; }
  async all() { const rows = this._s().all(...this.params).map((r) => ({ ...r })); return { success: true, results: rows, meta: { rows_read: rows.length } }; }
  async raw() { return this._s().all(...this.params).map((r) => Object.values(r)); }
  async run() {
    if (/\breturning\b/i.test(this.sql)) { const rows = this._s().all(...this.params); return { success: true, results: rows.map((r) => ({ ...r })), meta: { changes: rows.length } }; }
    const r = this._s().run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  _sync() {
    const s = this._s();
    if (/^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql)) return { success: true, results: s.all(...this.params).map((r) => ({ ...r })), meta: {} };
    const r = s.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}
export class D1Shim {
  constructor(file = ":memory:") { this.db = new DatabaseSync(file); this.db.exec("PRAGMA foreign_keys = ON"); }
  prepare(sql) { return new Stmt(this.db, sql); }
  async batch(stmts) {
    this.db.exec("BEGIN");
    try { const out = stmts.map((s) => s._sync()); this.db.exec("COMMIT"); return out; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  async exec(sql) { this.db.exec(sql); return { count: 1 }; }
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

/* Shared helpers for route handlers. */
import { ApiError, notFound, encodeCursor, decodeCursor } from "../http.js";
import { j } from "../content.js";
import { parseRow } from "../audit.js";

export const now = (ctx) => ctx.now;
export const etag = (version) => `"v${version}"`;

/** Honour If-Match (optional): must equal the current ETag. */
export function checkIfMatch(ctx, version) {
  const h = ctx.ifMatch;
  if (!h || h === "*") return;
  const want = etag(version);
  const ok = h.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(want);
  if (!ok) throw new ApiError(412, "precondition_failed", `If-Match ${h} does not match the current version ${want} — reload and retry`, { current_version: version });
}

/** Offset-based opaque cursor pagination for small collections. */
export function paginate(items, query, { max = 200, def = 50 } = {}) {
  const limit = Math.min(max, Math.max(1, Number(query.limit) || def));
  const c = decodeCursor(query.cursor);
  const offset = c?.o || 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? encodeCursor({ o: offset + limit }) : null;
  return { page, meta: { count: page.length, total: items.length, next_cursor: next } };
}

/** Generic sort by "field" or "-field" from a whitelist. */
export function sortBy(items, sort, allowed, fallback) {
  const s = sort || fallback;
  if (!s) return items;
  const desc = s.startsWith("-");
  const f = s.replace(/^-/, "");
  if (!allowed.includes(f)) throw new ApiError(400, "validation_failed", `Can't sort by "${f}" — use one of: ${allowed.join(", ")}`);
  return [...items].sort((a, b) => {
    const x = a[f] ?? "", y = b[f] ?? "";
    const r = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return desc ? -r : r;
  });
}

export async function mustGet(db, sql, params, what) {
  const row = await db.prepare(sql).bind(...params).first();
  if (!row) throw notFound(what);
  return row;
}

/** Deep merge for PATCH: plain objects merge, arrays/values replace, null deletes optional fields only if allowed. */
export function merge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object" && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

export const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
export const parseTime = (s, field = "time") => {
  if (s == null || s === "") return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new ApiError(400, "validation_failed", `${field} must be an ISO 8601 date-time`);
  return t;
};

export async function revisionsFor(db, type, id) {
  const { results } = await db.prepare("SELECT id, version, deleted, created_at, actor, audit_id FROM revisions WHERE resource_type = ? AND resource_id = ? ORDER BY version DESC LIMIT 200").bind(type, id).all();
  return results.map((r) => ({ version: r.version, deleted: !!r.deleted, created_at: iso(r.created_at), actor: r.actor, audit_id: r.audit_id }));
}
export async function revisionData(db, type, id, version) {
  const r = await db.prepare("SELECT data FROM revisions WHERE resource_type = ? AND resource_id = ? AND version = ? ORDER BY id DESC LIMIT 1").bind(type, id, version).first();
  if (!r) throw notFound(`Revision ${version}`);
  return j(r.data);
}
/** Audit history for one resource (who changed it, when, what). */
export async function historyFor(db, type, id, limit = 100) {
  const { results } = await db.prepare("SELECT * FROM audit_log WHERE resource_type = ? AND resource_id = ? ORDER BY seq DESC LIMIT ?").bind(type, id, limit).all();
  return results.map(parseRow).map(publicAudit);
}
export function publicAudit(r) {
  return { ...r, ts: new Date(r.ts).toISOString(), ts_ms: r.ts };
}

/* Fixed-window rate limiter on D1 (atomic upsert + RETURNING). */
import { ApiError } from "./http.js";

/**
 * Count one hit in `bucket` for the current window.
 * @returns {Promise<{count:number, limit:number, remaining:number, reset:number, ok:boolean}>}
 */
export async function hit(db, bucket, limit, windowSec = 60, now = Date.now(), cost = 1) {
  const start = Math.floor(now / 1000 / windowSec) * windowSec; // window start, unix seconds
  const row = await db.prepare(
    "INSERT INTO rate_limits (bucket, window, count) VALUES (?, ?, ?) ON CONFLICT (bucket, window) DO UPDATE SET count = count + excluded.count RETURNING count"
  ).bind(bucket, start, cost).first();
  const count = Number(row?.count ?? cost);
  // Housekeeping: drop windows older than a day (cheap, occasional).
  if (Math.random() < 0.02) await db.prepare("DELETE FROM rate_limits WHERE window < ?").bind(Math.floor(now / 1000) - 86400).run().catch(() => {});
  return { count, limit, remaining: Math.max(0, limit - count), reset: start + windowSec, ok: count <= limit };
}

/** Peek at a bucket without counting. */
export async function peek(db, bucket, windowSec = 60, now = Date.now()) {
  const start = Math.floor(now / 1000 / windowSec) * windowSec;
  const row = await db.prepare("SELECT count FROM rate_limits WHERE bucket = ? AND window = ?").bind(bucket, start).first();
  return Number(row?.count || 0);
}

export function headers(r) {
  return { "RateLimit-Limit": String(r.limit), "RateLimit-Remaining": String(r.remaining), "RateLimit-Reset": String(Math.max(0, r.reset - Math.floor(Date.now() / 1000))) };
}

export async function enforce(db, bucket, limit, windowSec = 60, now = Date.now()) {
  const r = await hit(db, bucket, limit, windowSec, now);
  if (!r.ok) {
    const e = new ApiError(429, "rate_limited", `Too many requests — limit is ${limit} per ${windowSec >= 60 ? windowSec / 60 + " min" : windowSec + " s"}`, { limit, retry_after: r.reset - Math.floor(now / 1000) });
    e.headers = { ...headers(r), "Retry-After": String(Math.max(1, r.reset - Math.floor(now / 1000))) };
    throw e;
  }
  return r;
}

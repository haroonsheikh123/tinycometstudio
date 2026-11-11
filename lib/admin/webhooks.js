/* Outgoing webhooks: HMAC-SHA256 signed payloads, retries with backoff, delivery log.
   Signature header (Stripe-style):  X-TinyComet-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>  */
import { hmacHex, safeEqual, decrypt } from "./crypto.js";

export const WEBHOOK_EVENTS = [
  "game.created", "game.updated", "game.deleted", "game.restored", "game.published", "game.build_uploaded",
  "news.created", "news.updated", "news.deleted", "news.restored", "news.published", "news.unpublished", "news.scheduled",
  "team.updated", "page.updated", "settings.updated", "media.uploaded", "media.deleted",
  "message.received", "user.created", "user.updated", "user.removed", "api_key.created", "api_key.revoked",
  "approval.requested", "approval.decided", "system.kill_switch", "system.maintenance", "cache.purged", "webhook.test"
];
export const MAX_ATTEMPTS = 6;
const BACKOFF_S = [0, 30, 120, 600, 3600, 6 * 3600];

export async function signPayload(secret, body, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}
/** Receiver-side verification (also exported for docs/tests). Rejects signatures older than `tolerance` seconds. */
export async function verifySignature(secret, body, header, { tolerance = 300, now = Date.now() } = {}) {
  const parts = Object.fromEntries(String(header || "").split(",").map((kv) => kv.trim().split("=")));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(Math.floor(now / 1000) - t) > tolerance) return false;
  return safeEqual(await hmacHex(secret, `${t}.${body}`), parts.v1);
}

/** Only public https URLs (no IP literals, localhost or internal names). Workers can't reach private networks anyway — defence in depth. */
export function webhookUrlProblem(raw, { allowHttpLocal = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { return "must be a valid URL"; }
  if (allowHttpLocal && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return null;
  if (u.protocol !== "https:") return "must use https://";
  if (u.username || u.password) return "must not contain credentials";
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return "must be a public hostname";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[")) return "must be a hostname, not an IP address";
  if (u.port && !["443", "8443"].includes(u.port)) return "must use port 443 or 8443";
  return null;
}

/** Attempt one delivery now. Updates the delivery row; returns the new status. */
export async function attemptDelivery(env, id, now = Date.now()) {
  const db = env.DB;
  const d = await db.prepare("SELECT d.*, w.url, w.secret_enc, w.enabled FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.id = ?").bind(id).first();
  if (!d || d.status !== "pending") return d?.status || "missing";
  if (!d.enabled) {
    await db.prepare("UPDATE webhook_deliveries SET status = 'failed', response_excerpt = 'webhook disabled', updated_at = ? WHERE id = ?").bind(now, id).run();
    return "failed";
  }
  const attempts = d.attempts + 1;
  let status = 0, excerpt = "";
  try {
    const secret = await decrypt(env.ENCRYPTION_KEY, d.secret_enc, `webhook:${d.webhook_id}`);
    const t = Math.floor(now / 1000);
    const res = await fetch(d.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json", "User-Agent": "TinyComet-Webhooks/1",
        "X-TinyComet-Event": d.event, "X-TinyComet-Delivery": d.id, "X-TinyComet-Attempt": String(attempts),
        "X-TinyComet-Signature": await signPayload(secret, d.payload, t)
      },
      body: d.payload,
      signal: AbortSignal.timeout(10_000)
    });
    status = res.status;
    excerpt = (await res.text().catch(() => "")).slice(0, 500);
  } catch (e) { excerpt = String(e?.message || e).slice(0, 500); }
  const ok = status >= 200 && status < 300;
  const final = ok ? "success" : attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  const next = final === "pending" ? now + BACKOFF_S[Math.min(attempts, BACKOFF_S.length - 1)] * 1000 : null;
  await db.batch([
    db.prepare("UPDATE webhook_deliveries SET status = ?, attempts = ?, response_status = ?, response_excerpt = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?")
      .bind(final, attempts, status || null, excerpt, next, now, id),
    db.prepare(`UPDATE webhooks SET failure_count = ${ok ? "0" : "failure_count + 1"} WHERE id = ?`).bind(d.webhook_id)
  ]);
  return final;
}

/** Retry due deliveries (called opportunistically and by POST /system/tick). */
export async function retryDue(env, now = Date.now(), limit = 10) {
  const { results } = await env.DB.prepare("SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?").bind(now, limit).all();
  for (const r of results) await attemptDelivery(env, r.id, now);
  return results.length;
}

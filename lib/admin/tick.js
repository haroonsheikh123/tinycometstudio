/* Background housekeeping: scheduled news publishing, webhook retries, expired-row cleanup, retention.
   Runs opportunistically (≤ once a minute per isolate, after API requests and public page views when something is due)
   and on demand via POST /api/v1/system/tick (e.g. from an external cron — Pages Functions have no cron triggers). */
import { Tx } from "./tx.js";
import { retryDue, attemptDelivery } from "./webhooks.js";
import { nextPublishStmt, newsFromRow } from "./content.js";
import { getState, invalidatePublicState } from "./state.js";
import { randomId } from "./crypto.js";

export function systemContext(env, { source = "system", name = "System", id = "system", waitUntil } = {}) {
  const wait = waitUntil || ((p) => { p?.catch?.(() => {}); });
  return {
    env, now: Date.now(), reqId: "req_" + randomId("", 16), method: null, route: null, source,
    actor: { type: "system", id, name }, txs: [], dryRun: false, waitUntil: wait,
    onContentChanged: () => { invalidatePublicState(); if (env.RENDER_CACHE?.purge) wait(env.RENDER_CACHE.purge()); },
    onDeliveries: (ids) => wait((async () => { for (const d of ids) await attemptDelivery(env, d).catch(() => {}); })())
  };
}

/** Publish scheduled posts whose time has come. Returns the slugs published. */
export async function publishDue(env, now = Date.now(), waitUntil) {
  const { results } = await env.DB.prepare("SELECT * FROM news WHERE status = 'scheduled' AND deleted_at IS NULL AND publish_at <= ? LIMIT 20").bind(now).all();
  const done = [];
  for (const r of results) {
    const ctx = systemContext(env, { source: "scheduler", name: "Scheduler", id: "scheduler", waitUntil });
    const tx = new Tx(ctx);
    tx.guard("SELECT 1 FROM news WHERE slug = ? AND status = 'scheduled' AND version = ?", [r.slug, r.version], "already published");
    tx.run("UPDATE news SET status = 'published', version = version + 1, updated_at = ?, updated_by = 'scheduler' WHERE slug = ?", now, r.slug);
    const before = newsFromRow(r), after = { ...before, status: "published" };
    tx.run("INSERT INTO revisions (resource_type, resource_id, version, data, created_at, actor) VALUES ('news', ?, ?, ?, ?, 'Scheduler')", r.slug, r.version + 1, JSON.stringify(after), now);
    tx.audit({ action: "news.publish", resourceType: "news", resourceId: r.slug, label: r.title, changes: [{ path: "status", op: "changed", old: "scheduled", new: "published" }], before, after, meta: { scheduled_for: before.publish_at } });
    tx.event("news.published", { slug: r.slug, title: r.title, url: `/news/${r.slug}/`, scheduled: true });
    tx.content(`/news/${r.slug}/`, "/news/", "/");
    tx.stmts.push(nextPublishStmt(env.DB, now));
    try { await tx.commit(); done.push(r.slug); } catch (e) { if (e?.status !== 412) throw e; }
  }
  if (!results.length) await nextPublishStmt(env.DB, now).run();
  return done;
}

export async function runTick(env, { now = Date.now(), waitUntil } = {}) {
  const published = await publishDue(env, now, waitUntil);
  const retried = await retryDue(env, now);
  const db = env.DB;
  await db.batch([
    db.prepare("DELETE FROM tokens WHERE expires_at < ?").bind(now - 7 * 86_400_000),
    db.prepare("DELETE FROM idempotency WHERE created_at < ?").bind(now - 86_400_000),
    db.prepare("DELETE FROM rate_limits WHERE window < ?").bind(Math.floor(now / 1000) - 86_400),
    db.prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?").bind(now),
    db.prepare("DELETE FROM site_state WHERE key LIKE 'analytics_salt:%' AND key < ?").bind(`analytics_salt:${new Date(now - 86_400_000).toISOString().slice(0, 10)}`)
  ]);
  const st = await getState(db, ["analytics_retention"]);
  const days = Number(st.analytics_retention?.days ?? 400);
  let purged = 0;
  if (days > 0) {
    const cutoff = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
    const r = await db.batch([
      db.prepare("DELETE FROM analytics_events WHERE day < ?").bind(cutoff),
      db.prepare("DELETE FROM analytics_daily WHERE day < ?").bind(cutoff),
      db.prepare("DELETE FROM analytics_uniques WHERE day < ?").bind(cutoff)
    ]);
    purged = r.reduce((n, x) => n + (x.meta?.changes || 0), 0);
  }
  return { published, webhook_retries: retried, analytics_rows_purged: purged };
}

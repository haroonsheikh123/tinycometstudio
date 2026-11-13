/* System: health, OpenAPI, status, API kill switch, maintenance mode, cache purge, housekeeping tick, dashboard. */
import { route, reply, routes } from "../router.js";
import { S } from "../schema.js";
import { ApiError } from "../http.js";
import { Tx } from "../tx.js";
import { getState, setStateStmt, invalidatePublicState } from "../state.js";
import { runTick } from "../tick.js";
import { can } from "../permissions.js";
import { buildOpenApi } from "../openapi.js";
import { parseRow } from "../audit.js";
import { iso } from "./_util.js";
import { jsonResponse } from "../http.js";

const T = "System";
export const API_VERSION = "1.0.0";

route({
  method: "GET", path: "/health", op: "system.health", tag: T, auth: "public", noDb: true, summary: "Liveness + which bindings are configured (no secrets).",
  handler: async (ctx) => ({ ok: true, api_version: API_VERSION, d1: !!ctx.env.DB, r2: !!ctx.env.MEDIA, environment: ctx.env.ENVIRONMENT || "production", time: iso(Date.now()) })
});
route({
  method: "GET", path: "/openapi.json", op: "system.openapi", tag: T, auth: "public", noDb: true, summary: "OpenAPI 3.1 document generated from the route table.",
  handler: async (ctx) => jsonResponse(buildOpenApi(routes, { origin: ctx.url.origin, version: API_VERSION }), 200, { "Cache-Control": "public, max-age=300" })
});
route({
  method: "GET", path: "/system", op: "system.status", tag: T, perm: "system:read", summary: "Kill switch, maintenance mode, content version, bindings and which secrets are set (booleans only).",
  handler: async (ctx) => {
    const st = await getState(ctx.env.DB, ["kill_switch", "maintenance", "content_version", "setup_done", "seeded_at", "audit_retention", "analytics_retention", "next_publish_at"]);
    const counts = await ctx.env.DB.prepare("SELECT (SELECT COUNT(*) FROM users WHERE status != 'removed') AS users, (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL) AS api_keys, (SELECT COUNT(*) FROM audit_log) AS audit_entries, (SELECT COUNT(*) FROM approvals WHERE status = 'pending') AS pending_approvals, (SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'pending') AS pending_deliveries").first();
    const e = ctx.env;
    return {
      kill_switch: st.kill_switch || { enabled: false }, maintenance: st.maintenance || { enabled: false }, content_version: Number(st.content_version || 1),
      next_scheduled_publish: Number(st.next_publish_at) ? iso(Number(st.next_publish_at)) : null, environment: e.ENVIRONMENT || "production",
      bindings: { DB: !!e.DB, MEDIA: !!e.MEDIA, ASSETS: !!e.ASSETS },
      secrets: { SIGNING_KEY: !!e.SIGNING_KEY, ENCRYPTION_KEY: !!e.ENCRYPTION_KEY, SETUP_TOKEN: !!e.SETUP_TOKEN, TURNSTILE_SECRET: !!e.TURNSTILE_SECRET, EMAIL_WEBHOOK_URL: !!e.EMAIL_WEBHOOK_URL, CF_API_TOKEN: !!e.CF_API_TOKEN },
      retention: { audit_days: st.audit_retention?.days ?? 0, analytics_days: st.analytics_retention?.days ?? 400 }, seeded: !!st.seeded_at, counts, api_version: API_VERSION
    };
  }
});
route({
  method: "PUT", path: "/system/kill-switch", op: "system.kill_switch", tag: T, perm: "system:manage", stepUp: true, resource: "system", approvable: false,
  summary: "Instantly disable (or re-enable) ALL API-key access. Admin sessions keep working. An API key can only switch it on.",
  body: S.obj({ enabled: S.bool(), reason: S.str(500) }, ["enabled"]),
  handler: async (ctx, { body }) => {
    const prev = (await getState(ctx.env.DB, ["kill_switch"])).kill_switch || { enabled: false };
    if (ctx.key && !body.enabled) throw new ApiError(403, "forbidden", "Only a signed-in admin can switch API access back on");
    const val = { enabled: body.enabled, reason: body.reason || ctx.changeReason || null, at: iso(ctx.now), by: { id: ctx.actor.id, name: ctx.actor.name } };
    const tx = new Tx(ctx);
    tx.stmts.push(setStateStmt(ctx.env.DB, "kill_switch", val, ctx.now));
    tx.audit({ action: body.enabled ? "system.kill_switch_on" : "system.kill_switch_off", resourceType: "system", resourceId: "kill_switch", label: "API kill switch", reason: val.reason, changes: [{ path: "enabled", op: "changed", old: !!prev.enabled, new: body.enabled }] });
    tx.event("system.kill_switch", { enabled: body.enabled, reason: val.reason });
    await tx.commit();
    return val;
  }
});
route({
  method: "PUT", path: "/system/maintenance", op: "system.maintenance", tag: T, perm: "system:manage", resource: "system",
  summary: "Maintenance mode: public pages answer 503 with a friendly page (signed-in admins still see the site). /admin and /api keep working.",
  body: S.obj({ enabled: S.bool(), message: S.str(500) }, ["enabled"]),
  handler: async (ctx, { body }) => {
    const prev = (await getState(ctx.env.DB, ["maintenance"])).maintenance || { enabled: false };
    const val = { enabled: body.enabled, message: body.message ?? prev.message ?? "We're polishing a few things — back very soon!", at: iso(ctx.now), by: ctx.actor.name };
    const tx = new Tx(ctx);
    tx.stmts.push(setStateStmt(ctx.env.DB, "maintenance", val, ctx.now));
    tx.audit({ action: body.enabled ? "system.maintenance_on" : "system.maintenance_off", resourceType: "system", resourceId: "maintenance", label: "Maintenance mode", changes: [{ path: "enabled", op: "changed", old: !!prev.enabled, new: body.enabled }, ...(val.message !== prev.message ? [{ path: "message", op: "changed", old: prev.message ?? null, new: val.message }] : [])] });
    tx.event("system.maintenance", { enabled: body.enabled });
    tx.content("/");
    await tx.commit();
    invalidatePublicState();
    return val;
  }
});
route({
  method: "POST", path: "/cache/purge", op: "cache.purge", tag: T, perm: "cache:manage", resource: "cache", destructive: false,
  summary: "Purge the edge cache for rendered pages (bumps the content version; also purges Cloudflare's zone cache for `paths` if CF_ZONE_ID/CF_API_TOKEN are set).",
  body: S.obj({ paths: S.arr({ type: "string", pattern: "^/", maxLength: 300 }, 30) }),
  handler: async (ctx, { body }) => {
    const tx = new Tx(ctx);
    tx.audit({ action: "cache.purge", resourceType: "cache", label: body.paths?.length ? body.paths.join(", ") : "everything", meta: { paths: body.paths || null } });
    tx.content(body.paths || []);
    tx.event("cache.purged", { paths: body.paths || "all" });
    await tx.commit();
    const v = (await getState(ctx.env.DB, ["content_version"])).content_version;
    return { purged: true, content_version: Number(v || 1) };
  }
});
route({
  method: "POST", path: "/system/tick", op: "system.tick", tag: T, perm: "system:manage", resource: "system", destructive: false, dryRun: false, approvable: false,
  summary: "Run housekeeping now: publish due scheduled posts, retry webhooks, purge expired data. Call from an external cron (e.g. every 5 min).",
  handler: async (ctx) => ({ ...(await runTick(ctx.env, { now: ctx.now, waitUntil: ctx.waitUntil })), ran_at: iso(ctx.now) })
});

/* One call for the dashboard — each block only appears if you may see it. */
route({
  method: "GET", path: "/dashboard", op: "dashboard.get", tag: "Dashboard", summary: "Dashboard summary: today's & 7-day stats, top pages/games, latest messages, recent activity, pending approvals — filtered by your permissions.",
  handler: async (ctx) => {
    const db = ctx.env.DB, g = ctx.grant, out = { generated_at: iso(ctx.now) };
    const day = (ms) => new Date(ms).toISOString().slice(0, 10);
    const today = day(ctx.now), from7 = day(ctx.now - 6 * 86_400_000), from14 = day(ctx.now - 13 * 86_400_000), to14 = day(ctx.now - 7 * 86_400_000);
    if (can(g, "analytics:read")) {
      const tot = async (f, t) => {
        const { results } = await db.prepare("SELECT event, SUM(count) AS n FROM analytics_daily WHERE day BETWEEN ? AND ? GROUP BY event").bind(f, t).all();
        const v = await db.prepare("SELECT COUNT(*) AS n FROM analytics_uniques WHERE day BETWEEN ? AND ?").bind(f, t).first();
        return { ...Object.fromEntries(results.map((r) => [r.event, r.n])), visitors: v.n };
      };
      const { results: series } = await db.prepare("SELECT day, SUM(count) AS n FROM analytics_daily WHERE day BETWEEN ? AND ? AND event = 'page_view' GROUP BY day").bind(day(ctx.now - 29 * 86_400_000), today).all();
      const sm = new Map(series.map((r) => [r.day, r.n]));
      const { results: vis } = await db.prepare("SELECT day, COUNT(*) AS n FROM analytics_uniques WHERE day BETWEEN ? AND ? GROUP BY day").bind(day(ctx.now - 29 * 86_400_000), today).all();
      const vm = new Map(vis.map((r) => [r.day, r.n]));
      const topq = (dim, ev) => db.prepare(`SELECT ${dim} AS key, SUM(count) AS count FROM analytics_daily WHERE day BETWEEN ? AND ? ${ev ? "AND event = ?" : ""} AND ${dim} != '' GROUP BY ${dim} ORDER BY count DESC LIMIT 6`).bind(from7, today, ...(ev ? [ev] : [])).all();
      out.analytics = {
        today: await tot(today, today), last7: await tot(from7, today), prev7: await tot(from14, to14),
        series: Array.from({ length: 30 }, (_, i) => { const d = day(ctx.now - (29 - i) * 86_400_000); return { t: d, page_views: sm.get(d) || 0, visitors: vm.get(d) || 0 }; }),
        top_pages: (await topq("path", "page_view")).results, top_games: (await topq("game", null)).results,
        realtime: (await db.prepare("SELECT COUNT(DISTINCT visitor) AS n FROM analytics_events WHERE ts >= ?").bind(ctx.now - 5 * 60_000).first()).n
      };
    }
    if (can(g, "messages:read")) {
      const { results } = await db.prepare("SELECT id, name, email, topic, substr(body, 1, 140) AS preview, status, created_at FROM messages WHERE status IN ('new', 'read') ORDER BY created_at DESC LIMIT 5").all();
      const n = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'new'").first();
      out.messages = { unread: n.n, latest: results.map((m) => ({ ...m, created_at: iso(m.created_at) })) };
    }
    if (can(g, "audit:read")) {
      const { results } = await db.prepare("SELECT * FROM audit_log WHERE parent_id IS NULL ORDER BY seq DESC LIMIT 8").all();
      out.activity = results.map(parseRow).map((r) => ({ id: r.id, ts: iso(r.ts), actor_type: r.actor_type, actor_name: r.actor_name, api_key_name: r.api_key_name, source: r.source, action: r.action, resource_type: r.resource_type, resource_id: r.resource_id, label: r.resource_label, result: r.result, changes: (r.changes || []).length }));
    }
    if (can(g, "approvals:read")) out.pending_approvals = (await db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").first()).n;
    if (can(g, "games:read")) out.games = (await db.prepare("SELECT status, COUNT(*) AS n FROM games WHERE deleted_at IS NULL GROUP BY status").all()).results;
    if (can(g, "news:read")) out.news = (await db.prepare("SELECT status, COUNT(*) AS n FROM news WHERE deleted_at IS NULL GROUP BY status").all()).results;
    if (can(g, "system:read")) { const st = await getState(db, ["kill_switch", "maintenance"]); out.system = { kill_switch: !!st.kill_switch?.enabled, maintenance: !!st.maintenance?.enabled }; }
    return out;
  }
});

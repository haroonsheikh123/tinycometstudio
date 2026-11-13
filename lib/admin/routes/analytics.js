/* Privacy-first analytics: ingestion (POST /collect, no cookies, no IPs stored) and dashboard queries. */
import { route, reply } from "../router.js";
import { S } from "../schema.js";
import { ApiError } from "../http.js";
import { Tx } from "../tx.js";
import { sha256Hex, randomToken } from "../crypto.js";
import { hit } from "../ratelimit.js";
import { isBot, parseUserAgent, clientInfo } from "../http.js";
import { setStateStmt, getState } from "../state.js";

const T = "Analytics";
export const EVENTS = ["page_view", "news_read", "store_click", "play_click", "play_unlocked", "share_click", "contact_open"];
const DIMENSIONS = ["path", "game", "country", "device", "browser", "os", "referrer", "platform", "event"];
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const clean = (v, n = 64) => String(v ?? "").replace(/[^\w ./:@-]/g, "").slice(0, n);

let gameMemo = { at: 0, ids: new Set() };
async function gameIds(db, now) {
  if (now - gameMemo.at > 60_000) { const { results } = await db.prepare("SELECT id FROM games WHERE deleted_at IS NULL").all(); gameMemo = { at: now, ids: new Set(results.map((r) => r.id)) }; }
  return gameMemo.ids;
}
async function dailySalt(db, d, now) {
  const key = `analytics_salt:${d}`;
  await db.prepare("INSERT INTO site_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING").bind(key, JSON.stringify(randomToken(24)), now).run();
  return (await getState(db, key))[key];
}

/** Ingest one track() beacon. Always answers 204 (never leaks why an event was dropped). */
export async function collect(request, env, now = Date.now()) {
  const ok = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (!env.DB || request.method !== "POST") return ok();
  const url = new URL(request.url);
  const info = clientInfo(request);
  if (isBot(info.ua) || request.headers.get("DNT") === "1" || request.headers.get("Sec-GPC") === "1") return ok();
  const origin = request.headers.get("Origin") || request.headers.get("Referer") || "";
  try { if (origin && new URL(origin).host !== url.host) return ok(); } catch { return ok(); }
  const text = await request.text().catch(() => "");
  if (!text || text.length > 4096) return ok();
  let e;
  try { e = JSON.parse(text); } catch { return ok(); }
  if (!EVENTS.includes(e?.event)) return ok();
  const db = env.DB;
  const d = day(now);
  const salt = await dailySalt(db, d, now);
  const visitor = (await sha256Hex(`${salt}|${info.ip}|${info.ua}|${url.host}`)).slice(0, 32);
  if (!(await hit(db, `collect:${visitor}`, 120, 60, now)).ok) return ok();
  const props = e.props && typeof e.props === "object" ? e.props : {};
  let path = typeof e.path === "string" && e.path.startsWith("/") ? e.path.split(/[?#]/)[0].slice(0, 200) : "";
  let game = clean(props.game, 64);
  if (!game && path) { const seg = path.split("/")[1]; if (seg && (await gameIds(db, now)).has(seg)) game = seg; }
  let referrer = "";
  try { if (e.ref) { const h = new URL(e.ref).hostname.replace(/^www\./, ""); if (h !== url.hostname.replace(/^www\./, "")) referrer = h.slice(0, 100); } } catch { /* ignore */ }
  const ua = parseUserAgent(info.ua);
  const row = { event: e.event, path, game, platform: clean(props.platform, 20), network: clean(props.network, 20), slug: clean(props.slug, 64), referrer, country: (info.country || "").slice(0, 2), device: ua.device, browser: ua.browser, os: ua.os };
  await db.batch([
    db.prepare("INSERT INTO analytics_events (ts, day, event, path, game, platform, network, slug, referrer, country, device, browser, os, visitor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(now, d, row.event, row.path, row.game, row.platform, row.network, row.slug, row.referrer, row.country, row.device, row.browser, row.os, visitor),
    db.prepare(`INSERT INTO analytics_daily (day, event, path, game, platform, referrer, country, device, browser, os, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (day, event, path, game, platform, referrer, country, device, browser, os) DO UPDATE SET count = count + 1`)
      .bind(d, row.event, row.path, row.game, row.platform, row.referrer, row.country, row.device, row.browser, row.os),
    db.prepare("INSERT OR IGNORE INTO analytics_uniques (day, visitor) VALUES (?, ?)").bind(d, visitor)
  ]);
  return ok();
}

route({
  method: "POST", path: "/collect", op: "analytics.collect", tag: T, auth: "public", noDb: true, dryRun: false, rawBody: true,
  summary: "Analytics beacon for the site's track() hook. No cookies; IPs are never stored (daily-salted hash for unique visitors). Always 204.",
  handler: (ctx) => collect(ctx.request, ctx.env, ctx.now)
});

/* ---------------------------------------------------------------- queries */
const range = S.obj({
  from: { type: "string", format: "full-date" }, to: { type: "string", format: "full-date" }, event: S.enumOf(EVENTS), dimension: S.enumOf(DIMENSIONS),
  interval: S.enumOf(["day", "hour"]), metric: S.enumOf(["events", "visitors"]), game: S.str(64), limit: S.int(1, 100), format: S.enumOf(["json", "csv"]), kind: S.enumOf(["daily", "events"])
});
function span(q, now) {
  const to = q.to || day(now);
  const from = q.from || day(Date.parse(to) - 29 * 86_400_000);
  if (from > to) throw new ApiError(400, "validation_failed", "from must be ≤ to");
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  if (days > 800) throw new ApiError(400, "validation_failed", "Range too long (max 800 days)");
  return { from, to, days, prevFrom: day(Date.parse(from) - days * 86_400_000), prevTo: day(Date.parse(from) - 86_400_000) };
}
async function totals(db, from, to) {
  const { results } = await db.prepare("SELECT event, SUM(count) AS n FROM analytics_daily WHERE day BETWEEN ? AND ? GROUP BY event").bind(from, to).all();
  const v = await db.prepare("SELECT COUNT(*) AS n FROM analytics_uniques WHERE day BETWEEN ? AND ?").bind(from, to).first();
  const t = Object.fromEntries(EVENTS.map((e) => [e, 0]));
  results.forEach((r) => (t[r.event] = r.n));
  return { ...t, visitors: v.n };
}
async function top(db, dim, from, to, { event, limit = 10, extra = "" } = {}) {
  const where = ["day BETWEEN ? AND ?", event ? "event = ?" : null, `${dim} != ''`, extra || null].filter(Boolean).join(" AND ");
  const { results } = await db.prepare(`SELECT ${dim} AS key, SUM(count) AS count FROM analytics_daily WHERE ${where} GROUP BY ${dim} ORDER BY count DESC LIMIT ?`).bind(from, to, ...(event ? [event] : []), limit).all();
  return results;
}

route({
  method: "GET", path: "/analytics/summary", op: "analytics.summary", tag: T, perm: "analytics:read", summary: "Totals for a date range (default: last 30 days) with the previous period for comparison, plus top lists.", query: range,
  handler: async (ctx, { query }) => {
    const db = ctx.env.DB;
    const r = span(query, ctx.now);
    const [cur, prev] = await Promise.all([totals(db, r.from, r.to), totals(db, r.prevFrom, r.prevTo)]);
    return {
      range: { from: r.from, to: r.to, days: r.days }, totals: cur, previous: prev,
      top_pages: await top(db, "path", r.from, r.to, { event: "page_view", limit: 8 }),
      top_games: await top(db, "game", r.from, r.to, { limit: 8 }),
      top_referrers: await top(db, "referrer", r.from, r.to, { event: "page_view", limit: 8 }),
      top_countries: await top(db, "country", r.from, r.to, { event: "page_view", limit: 8 }),
      devices: await top(db, "device", r.from, r.to, { event: "page_view", limit: 5 }),
      store_clicks_by_platform: await top(db, "platform", r.from, r.to, { event: "store_click", limit: 6 })
    };
  }
});
route({
  method: "GET", path: "/analytics/timeseries", op: "analytics.timeseries", tag: T, perm: "analytics:read", summary: "Daily (or hourly, ≤ 14 days) series for an event, or unique visitors (metric=visitors).", query: range,
  handler: async (ctx, { query }) => {
    const db = ctx.env.DB;
    const r = span(query, ctx.now);
    const event = query.event || "page_view";
    if (query.interval === "hour") {
      if (r.days > 14) throw new ApiError(400, "validation_failed", "Hourly series are limited to 14 days");
      const { results } = await db.prepare(`SELECT (ts / 3600000) * 3600000 AS bucket, ${query.metric === "visitors" ? "COUNT(DISTINCT visitor)" : "COUNT(*)"} AS value FROM analytics_events WHERE day BETWEEN ? AND ? ${query.metric === "visitors" ? "" : "AND event = ?"} ${query.game ? "AND game = ?" : ""} GROUP BY bucket ORDER BY bucket`)
        .bind(r.from, r.to, ...(query.metric === "visitors" ? [] : [event]), ...(query.game ? [query.game] : [])).all();
      const map = new Map(results.map((x) => [x.bucket, x.value]));
      const start = Date.parse(r.from), end = Math.min(Date.parse(r.to) + 86_400_000, ctx.now + 3_600_000);
      const points = [];
      for (let t = start; t < end; t += 3_600_000) points.push({ t: new Date(t).toISOString(), value: map.get(t) || 0 });
      return { interval: "hour", event: query.metric === "visitors" ? null : event, metric: query.metric || "events", points };
    }
    const { results } = query.metric === "visitors"
      ? await db.prepare("SELECT day, COUNT(*) AS value FROM analytics_uniques WHERE day BETWEEN ? AND ? GROUP BY day").bind(r.from, r.to).all()
      : await db.prepare(`SELECT day, SUM(count) AS value FROM analytics_daily WHERE day BETWEEN ? AND ? AND event = ? ${query.game ? "AND game = ?" : ""} GROUP BY day`).bind(r.from, r.to, event, ...(query.game ? [query.game] : [])).all();
    const map = new Map(results.map((x) => [x.day, x.value]));
    const points = [];
    for (let i = 0; i < r.days; i++) { const d = day(Date.parse(r.from) + i * 86_400_000); points.push({ t: d, value: map.get(d) || 0 }); }
    return { interval: "day", event: query.metric === "visitors" ? null : event, metric: query.metric || "events", points };
  }
});
route({
  method: "GET", path: "/analytics/breakdown", op: "analytics.breakdown", tag: T, perm: "analytics:read", summary: "Top values of a dimension (path, game, country, device, browser, os, referrer, platform, event) for an event.", query: range,
  handler: async (ctx, { query }) => {
    const r = span(query, ctx.now);
    const dim = query.dimension || "path";
    const rows = await top(ctx.env.DB, dim, r.from, r.to, { event: dim === "event" ? null : query.event || null, limit: query.limit || 20, extra: query.game ? `game = '${query.game.replace(/[^a-z0-9-]/g, "")}'` : "" });
    const total = rows.reduce((n, x) => n + x.count, 0);
    return { dimension: dim, event: query.event || null, range: { from: r.from, to: r.to }, rows: rows.map((x) => ({ ...x, share: total ? x.count / total : 0 })) };
  }
});
route({
  method: "GET", path: "/analytics/funnel", op: "analytics.funnel", tag: T, perm: "analytics:read", summary: "Per-game funnel in distinct visitors: game page view → store click / play click → captcha passed (play_unlocked).", query: range,
  handler: async (ctx, { query }) => {
    const r = span(query, ctx.now);
    const { results } = await ctx.env.DB.prepare(`SELECT game, event, COUNT(DISTINCT visitor) AS n FROM analytics_events WHERE day BETWEEN ? AND ? AND game != '' AND event IN ('page_view', 'store_click', 'play_click', 'play_unlocked') ${query.game ? "AND game = ?" : ""} GROUP BY game, event`)
      .bind(r.from, r.to, ...(query.game ? [query.game] : [])).all();
    const games = {};
    for (const x of results) (games[x.game] ||= { game: x.game, page_view: 0, store_click: 0, play_click: 0, play_unlocked: 0 })[x.event] = x.n;
    const rows = Object.values(games).map((g) => ({ ...g, store_rate: g.page_view ? g.store_click / g.page_view : 0, play_rate: g.page_view ? g.play_click / g.page_view : 0, unlock_rate: g.play_click ? g.play_unlocked / g.play_click : 0 })).sort((a, b) => b.page_view - a.page_view);
    return { range: { from: r.from, to: r.to }, steps: ["page_view", "store_click", "play_click", "play_unlocked"], games: rows, note: "Distinct visitors per step within the range (raw events, kept for the retention period)." };
  }
});
route({
  method: "GET", path: "/analytics/realtime", op: "analytics.realtime", tag: T, perm: "analytics:read", summary: "Last 30 minutes: events per minute, visitors active in the last 5 minutes, top pages, latest events.",
  handler: async (ctx) => {
    const db = ctx.env.DB, since = ctx.now - 30 * 60_000;
    const [perMin, active, pages, latest] = await db.batch([
      db.prepare("SELECT (ts / 60000) * 60000 AS m, COUNT(*) AS n FROM analytics_events WHERE ts >= ? GROUP BY m ORDER BY m").bind(since),
      db.prepare("SELECT COUNT(DISTINCT visitor) AS n FROM analytics_events WHERE ts >= ?").bind(ctx.now - 5 * 60_000),
      db.prepare("SELECT path, COUNT(*) AS n FROM analytics_events WHERE ts >= ? AND event = 'page_view' GROUP BY path ORDER BY n DESC LIMIT 8").bind(since),
      db.prepare("SELECT ts, event, path, game, country, device FROM analytics_events WHERE ts >= ? ORDER BY ts DESC LIMIT 25").bind(since)
    ]);
    const map = new Map(perMin.results.map((x) => [x.m, x.n]));
    const minutes = [];
    for (let t = Math.floor(since / 60_000) * 60_000; t <= ctx.now; t += 60_000) minutes.push({ t: new Date(t).toISOString(), value: map.get(t) || 0 });
    return { active_visitors: active.results[0].n, per_minute: minutes, top_pages: pages.results, latest: latest.results.map((e) => ({ ...e, ts: new Date(e.ts).toISOString() })) };
  }
});
route({
  method: "GET", path: "/analytics/export", op: "analytics.export", tag: T, perm: "analytics:read", resource: "analytics", summary: "Export daily aggregates (kind=daily) or raw events (kind=events, no visitor hashes) as CSV or JSON. Audited.", query: range,
  handler: async (ctx, { query }) => {
    const r = span(query, ctx.now);
    const kind = query.kind || "daily";
    const { results } = kind === "events"
      ? await ctx.env.DB.prepare("SELECT ts, day, event, path, game, platform, network, slug, referrer, country, device, browser, os FROM analytics_events WHERE day BETWEEN ? AND ? ORDER BY ts LIMIT 100000").bind(r.from, r.to).all()
      : await ctx.env.DB.prepare("SELECT * FROM analytics_daily WHERE day BETWEEN ? AND ? ORDER BY day, event LIMIT 100000").bind(r.from, r.to).all();
    const tx = new Tx(ctx);
    tx.audit({ action: "analytics.export", resourceType: "analytics", label: `${kind} ${r.from} → ${r.to} (${query.format || "json"})`, meta: { rows: results.length, kind, from: r.from, to: r.to, format: query.format || "json" } });
    await tx.commit();
    if (query.format === "csv") {
      const cols = results.length ? Object.keys(results[0]) : ["day", "event", "count"];
      const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s; };
      const csv = [cols.join(","), ...results.map((row) => cols.map((c) => esc(row[c])).join(","))].join("\n");
      return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="analytics-${kind}-${r.from}-${r.to}.csv"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    return reply(results, { meta: { kind, from: r.from, to: r.to, rows: results.length } });
  }
});
route({
  method: "GET", path: "/analytics/retention", op: "analytics.retention_get", tag: T, perm: "analytics:read", summary: "How long analytics data is kept.",
  handler: async (ctx) => ({ days: Number((await getState(ctx.env.DB, ["analytics_retention"])).analytics_retention?.days ?? 400) })
});
route({
  method: "PUT", path: "/analytics/retention", op: "analytics.retention_set", tag: T, perm: "analytics:manage", resource: "analytics", summary: "Set analytics retention in days (0 = keep forever). Older rows are purged by the housekeeping tick.",
  body: S.obj({ days: S.int(0, 3650) }, ["days"]),
  handler: async (ctx, { body }) => {
    const prev = Number((await getState(ctx.env.DB, ["analytics_retention"])).analytics_retention?.days ?? 400);
    const tx = new Tx(ctx);
    tx.stmts.push(setStateStmt(ctx.env.DB, "analytics_retention", { days: body.days }, ctx.now));
    tx.audit({ action: "analytics.retention_set", resourceType: "analytics", label: "Analytics retention", changes: [{ path: "days", op: "changed", old: prev, new: body.days }] });
    await tx.commit();
    return { days: body.days };
  }
});

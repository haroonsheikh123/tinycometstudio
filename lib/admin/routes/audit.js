/* Audit log API: search/filter, single entry, chain verification, export, retention + R2 archive (owner). */
import { route, reply } from "../router.js";
import { S } from "../schema.js";
import { ApiError, notFound } from "../http.js";
import { Tx } from "../tx.js";
import { parseRow, verifyChain, makeEntry, chainHead, chainEntries } from "../audit.js";
import { getState, setStateStmt } from "../state.js";
import { publicAudit, iso } from "./_util.js";

const T = "Audit log";
const filters = S.obj({
  actor_id: S.str(64), actor_type: S.enumOf(["user", "api_key", "system", "webhook", "anonymous"]), api_key_id: S.str(64), source: S.str(100), agent: S.str(80),
  action: S.str(80, { description: "Exact action, or a prefix ending in * (e.g. game.*)" }), resource_type: S.str(40), resource_id: S.str(100),
  result: S.enumOf(["success", "denied", "error", "dry_run", "pending_approval"]), ip: S.str(64), session_id: S.str(64), parent_id: S.str(64),
  from: S.str(40, { description: "ISO date/time (inclusive)" }), to: S.str(40, { description: "ISO date/time (inclusive)" }), q: S.str(100),
  after_seq: S.int(0, Number.MAX_SAFE_INTEGER, { description: "Only entries newer than this sequence number (real-time polling)" }),
  cursor: S.str(40, { description: "next_cursor from the previous page (older entries)" }), limit: S.int(1, 500), format: S.enumOf(["json", "csv"])
});
function where(q) {
  const w = [], p = [];
  const eq = (col, v) => { if (v !== undefined && v !== "") { w.push(`${col} = ?`); p.push(v); } };
  eq("actor_id", q.actor_id); eq("actor_type", q.actor_type); eq("api_key_id", q.api_key_id); eq("source", q.source); eq("resource_type", q.resource_type);
  eq("resource_id", q.resource_id); eq("result", q.result); eq("ip", q.ip); eq("session_id", q.session_id); eq("parent_id", q.parent_id);
  if (q.agent) { w.push("source = ?"); p.push(`agent:${q.agent}`); }
  if (q.action) { if (q.action.endsWith("*")) { w.push("action LIKE ?"); p.push(q.action.slice(0, -1).replace(/[%_]/g, "") + "%"); } else eq("action", q.action); }
  const t = (s, end) => { const x = Date.parse(s.length === 10 && end ? `${s}T23:59:59.999Z` : s); if (Number.isNaN(x)) throw new ApiError(400, "validation_failed", "from/to must be ISO dates"); return x; };
  if (q.from) { w.push("ts >= ?"); p.push(t(q.from)); }
  if (q.to) { w.push("ts <= ?"); p.push(t(q.to, true)); }
  if (q.after_seq != null) { w.push("seq > ?"); p.push(q.after_seq); }
  if (q.cursor) { w.push("seq < ?"); p.push(Number(q.cursor) || 0); }
  if (q.q) { w.push("(action LIKE ? OR resource_label LIKE ? OR actor_name LIKE ? OR actor_email LIKE ? OR resource_id LIKE ? OR api_key_name LIKE ? OR reason LIKE ?)"); const s = `%${q.q.replace(/[%_]/g, "")}%`; p.push(s, s, s, s, s, s, s); }
  return { sql: w.length ? `WHERE ${w.join(" AND ")}` : "", params: p };
}

route({
  method: "GET", path: "/audit", op: "audit.list", tag: T, perm: "audit:read", summary: "Search the audit log (newest first). Filters combine with AND. Poll with after_seq for a live feed.", query: filters,
  handler: async (ctx, { query }) => {
    const limit = Math.min(500, query.limit || 50);
    const { sql, params } = where(query);
    const order = query.after_seq != null ? "ASC" : "DESC";
    const { results } = await ctx.env.DB.prepare(`SELECT * FROM audit_log ${sql} ORDER BY seq ${order} LIMIT ?`).bind(...params, limit + 1).all();
    const more = results.length > limit;
    const page = results.slice(0, limit).map(parseRow).map(publicAudit);
    const head = await ctx.env.DB.prepare("SELECT MAX(seq) AS s FROM audit_log").first();
    return reply(page, { meta: { count: page.length, next_cursor: more && order === "DESC" ? String(page[page.length - 1].seq) : null, latest_seq: head.s || 0 } });
  }
});
route({
  method: "GET", path: "/audit/verify", op: "audit.verify", tag: T, perm: "audit:read", summary: "Verify the tamper-evident hash chain (every entry's HMAC and link to the previous one).",
  query: S.obj({ from_seq: S.int(1, Number.MAX_SAFE_INTEGER), limit: S.int(1, 200_000) }),
  handler: async (ctx, { query }) => {
    if (!ctx.env.SIGNING_KEY) throw new ApiError(503, "not_configured", "SIGNING_KEY is required to verify");
    const r = await verifyChain(ctx.env, { fromSeq: query.from_seq ?? null, limit: query.limit ?? 50_000 });
    return { ...r, verified_at: iso(ctx.now), algorithm: "HMAC-SHA256(key derived from SIGNING_KEY, prev_hash + '\\n' + canonical_json(entry))" };
  }
});
route({
  method: "GET", path: "/audit/export", op: "audit.export", tag: T, perm: "audit:read", resource: "audit", summary: "Export matching entries as JSON or CSV (max 50 000). The export itself is audited.", query: filters,
  handler: async (ctx, { query }) => {
    const { sql, params } = where(query);
    const { results } = await ctx.env.DB.prepare(`SELECT * FROM audit_log ${sql} ORDER BY seq LIMIT 50000`).bind(...params).all();
    const tx = new Tx(ctx);
    tx.audit({ action: "audit.export", resourceType: "audit", label: `${results.length} entries (${query.format || "json"})`, meta: { filters: Object.fromEntries(Object.entries(query).filter(([k]) => k !== "format")), rows: results.length } });
    await tx.commit();
    const rows = results.map(parseRow).map(publicAudit);
    if (query.format === "csv") {
      const cols = ["seq", "id", "ts", "actor_type", "actor_name", "actor_email", "actor_role", "api_key_name", "source", "ip", "country", "city", "device", "method", "route", "action", "resource_type", "resource_id", "resource_label", "result", "result_reason", "reason", "changes", "request_id", "prev_hash", "hash"];
      const esc = (v) => { const s = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? ""); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s; };
      return new Response([cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="audit-${new Date(ctx.now).toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    return reply(rows, { meta: { rows: rows.length } });
  }
});
route({
  method: "GET", path: "/audit/retention", op: "audit.retention_get", tag: T, perm: "audit:read", summary: "Audit retention policy (default: keep forever).",
  handler: async (ctx) => { const st = await getState(ctx.env.DB, ["audit_retention", "audit_anchor"]); return { days: st.audit_retention?.days ?? 0, archive_to_r2: st.audit_retention?.archive !== false, anchor: st.audit_anchor || null }; }
});
route({
  method: "PUT", path: "/audit/retention", op: "audit.retention_set", tag: T, ownerOnly: true, perm: "audit:read", stepUp: true, resource: "audit",
  summary: "Owner only: set retention (days, 0 = forever). Entries older than that are archived to R2 (JSONL) and removed by POST /audit/archive.",
  body: S.obj({ days: S.int(0, 36500), archive: S.bool({ default: true }) }, ["days"]),
  handler: async (ctx, { body }) => {
    const prev = (await getState(ctx.env.DB, ["audit_retention"])).audit_retention || { days: 0, archive: true };
    const tx = new Tx(ctx);
    tx.stmts.push(setStateStmt(ctx.env.DB, "audit_retention", { days: body.days, archive: body.archive }, ctx.now));
    tx.audit({ action: "audit.retention_set", resourceType: "audit", label: "Audit retention", changes: [{ path: "days", op: "changed", old: prev.days ?? 0, new: body.days }, { path: "archive", op: "changed", old: prev.archive !== false, new: body.archive }].filter((c) => c.old !== c.new) });
    await tx.commit();
    return { days: body.days, archive: body.archive };
  }
});
route({
  method: "POST", path: "/audit/archive", op: "audit.archive", tag: T, ownerOnly: true, perm: "audit:read", stepUp: true, resource: "audit", dryRun: false,
  summary: "Owner only: write entries older than the retention window to R2 as JSONL, then remove them from D1. The chain stays verifiable via an anchor (last removed seq + hash). Audited.",
  handler: async (ctx) => {
    const db = ctx.env.DB;
    const st = await getState(db, ["audit_retention"]);
    const days = st.audit_retention?.days || 0;
    if (!days) throw new ApiError(409, "conflict", "Retention is 'keep forever' — nothing to archive");
    const cutoff = ctx.now - days * 86_400_000;
    const { results } = await db.prepare("SELECT * FROM audit_log WHERE ts < ? ORDER BY seq LIMIT 20000").bind(cutoff).all();
    if (!results.length) return { archived: 0 };
    const last = results[results.length - 1];
    const v = await verifyChain(ctx.env, { limit: results.length });
    if (!v.ok) throw new ApiError(409, "conflict", `Chain verification failed at seq ${v.broken_at?.seq} — refusing to archive`, v);
    let key = null;
    if (st.audit_retention?.archive !== false) {
      if (!ctx.env.MEDIA) throw new ApiError(503, "not_configured", "R2 (MEDIA) is needed to archive");
      key = `audit-archive/${results[0].seq}-${last.seq}-${new Date(ctx.now).toISOString().slice(0, 10)}.jsonl`;
      await ctx.env.MEDIA.put(key, results.map((r) => JSON.stringify(r)).join("\n") + "\n", { httpMetadata: { contentType: "application/x-ndjson" }, customMetadata: { first_seq: String(results[0].seq), last_seq: String(last.seq), last_hash: last.hash } });
    }
    // purge + anchor + the audit entry for this purge, in one transaction
    const entry = makeEntry(ctx, { action: "audit.archive", resourceType: "audit", label: `seq ${results[0].seq}–${last.seq}`, meta: { archived: results.length, r2_key: key, cutoff: iso(cutoff), anchor: { seq: last.seq, hash: last.hash } } });
    // The delete trigger looks for the raw value '1' (setStateStmt would store the JSON string "\"1\"").
    const unlockStmt = (v) => db.prepare("INSERT INTO site_state (key, value, updated_at) VALUES ('audit_purge_unlock', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(v, ctx.now);
    for (let attempt = 0; attempt < 5; attempt++) {
      const head = await chainHead(db);
      const { statements } = await chainEntries(ctx.env, db, [entry], head);
      try {
        await db.batch([
          unlockStmt("1"),
          db.prepare("DELETE FROM audit_log WHERE seq <= ?").bind(last.seq),
          unlockStmt("0"),
          setStateStmt(db, "audit_anchor", { seq: last.seq, hash: last.hash, archived_at: ctx.now, r2_key: key }, ctx.now),
          ...statements
        ]);
        break;
      } catch (e) { if (attempt === 4 || !/UNIQUE/i.test(String(e.message))) throw e; }
    }
    return { archived: results.length, r2_key: key, anchor: { seq: last.seq, hash: last.hash } };
  }
});
route({
  method: "GET", path: "/audit/{id}", op: "audit.get", tag: T, perm: "audit:read", summary: "One entry with full before/after snapshots and the field diff.",
  handler: async (ctx, { params }) => {
    const r = await ctx.env.DB.prepare("SELECT * FROM audit_log WHERE id = ?").bind(params.id).first();
    if (!r) throw notFound("Audit entry");
    const { results: children } = await ctx.env.DB.prepare("SELECT id, seq, action, resource_type, resource_id, resource_label, result FROM audit_log WHERE parent_id = ? ORDER BY seq LIMIT 500").bind(r.id).all();
    return { ...publicAudit(parseRow(r)), children };
  }
});

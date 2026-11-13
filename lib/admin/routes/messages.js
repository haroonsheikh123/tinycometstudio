/* Messages inbox (+ the public contact endpoint). */
import { route, reply } from "../router.js";
import { S } from "../schema.js";
import { ApiError, notFound } from "../http.js";
import { Tx } from "../tx.js";
import { randomId } from "../crypto.js";
import { paginate, iso } from "./_util.js";
import { isBot } from "../http.js";

const T = "Messages";
const out = (m, full = true) => m && ({ id: m.id, name: m.name, email: m.email, topic: m.topic, ...(full ? { body: m.body } : { preview: m.body.slice(0, 160) }), status: m.status, country: m.country, created_at: iso(m.created_at), updated_at: iso(m.updated_at) });

route({
  method: "POST", path: "/contact", op: "messages.receive", tag: T, auth: "public", dryRun: false, ipLimit: [5, 600], resource: "message",
  summary: "Public contact form endpoint (rate-limited, honeypot field `website` must be empty).",
  body: S.obj({ name: S.str(100), email: { type: "string", format: "email", maxLength: 254 }, topic: S.str(60), message: S.str(5000, { minLength: 2 }), website: S.str(200) }, ["email", "message"]),
  handler: async (ctx, { body }) => {
    if (body.website || isBot(ctx.ua)) return reply({ received: true }, { status: 202 }); // silently drop bots
    const id = randomId("msg_", 12);
    const m = { id, name: (body.name || "").trim(), email: body.email.trim(), topic: (body.topic || "").trim(), body: body.message.trim() };
    const tx = new Tx(ctx);
    tx.run("INSERT INTO messages (id, name, email, topic, body, status, country, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?)", id, m.name, m.email, m.topic, m.body, ctx.country, ctx.now, ctx.now);
    tx.audit({ action: "message.receive", actorType: "anonymous", actorName: m.name || "Visitor", actorEmail: m.email, resourceType: "message", resourceId: id, label: `${m.topic || "Message"} from ${m.email}`, after: { id, email: m.email, topic: m.topic, length: m.body.length } });
    tx.event("message.received", { id, name: m.name, email: m.email, topic: m.topic, preview: m.body.slice(0, 200) });
    await tx.commit();
    return reply({ received: true, id }, { status: 201 });
  }
});

route({
  method: "GET", path: "/messages", op: "messages.list", tag: T, perm: "messages:read", resource: "message", summary: "Inbox (newest first). status = new | read | archived | spam | all.",
  query: S.obj({ status: S.enumOf(["new", "read", "archived", "spam", "all", "inbox"]), q: S.str(100), limit: S.int(1, 200), cursor: S.str(200) }),
  handler: async (ctx, { query }) => {
    const st = query.status || "inbox";
    let { results } = await ctx.env.DB.prepare("SELECT * FROM messages ORDER BY created_at DESC LIMIT 5000").all();
    const counts = results.reduce((a, m) => ({ ...a, [m.status]: (a[m.status] || 0) + 1 }), {});
    if (st === "inbox") results = results.filter((m) => m.status === "new" || m.status === "read");
    else if (st !== "all") results = results.filter((m) => m.status === st);
    if (query.q) { const q = query.q.toLowerCase(); results = results.filter((m) => `${m.name} ${m.email} ${m.topic} ${m.body}`.toLowerCase().includes(q)); }
    const { page, meta } = paginate(results.map((m) => out(m, false)), query);
    return reply(page, { meta: { ...meta, counts } });
  }
});
route({
  method: "GET", path: "/messages/{id}", op: "messages.get", tag: T, perm: "messages:read", resource: "message", summary: "Read a message.",
  handler: async (ctx, { params }) => { const m = await ctx.env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(params.id).first(); if (!m) throw notFound("Message"); return out(m); }
});
async function setStatus(tx, m, status, parentId) {
  tx.run("UPDATE messages SET status = ?, updated_at = ? WHERE id = ?", status, tx.ctx.now, m.id);
  tx.audit({ parentId, action: "message.update", resourceType: "message", resourceId: m.id, label: `${m.topic || "Message"} from ${m.email}`, changes: [{ path: "status", op: "changed", old: m.status, new: status }] });
}
route({
  method: "PATCH", path: "/messages/{id}", op: "messages.update", tag: T, perm: "messages:update", resource: "message", summary: "Mark read / archived / spam.",
  body: S.obj({ status: S.enumOf(["new", "read", "archived", "spam"]) }, ["status"]),
  handler: async (ctx, { params, body }) => {
    const m = await ctx.env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(params.id).first();
    if (!m) throw notFound("Message");
    if (m.status === body.status) return out(m);
    const tx = new Tx(ctx);
    await setStatus(tx, m, body.status);
    await tx.commit();
    return out({ ...m, status: body.status });
  }
});
route({
  method: "DELETE", path: "/messages/{id}", op: "messages.delete", tag: T, perm: "messages:delete", resource: "message", summary: "Delete a message permanently (its content is kept in the audit snapshot).",
  handler: async (ctx, { params }) => {
    const m = await ctx.env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(params.id).first();
    if (!m) throw notFound("Message");
    const tx = new Tx(ctx);
    tx.run("DELETE FROM messages WHERE id = ?", m.id);
    tx.audit({ action: "message.delete", resourceType: "message", resourceId: m.id, label: `${m.topic || "Message"} from ${m.email}`, before: out(m) });
    await tx.commit();
    return { deleted: m.id };
  }
});
route({
  method: "POST", path: "/messages/bulk", op: "messages.bulk", tag: T, resource: "message",
  perm: (ctx, { body }) => (body.action === "delete" ? ["messages:delete"] : ["messages:update"]),
  summary: "Bulk action on many messages (one parent audit entry + one child per message).",
  body: S.obj({ ids: S.arr(S.str(40), 500, { minItems: 1, uniqueItems: true }), action: S.enumOf(["mark_read", "mark_new", "archive", "spam", "delete"]) }, ["ids", "action"]),
  handler: async (ctx, { body }) => {
    const db = ctx.env.DB;
    const { results } = await db.prepare(`SELECT * FROM messages WHERE id IN (${body.ids.map(() => "?").join(",")})`).bind(...body.ids).all();
    if (!results.length) throw notFound("Messages");
    const tx = new Tx(ctx);
    const parent = tx.audit({ action: `message.bulk_${body.action}`, resourceType: "message", label: `${results.length} message(s)`, meta: { ids: results.map((m) => m.id) } });
    const status = { mark_read: "read", mark_new: "new", archive: "archived", spam: "spam" }[body.action];
    for (const m of results) {
      if (body.action === "delete") { tx.run("DELETE FROM messages WHERE id = ?", m.id); tx.audit({ parentId: parent, action: "message.delete", resourceType: "message", resourceId: m.id, label: `${m.topic || "Message"} from ${m.email}`, before: out(m) }); }
      else if (m.status !== status) await setStatus(tx, m, status, parent);
    }
    await tx.commit();
    return { action: body.action, affected: results.length };
  }
});
export { ApiError };

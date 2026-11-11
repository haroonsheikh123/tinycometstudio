/* Webhook subscriptions, signing secrets, test pings, delivery log, redelivery. */
import { route, reply } from "../router.js";
import { S } from "../schema.js";
import { ApiError, notFound } from "../http.js";
import { Tx } from "../tx.js";
import { randomId, randomToken, encrypt } from "../crypto.js";
import { diff } from "../audit.js";
import { j } from "../content.js";
import { WEBHOOK_EVENTS, webhookUrlProblem, attemptDelivery } from "../webhooks.js";
import { paginate, iso, checkIfMatch, etag } from "./_util.js";

const T = "Webhooks";
const hookOut = (h) => h && ({ id: h.id, url: h.url, description: h.description, events: j(h.events, []), enabled: !!h.enabled, failure_count: h.failure_count, created_at: iso(h.created_at), updated_at: iso(h.updated_at), created_by: h.created_by, version: h.version });
const delOut = (d) => d && ({ id: d.id, webhook_id: d.webhook_id, event: d.event, status: d.status, attempts: d.attempts, response_status: d.response_status, response_excerpt: d.response_excerpt, next_attempt_at: iso(d.next_attempt_at), created_at: iso(d.created_at), updated_at: iso(d.updated_at), payload: j(d.payload) });
const eventsSchema = S.arr({ type: "string", maxLength: 60 }, 50, { minItems: 1, uniqueItems: true, description: `Event names, "<group>.*" or "*". Known: ${WEBHOOK_EVENTS.join(", ")}` });
function checkEvents(list) {
  const bad = list.filter((e) => e !== "*" && !WEBHOOK_EVENTS.includes(e) && !(e.endsWith(".*") && WEBHOOK_EVENTS.some((x) => x.startsWith(e.slice(0, -1)))));
  if (bad.length) throw new ApiError(400, "validation_failed", `Unknown events: ${bad.join(", ")}`, { known: WEBHOOK_EVENTS });
}
const urlCheck = (ctx, url) => { const p = webhookUrlProblem(url, { allowHttpLocal: ctx.env.ENVIRONMENT === "development" }); if (p) throw new ApiError(400, "validation_failed", `url ${p}`); };
const newSecret = () => `whsec_${randomToken(32)}`;

route({ method: "GET", path: "/webhooks/events", op: "webhooks.events", tag: T, perm: "webhooks:read", summary: "Event catalogue.", handler: async () => WEBHOOK_EVENTS });
route({
  method: "GET", path: "/webhooks", op: "webhooks.list", tag: T, perm: "webhooks:read", resource: "webhook", summary: "List subscriptions (secrets are never returned).",
  handler: async (ctx) => (await ctx.env.DB.prepare("SELECT * FROM webhooks ORDER BY created_at").all()).results.map(hookOut)
});
route({
  method: "POST", path: "/webhooks", op: "webhooks.create", tag: T, perm: "webhooks:manage", resource: "webhook", destructive: false,
  summary: "Subscribe an https URL to events. Returns the signing secret ONCE (verify X-TinyComet-Signature with it).",
  body: S.obj({ url: S.str(2000, { minLength: 8 }), description: S.str(300), events: eventsSchema, enabled: S.bool({ default: true }) }, ["url", "events"]),
  handler: async (ctx, { body }) => {
    urlCheck(ctx, body.url); checkEvents(body.events);
    const id = randomId("whk_", 12), secret = newSecret();
    const h = { id, url: body.url, description: body.description || "", events: body.events, enabled: body.enabled };
    const tx = new Tx(ctx);
    tx.run("INSERT INTO webhooks (id, url, description, events, secret_enc, enabled, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, h.url, h.description, JSON.stringify(h.events), await encrypt(ctx.env.ENCRYPTION_KEY, secret, `webhook:${id}`), h.enabled ? 1 : 0, ctx.now, ctx.now, ctx.actor.name);
    tx.audit({ action: "webhook.create", resourceType: "webhook", resourceId: id, label: h.url, after: h, changes: diff({}, { ...h, secret: "x" }) });
    await tx.commit();
    return ctx.dryRun ? h : reply({ webhook: hookOut({ ...h, events: JSON.stringify(h.events), failure_count: 0, created_at: ctx.now, updated_at: ctx.now, version: 1 }), secret, note: "Shown once. Signature: X-TinyComet-Signature: t=<unix>,v1=hex(HMAC-SHA256(secret, `${t}.${body}`))" }, { status: 201 });
  }
});
const getHook = async (ctx, id) => { const h = await ctx.env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(id).first(); if (!h) throw notFound("Webhook"); return h; };
route({ method: "GET", path: "/webhooks/{id}", op: "webhooks.get", tag: T, perm: "webhooks:read", resource: "webhook", summary: "One subscription.", handler: async (ctx, { params }) => { const h = await getHook(ctx, params.id); ctx.etag = etag(h.version); return hookOut(h); } });
route({
  method: "PATCH", path: "/webhooks/{id}", op: "webhooks.update", tag: T, perm: "webhooks:manage", resource: "webhook", destructive: false, summary: "Change URL, events, description or enabled.",
  body: S.obj({ url: S.str(2000, { minLength: 8 }), description: S.str(300), events: eventsSchema, enabled: S.bool() }),
  handler: async (ctx, { params, body }) => {
    const h = await getHook(ctx, params.id);
    checkIfMatch(ctx, h.version);
    if (body.url) urlCheck(ctx, body.url);
    if (body.events) checkEvents(body.events);
    const before = hookOut(h), after = { ...before, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
    const changes = diff(before, after);
    if (!changes.length) return before;
    const tx = new Tx(ctx);
    tx.run("UPDATE webhooks SET url = ?, description = ?, events = ?, enabled = ?, failure_count = CASE WHEN ? = 1 THEN 0 ELSE failure_count END, version = version + 1, updated_at = ? WHERE id = ?", after.url, after.description, JSON.stringify(after.events), after.enabled ? 1 : 0, after.enabled && !h.enabled ? 1 : 0, ctx.now, h.id);
    tx.audit({ action: "webhook.update", resourceType: "webhook", resourceId: h.id, label: after.url, before, after, changes });
    await tx.commit();
    return { ...after, version: h.version + 1 };
  }
});
route({
  method: "DELETE", path: "/webhooks/{id}", op: "webhooks.delete", tag: T, perm: "webhooks:manage", resource: "webhook", summary: "Delete a subscription (its delivery log is kept).",
  handler: async (ctx, { params }) => {
    const h = await getHook(ctx, params.id);
    const tx = new Tx(ctx);
    tx.run("DELETE FROM webhooks WHERE id = ?", h.id);
    tx.run("UPDATE webhook_deliveries SET status = 'failed', response_excerpt = 'webhook deleted' WHERE webhook_id = ? AND status = 'pending'", h.id);
    tx.audit({ action: "webhook.delete", resourceType: "webhook", resourceId: h.id, label: h.url, before: hookOut(h) });
    await tx.commit();
    return { deleted: h.id };
  }
});
route({
  method: "POST", path: "/webhooks/{id}/rotate-secret", op: "webhooks.rotate_secret", tag: T, perm: "webhooks:manage", resource: "webhook", stepUp: true, destructive: false, summary: "New signing secret (shown once; the old one stops immediately).",
  handler: async (ctx, { params }) => {
    const h = await getHook(ctx, params.id);
    const secret = newSecret();
    const tx = new Tx(ctx);
    tx.run("UPDATE webhooks SET secret_enc = ?, version = version + 1, updated_at = ? WHERE id = ?", await encrypt(ctx.env.ENCRYPTION_KEY, secret, `webhook:${h.id}`), ctx.now, h.id);
    tx.audit({ action: "webhook.rotate_secret", resourceType: "webhook", resourceId: h.id, label: h.url, changes: [{ path: "secret", op: "changed", old: "[redacted]", new: "[redacted: changed]" }] });
    await tx.commit();
    return ctx.dryRun ? {} : { secret };
  }
});
route({
  method: "POST", path: "/webhooks/{id}/test", op: "webhooks.test", tag: T, perm: "webhooks:manage", resource: "webhook", destructive: false, dryRun: false, summary: "Send a signed webhook.test event now and return the delivery result.",
  handler: async (ctx, { params }) => {
    const h = await getHook(ctx, params.id);
    const id = randomId("dlv_", 16);
    const payload = { id, event: "webhook.test", created_at: iso(ctx.now), data: { message: "Hello from Tiny Comet Studio 👋", webhook_id: h.id }, actor: { type: ctx.actor.type, id: ctx.actor.id, name: ctx.actor.name } };
    const tx = new Tx(ctx);
    tx.run("INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'webhook.test', ?, 'pending', 0, ?, ?, ?)", id, h.id, JSON.stringify(payload), ctx.now, ctx.now, ctx.now);
    tx.audit({ action: "webhook.test", resourceType: "webhook", resourceId: h.id, label: h.url });
    await tx.commit();
    await attemptDelivery(ctx.env, id, ctx.now);
    return delOut(await ctx.env.DB.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").bind(id).first());
  }
});
route({
  method: "GET", path: "/webhooks/{id}/deliveries", op: "webhooks.deliveries", tag: T, perm: "webhooks:read", resource: "webhook", summary: "Delivery log (newest first).",
  query: S.obj({ status: S.enumOf(["pending", "success", "failed"]), limit: S.int(1, 200), cursor: S.str(200) }),
  handler: async (ctx, { params, query }) => {
    let { results } = await ctx.env.DB.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 2000").bind(params.id).all();
    if (query.status) results = results.filter((d) => d.status === query.status);
    const { page, meta } = paginate(results.map(delOut), query);
    return reply(page, { meta });
  }
});
route({
  method: "POST", path: "/webhook-deliveries/{id}/redeliver", op: "webhooks.redeliver", tag: T, perm: "webhooks:manage", resource: "webhook", destructive: false, dryRun: false, summary: "Retry a delivery now (same payload, new signature).",
  handler: async (ctx, { params }) => {
    const d = await ctx.env.DB.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").bind(params.id).first();
    if (!d) throw notFound("Delivery");
    const tx = new Tx(ctx);
    tx.run("UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = ?, attempts = CASE WHEN attempts >= 6 THEN 5 ELSE attempts END, updated_at = ? WHERE id = ?", ctx.now, ctx.now, d.id);
    tx.audit({ action: "webhook.redeliver", resourceType: "webhook", resourceId: d.webhook_id, label: `${d.event} ${d.id}` });
    await tx.commit();
    await attemptDelivery(ctx.env, d.id, ctx.now);
    return delOut(await ctx.env.DB.prepare("SELECT * FROM webhook_deliveries WHERE id = ?").bind(d.id).first());
  }
});

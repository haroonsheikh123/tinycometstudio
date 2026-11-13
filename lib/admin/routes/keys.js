/* API keys (for apps & cloud agents) and the human approval queue. */
import { route, reply, match } from "../router.js";
import { S } from "../schema.js";
import { ApiError, notFound, forbidden, validCidr } from "../http.js";
import { Tx } from "../tx.js";
import { randomId } from "../crypto.js";
import { generateApiKey } from "../auth.js";
import { diff } from "../audit.js";
import { j } from "../content.js";
import { getState } from "../state.js";
import { invalidPermissions, missingForGrant, rolePermissions, can, grant as makeGrant } from "../permissions.js";
import { loadRole } from "./users.js";
import { paginate, checkIfMatch, etag, iso, parseTime } from "./_util.js";

const TK = "API keys", TA = "Approvals";
const ENVIRONMENTS = ["production", "preview", "development"];

export const keyOut = (k, owners = {}) => k && ({
  id: k.id, name: k.name, description: k.description, prefix: k.prefix, scopes: j(k.scopes, []), role_id: k.role_id,
  owner_user_id: k.owner_user_id, owner_name: owners[k.owner_user_id] || null,
  expires_at: iso(k.expires_at), ip_allowlist: j(k.ip_allowlist, []), rate_limit: k.rate_limit, environments: j(k.environments, []),
  enabled: !!k.enabled, require_approval: !!k.require_approval, force_dry_run: !!k.force_dry_run,
  status: k.revoked_at ? "revoked" : !k.enabled ? "disabled" : k.expires_at && k.expires_at <= Date.now() ? "expired" : "active",
  revoked_at: iso(k.revoked_at), rotation_grace_until: k.prev_valid_until && k.prev_valid_until > Date.now() ? iso(k.prev_valid_until) : null,
  last_used_at: iso(k.last_used_at), last_used_ip: k.last_used_ip, usage_count: k.usage_count, created_at: iso(k.created_at), updated_at: iso(k.updated_at), version: k.version
});

const keyFields = {
  name: S.str(80, { minLength: 1 }), description: S.str(500),
  scopes: S.arr({ type: "string", maxLength: 40 }, 200, { uniqueItems: true, description: "e.g. games:read, news:publish, analytics:read, games:write, news:*  ('*' = everything, owner only)" }),
  role_id: { type: ["string", "null"], maxLength: 64, description: "Optional: the key also gets this role's permissions" },
  expires_at: { type: ["string", "null"], format: "date-time", description: "ISO 8601; null = never" },
  ip_allowlist: S.arr({ type: "string", maxLength: 50 }, 50, { description: "IPs or CIDRs (IPv4/IPv6). Empty = any IP." }),
  rate_limit: S.int(1, 10_000, { description: "Requests per minute" }),
  environments: S.arr(S.enumOf(ENVIRONMENTS), 3, { uniqueItems: true, minItems: 1 }),
  enabled: S.bool(), require_approval: S.bool({ description: "Destructive calls (delete/publish/manage) wait in the approval queue for a human" }),
  force_dry_run: S.bool({ description: "Every write is only previewed (X-Dry-Run forced on)" })
};

async function checkKeyGrant(ctx, body, ownerIsOwner) {
  const scopes = body.scopes || [];
  const bad = invalidPermissions(scopes, { allowStar: true });
  if (bad.length) throw new ApiError(400, "validation_failed", `Unknown scopes: ${bad.join(", ")}`, { invalid: bad });
  if (scopes.includes("*") && !ownerIsOwner) throw forbidden("Only the owner can create keys with the '*' scope");
  const missing = missingForGrant(ctx.grant, scopes.filter((s) => s !== "*"));
  if (scopes.includes("*") && !ctx.grant.all) missing.push("*");
  let role = null;
  if (body.role_id) {
    role = await loadRole(ctx.env.DB, body.role_id);
    if (!role) throw new ApiError(400, "validation_failed", `Unknown role "${body.role_id}"`);
    if (role.id === "owner") throw forbidden("Keys can't hold the owner role — use the '*' scope (owner only)");
    missing.push(...missingForGrant(ctx.grant, rolePermissions(role), role.game_scope));
  }
  if (missing.length) throw forbidden(`A key can't have more access than you: missing ${[...new Set(missing)].join(", ")}`, { missing: [...new Set(missing)] });
  if (!scopes.length && !role) throw new ApiError(400, "validation_failed", "Give the key at least one scope or a role");
  for (const c of body.ip_allowlist || []) if (!validCidr(c)) throw new ApiError(400, "validation_failed", `Invalid IP/CIDR: ${c}`);
}

const canManageAll = (ctx) => can(ctx.grant, "api_keys:manage");
async function getKey(ctx, id) {
  const k = await ctx.env.DB.prepare("SELECT * FROM api_keys WHERE id = ?").bind(id).first();
  if (!k) throw notFound("API key");
  if (k.owner_user_id !== ctx.user.id && !canManageAll(ctx)) throw notFound("API key");
  return k;
}

route({
  method: "GET", path: "/api-keys", op: "api_keys.list", tag: TK, perm: "api_keys:read", resource: "api_key", summary: "List API keys (yours; everyone's with api_keys:manage). Secrets are never returned.",
  query: S.obj({ status: S.enumOf(["active", "revoked", "disabled", "expired", "all"]), owner: S.str(40), limit: S.int(1, 200), cursor: S.str(200) }),
  handler: async (ctx, { query }) => {
    const db = ctx.env.DB;
    const { results } = canManageAll(ctx) ? await db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() : await db.prepare("SELECT * FROM api_keys WHERE owner_user_id = ? ORDER BY created_at DESC").bind(ctx.user.id).all();
    const { results: us } = await db.prepare("SELECT id, name FROM users").all();
    const owners = Object.fromEntries(us.map((u) => [u.id, u.name]));
    let items = results.map((k) => keyOut(k, owners));
    if (query.owner) items = items.filter((k) => k.owner_user_id === query.owner);
    const st = query.status || "all";
    if (st !== "all") items = items.filter((k) => k.status === st);
    const { page, meta } = paginate(items, query);
    const ks = await getState(db, ["kill_switch"]);
    return reply(page, { meta: { ...meta, kill_switch: !!ks.kill_switch?.enabled } });
  }
});

route({
  method: "POST", path: "/api-keys", op: "api_keys.create", tag: TK, perm: "api_keys:create", stepUp: true, resource: "api_key",
  summary: "Create a key. The secret is returned ONCE in `secret` — store it safely. Scopes can't exceed your own access.",
  body: S.obj({ ...keyFields, rate_limit: { ...keyFields.rate_limit, default: 60 }, environments: { ...keyFields.environments, default: ENVIRONMENTS }, ip_allowlist: { ...keyFields.ip_allowlist, default: [] }, scopes: { ...keyFields.scopes, default: [] }, owner_user_id: S.str(40) }, ["name"]),
  handler: async (ctx, { body }) => {
    const db = ctx.env.DB;
    let ownerId = ctx.user.id;
    if (body.owner_user_id && body.owner_user_id !== ctx.user.id) {
      if (!canManageAll(ctx)) throw forbidden("api_keys:manage is needed to create keys for someone else");
      throw new ApiError(400, "validation_failed", "Keys are always owned by their creator (their access is capped by the creator's). Ask that person to create it.");
    }
    await checkKeyGrant(ctx, body, ctx.isOwner);
    const expires = parseTime(body.expires_at, "expires_at");
    if (expires && expires <= ctx.now) throw new ApiError(400, "validation_failed", "expires_at must be in the future");
    const { key, prefix, hash } = await generateApiKey();
    const id = randomId("key_", 12);
    const row = { id, name: body.name, description: body.description || "", prefix, scopes: body.scopes, role_id: body.role_id || null, owner_user_id: ownerId, expires_at: expires,
      ip_allowlist: body.ip_allowlist, rate_limit: body.rate_limit, environments: body.environments, enabled: body.enabled !== false, require_approval: !!body.require_approval, force_dry_run: !!body.force_dry_run };
    const tx = new Tx(ctx);
    tx.run(`INSERT INTO api_keys (id, name, description, prefix, key_hash, scopes, role_id, owner_user_id, expires_at, ip_allowlist, rate_limit, environments, enabled, require_approval, force_dry_run, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, row.name, row.description, prefix, hash, JSON.stringify(row.scopes), row.role_id, ownerId, expires,
      JSON.stringify(row.ip_allowlist), row.rate_limit, JSON.stringify(row.environments), row.enabled ? 1 : 0, row.require_approval ? 1 : 0, row.force_dry_run ? 1 : 0, ctx.now, ctx.now);
    tx.audit({ action: "api_key.create", resourceType: "api_key", resourceId: id, label: row.name, after: { ...row, expires_at: iso(expires) }, changes: diff({}, { ...row, expires_at: iso(expires), secret: "x" }) });
    tx.event("api_key.created", { id, name: row.name, prefix, scopes: row.scopes });
    await tx.commit();
    const out = keyOut({ ...row, scopes: JSON.stringify(row.scopes), ip_allowlist: JSON.stringify(row.ip_allowlist), environments: JSON.stringify(row.environments), usage_count: 0, version: 1, created_at: ctx.now, updated_at: ctx.now });
    if (ctx.dryRun) return { api_key: out };
    return reply({ api_key: out, secret: key, note: "This is the only time the secret is shown. Send it as: Authorization: Bearer <secret>" }, { status: 201 });
  }
});

route({
  method: "GET", path: "/api-keys/{id}", op: "api_keys.get", tag: TK, perm: "api_keys:read", resource: "api_key", summary: "Get one key (no secret).",
  handler: async (ctx, { params }) => { const k = await getKey(ctx, params.id); ctx.etag = etag(k.version); return keyOut(k); }
});

route({
  method: "PATCH", path: "/api-keys/{id}", op: "api_keys.update", tag: TK, perm: (ctx, { body }) => ["api_keys:update"], resource: "api_key",
  summary: "Change a key's name, scopes, expiry, IP allowlist, rate limit, environments, enable/disable, approval and dry-run flags.",
  body: S.obj(keyFields),
  handler: async (ctx, { params, body }) => {
    const k = await getKey(ctx, params.id);
    if (k.revoked_at) throw new ApiError(409, "conflict", "This key was revoked");
    checkIfMatch(ctx, k.version);
    const before = keyOut(k);
    const next = { ...before };
    for (const [f, v] of Object.entries(body)) if (v !== undefined) next[f] = v;
    if (body.scopes || body.role_id !== undefined) {
      if (ctx.actor.type === "user" && ctx.now - ctx.session.stepup_at > 10 * 60_000) throw new ApiError(403, "step_up_required", "Confirm with your authenticator code to change a key's access");
      const owner = await ctx.env.DB.prepare("SELECT role_id FROM users WHERE id = ?").bind(k.owner_user_id).first();
      await checkKeyGrant(ctx, { scopes: next.scopes, role_id: next.role_id, ip_allowlist: next.ip_allowlist }, owner?.role_id === "owner" && ctx.isOwner);
    } else for (const c of next.ip_allowlist || []) if (!validCidr(c)) throw new ApiError(400, "validation_failed", `Invalid IP/CIDR: ${c}`);
    // Loosening a key you can't use yourself is not allowed: re-enabling, removing approval or dry-run need your access too
    if ((body.enabled === true || body.require_approval === false || body.force_dry_run === false) && k.owner_user_id !== ctx.user.id) {
      const missing = missingForGrant(ctx.grant, j(k.scopes, []).filter((s) => s !== "*"));
      if (missing.length) throw forbidden("You can't loosen a key that has more access than you", { missing });
    }
    const expires = body.expires_at !== undefined ? parseTime(body.expires_at, "expires_at") : k.expires_at;
    next.expires_at = iso(expires);
    const changes = diff(before, next);
    if (!changes.length) return before;
    const tx = new Tx(ctx);
    tx.guard("SELECT 1 FROM api_keys WHERE id = ? AND version = ?", [k.id, k.version]);
    tx.run("UPDATE api_keys SET name = ?, description = ?, scopes = ?, role_id = ?, expires_at = ?, ip_allowlist = ?, rate_limit = ?, environments = ?, enabled = ?, require_approval = ?, force_dry_run = ?, version = version + 1, updated_at = ? WHERE id = ?",
      next.name, next.description, JSON.stringify(next.scopes), next.role_id || null, expires, JSON.stringify(next.ip_allowlist), next.rate_limit, JSON.stringify(next.environments),
      next.enabled ? 1 : 0, next.require_approval ? 1 : 0, next.force_dry_run ? 1 : 0, ctx.now, k.id);
    tx.audit({ action: body.enabled === false ? "api_key.disable" : body.enabled === true && !k.enabled ? "api_key.enable" : "api_key.update", resourceType: "api_key", resourceId: k.id, label: next.name, before, after: next, changes });
    await tx.commit();
    return { ...next, version: k.version + 1 };
  }
});

route({
  method: "POST", path: "/api-keys/{id}/rotate", op: "api_keys.rotate", tag: TK, perm: "api_keys:update", stepUp: true, resource: "api_key", destructive: false,
  summary: "Issue a new secret. The old one keeps working for `grace_hours` (0–168) so deployments can switch over. New secret shown once.",
  body: S.obj({ grace_hours: S.int(0, 168, { default: 24 }) }),
  handler: async (ctx, { params, body }) => {
    const k = await getKey(ctx, params.id);
    if (k.revoked_at) throw new ApiError(409, "conflict", "This key was revoked");
    const { key: full, hash: fullHash } = await generateApiKey(k.prefix);
    const until = body.grace_hours ? ctx.now + body.grace_hours * 3_600_000 : null;
    const tx = new Tx(ctx);
    tx.run("UPDATE api_keys SET prev_key_hash = ?, prev_valid_until = ?, key_hash = ?, version = version + 1, updated_at = ? WHERE id = ?", until ? k.key_hash : null, until, fullHash, ctx.now, k.id);
    tx.audit({ action: "api_key.rotate", resourceType: "api_key", resourceId: k.id, label: k.name, changes: [{ path: "secret", op: "changed", old: "[redacted]", new: "[redacted: changed]" }], meta: { grace_hours: body.grace_hours, old_secret_valid_until: iso(until) } });
    await tx.commit();
    return ctx.dryRun ? { api_key: keyOut(k) } : { api_key: keyOut({ ...k, prev_valid_until: until, version: k.version + 1 }), secret: full, old_secret_valid_until: iso(until) };
  }
});

async function revoke(ctx, params) {
  const k = await getKey(ctx, params.id);
  if (k.revoked_at) return keyOut(k);
  const tx = new Tx(ctx);
  tx.run("UPDATE api_keys SET revoked_at = ?, enabled = 0, prev_key_hash = NULL, prev_valid_until = NULL, version = version + 1, updated_at = ? WHERE id = ?", ctx.now, ctx.now, k.id);
  tx.audit({ action: "api_key.revoke", resourceType: "api_key", resourceId: k.id, label: k.name, changes: [{ path: "status", op: "changed", old: keyOut(k).status, new: "revoked" }] });
  tx.event("api_key.revoked", { id: k.id, name: k.name, prefix: k.prefix });
  await tx.commit();
  return keyOut({ ...k, revoked_at: ctx.now, enabled: 0 });
}
route({ method: "POST", path: "/api-keys/{id}/revoke", op: "api_keys.revoke", tag: TK, perm: "api_keys:delete", resource: "api_key", summary: "Revoke a key permanently (immediate).", handler: (ctx, { params }) => revoke(ctx, params) });
route({ method: "DELETE", path: "/api-keys/{id}", op: "api_keys.delete", tag: TK, perm: "api_keys:delete", resource: "api_key", summary: "Same as revoke (keys are kept for the audit trail).", handler: (ctx, { params }) => revoke(ctx, params) });

/* ---------------------------------------------------------------- approvals */
const approvalOut = (a) => a && ({
  id: a.id, status: a.status, operation: a.operation, method: a.method, path: a.path, body: j(a.body), preview: j(a.preview), reason: a.reason,
  api_key_id: a.api_key_id, requested_by: j(a.requested_by), created_at: iso(a.created_at), expires_at: iso(a.expires_at),
  decided_at: iso(a.decided_at), decided_by: j(a.decided_by), decision_note: a.decision_note, result: j(a.result)
});

/** Called by the pipeline instead of the handler when a key requires approval for a destructive call. */
export async function queueApproval(ctx, route, params, url, body) {
  const { runRoute } = await import("../api.js");
  // Preview first (dry run, not audited separately) — invalid requests fail now, not at approval time.
  const pctx = { ...ctx, dryRun: true, auditDryRuns: false, txs: [] };
  await runRoute(pctx, route, params, url.searchParams, body);
  const preview = pctx.txs.flatMap((t) => t.audits.map((a) => ({ action: a.action, resource_type: a.resource_type, resource_id: a.resource_id, label: a.resource_label, changes: a.changes })));
  const id = randomId("apr_", 12);
  const headers = { "If-Match": ctx.ifMatch || undefined, "X-Change-Reason": ctx.changeReason || undefined, "X-Agent-Name": ctx.agentName || undefined };
  const tx = new Tx(ctx);
  tx.run("INSERT INTO approvals (id, status, api_key_id, requested_by, operation, method, path, body, headers, preview, reason, created_at, expires_at) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id, ctx.key.id, JSON.stringify(ctx.actor), route.op, route.method, url.pathname + url.search, JSON.stringify(body ?? null), JSON.stringify(headers), JSON.stringify(preview), ctx.changeReason, ctx.now, ctx.now + 7 * 86_400_000);
  tx.audit({ action: "approval.request", result: "pending_approval", resourceType: "approval", resourceId: id, label: `${route.op} ${preview[0]?.label || ""}`.trim(), meta: { operation: route.op, path: url.pathname, preview } });
  tx.event("approval.requested", { id, operation: route.op, path: url.pathname, api_key_id: ctx.key.id });
  await tx.commit();
  return { data: { approval: { id, status: "pending", operation: route.op, preview } }, meta: { approval_required: true, message: "A human admin must approve this in the admin panel (Approvals) before it runs." } };
}

route({
  method: "GET", path: "/approvals", op: "approvals.list", tag: TA, perm: "approvals:read", resource: "approval", summary: "Queued API-key requests awaiting a human decision.",
  query: S.obj({ status: S.enumOf(["pending", "approved", "rejected", "expired", "failed", "all"]), limit: S.int(1, 200), cursor: S.str(200) }),
  handler: async (ctx, { query }) => {
    const st = query.status || "pending";
    const { results } = st === "all" ? await ctx.env.DB.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 1000").all() : await ctx.env.DB.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 1000").bind(st).all();
    const { page, meta } = paginate(results.map(approvalOut), query);
    return reply(page, { meta });
  }
});
route({
  method: "GET", path: "/approvals/{id}", op: "approvals.get", tag: TA, perm: "approvals:read", resource: "approval", summary: "One approval request with its dry-run preview.",
  handler: async (ctx, { params }) => { const a = await ctx.env.DB.prepare("SELECT * FROM approvals WHERE id = ?").bind(params.id).first(); if (!a) throw notFound("Approval"); return approvalOut(a); }
});

async function decide(ctx, params, body, approve) {
  const db = ctx.env.DB;
  const a = await db.prepare("SELECT * FROM approvals WHERE id = ?").bind(params.id).first();
  if (!a) throw notFound("Approval");
  if (a.status !== "pending") throw new ApiError(409, "conflict", `Already ${a.status}`);
  if (a.expires_at < ctx.now) throw new ApiError(409, "conflict", "This request expired");
  const decidedBy = { id: ctx.actor.id, name: ctx.actor.name, email: ctx.actor.email };
  if (!approve) {
    const tx = new Tx(ctx);
    tx.guard("SELECT 1 FROM approvals WHERE id = ? AND status = 'pending'", [a.id], "Already decided");
    tx.run("UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ?", ctx.now, JSON.stringify(decidedBy), body.note || null, a.id);
    tx.audit({ action: "approval.reject", resourceType: "approval", resourceId: a.id, label: a.operation, reason: body.note || ctx.changeReason, changes: [{ path: "status", op: "changed", old: "pending", new: "rejected" }] });
    tx.event("approval.decided", { id: a.id, status: "rejected", operation: a.operation });
    await tx.commit();
    return approvalOut({ ...a, status: "rejected", decided_at: ctx.now, decided_by: JSON.stringify(decidedBy), decision_note: body.note || null });
  }
  // Replay the original request as the key, with the approver recorded.
  const key = await db.prepare("SELECT * FROM api_keys WHERE id = ?").bind(a.api_key_id).first();
  const ks = await getState(db, ["kill_switch"]);
  if (!key || key.revoked_at || !key.enabled || (key.expires_at && key.expires_at <= ctx.now)) throw new ApiError(409, "conflict", "The requesting API key is no longer valid");
  if (ks.kill_switch?.enabled) throw new ApiError(409, "conflict", "API-key access is switched off (kill switch)");
  const { baseContext, loadKeyPrincipal, runRoute } = await import("../api.js");
  const url = new URL(a.path, ctx.url.origin);
  const { route: r, params: p } = match(a.method, url.pathname.replace(/^\/api\/v1/, ""));
  if (!r) throw new ApiError(409, "conflict", "The requested endpoint no longer exists");
  // The approver must be allowed to do the operation themselves.
  const perms = [].concat(typeof r.perm === "function" ? r.perm(ctx, { params: p, body: j(a.body) || {}, query: {} }) : r.perm || []);
  const lacking = perms.filter((x) => !can(ctx.grant, x, { gameId: r.gameParam ? p[r.gameParam] : undefined }));
  if (lacking.length) throw forbidden(`You can only approve what you could do yourself (missing ${lacking.join(", ")})`);
  const hdr = j(a.headers, {});
  const rctx = baseContext({ request: new Request(url, { method: a.method, headers: Object.fromEntries(Object.entries(hdr).filter(([, v]) => v)) }), env: ctx.env, waitUntil: ctx.waitUntil });
  Object.assign(rctx, { ip: ctx.ip, country: ctx.country, city: ctx.city, ua: ctx.ua, device: ctx.device, route: `${r.method} /api/v1${r.path}`, op: r.op, ifMatch: hdr["If-Match"] || null, changeReason: hdr["X-Change-Reason"] || a.reason || null, agentName: hdr["X-Agent-Name"] || null });
  await loadKeyPrincipal(rctx, key);
  rctx.approval = { id: a.id, by: decidedBy };
  let result, status = "approved", err = null;
  try { result = await runRoute(rctx, r, p, url.searchParams, j(a.body)); } // entries get meta.approval_id/approved_by (see makeEntry)
  catch (e) { status = "failed"; err = e; }
  const out = status === "approved" ? (result?.$reply ? result.data : result) : { error: { code: err.code || "internal_error", message: err.message } };
  const tx = new Tx(ctx);
  tx.run("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, result = ? WHERE id = ? AND status = 'pending'", status, ctx.now, JSON.stringify(decidedBy), body.note || null, JSON.stringify(out ?? null).slice(0, 100_000), a.id);
  tx.audit({ action: "approval.approve", result: status === "approved" ? "success" : "error", resultReason: err ? err.message : null, resourceType: "approval", resourceId: a.id, label: a.operation, reason: body.note || ctx.changeReason, changes: [{ path: "status", op: "changed", old: "pending", new: status }] });
  tx.event("approval.decided", { id: a.id, status, operation: a.operation });
  await tx.commit();
  return approvalOut({ ...a, status, decided_at: ctx.now, decided_by: JSON.stringify(decidedBy), decision_note: body.note || null, result: JSON.stringify(out ?? null) });
}
route({ method: "POST", path: "/approvals/{id}/approve", op: "approvals.approve", tag: TA, perm: "approvals:manage", auth: "session", stepUp: true, dryRun: false, resource: "approval", summary: "Approve and run a queued request (you must be allowed to do it yourself).", body: S.obj({ note: S.str(1000) }), handler: (ctx, { params, body }) => decide(ctx, params, body, true) });
route({ method: "POST", path: "/approvals/{id}/reject", op: "approvals.reject", tag: TA, perm: "approvals:manage", auth: "session", dryRun: false, resource: "approval", summary: "Reject a queued request.", body: S.obj({ note: S.str(1000) }), handler: (ctx, { params, body }) => decide(ctx, params, body, false) });

export { makeGrant };

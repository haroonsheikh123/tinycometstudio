/* Users (child accounts), roles (built-in + custom), permission catalogue. */
import { route, reply } from "../router.js";
import { S } from "../schema.js";
import { ApiError, notFound, forbidden } from "../http.js";
import { Tx } from "../tx.js";
import { randomId } from "../crypto.js";
import { prepareToken } from "../auth.js";
import { diff } from "../audit.js";
import { j } from "../content.js";
import { RESOURCES, ACTIONS, BUILTIN_ROLES, OWNER_ONLY, roleGrant, grant as makeGrant, missingForGrant, isSubset, invalidPermissions, toList, rolePermissions } from "../permissions.js";
import { publicUser, activeSessions } from "./auth.js";
import { paginate, checkIfMatch, etag, iso } from "./_util.js";
import { sendEmail } from "../email.js";

const TU = "Users", TR = "Roles";
const INVITE_TTL = 7 * 86_400_000, RESET_TTL = 24 * 3_600_000, ENROLL_LINK_TTL = 72 * 3_600_000;

export const roleOut = (r, counts = {}) => r && ({
  id: r.id, name: r.name, description: r.description, builtin: !!r.builtin,
  permissions: r.builtin ? rolePermissions({ ...r, builtin: 1 }) : j(r.permissions, []),
  game_scope: r.builtin ? null : j(r.game_scope, null), users: counts[r.id] || 0, version: r.version, updated_at: iso(r.updated_at)
});
async function loadRole(db, id) {
  const r = await db.prepare("SELECT * FROM roles WHERE id = ?").bind(id).first();
  return r && { ...r, permissions: j(r.permissions, []), game_scope: j(r.game_scope, null) };
}
const grantOfRole = (r) => (r.id === "owner" ? makeGrant(["*"]) : roleGrant(r));
const linkFor = (ctx, kind, token) => `${ctx.url.origin}/admin/${kind}#${token}`;

/** The actor may only manage users whose access is ⊆ their own (owners manage everyone). */
async function assertCanManage(ctx, target) {
  if (target.role_id === "owner" && !ctx.isOwner) throw forbidden("Only an owner can change an owner account");
  if (ctx.isOwner) return;
  const r = await loadRole(ctx.env.DB, target.role_id);
  if (r && !isSubset(grantOfRole(r), ctx.grant)) throw forbidden("You can't manage someone who has more access than you");
}
async function assertCanAssign(ctx, roleId) {
  if (roleId === "owner") throw forbidden("Ownership can only be given with POST /users/{id}/transfer-ownership");
  const r = await loadRole(ctx.env.DB, roleId);
  if (!r) throw new ApiError(400, "validation_failed", `Unknown role "${roleId}"`);
  const missing = missingForGrant(ctx.grant, rolePermissions(r), r.game_scope);
  if (missing.length) throw forbidden(`You can't give a role with more access than you have (missing: ${missing.join(", ")})`, { missing });
  return r;
}

route({
  method: "GET", path: "/users", op: "users.list", tag: TU, perm: "users:read", resource: "user", summary: "List users.",
  query: S.obj({ status: S.enumOf(["invited", "active", "suspended", "removed"]), role_id: S.str(64), q: S.str(100), limit: S.int(1, 200), cursor: S.str(200) }),
  handler: async (ctx, { query }) => {
    let { results } = await ctx.env.DB.prepare("SELECT * FROM users ORDER BY created_at").all();
    if (query.status) results = results.filter((u) => u.status === query.status);
    else results = results.filter((u) => u.status !== "removed");
    if (query.role_id) results = results.filter((u) => u.role_id === query.role_id);
    if (query.q) { const q = query.q.toLowerCase(); results = results.filter((u) => u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)); }
    const { page, meta } = paginate(results.map(publicUser), query);
    return reply(page, { meta });
  }
});

route({
  method: "POST", path: "/users", op: "users.invite", tag: TU, perm: "users:create", stepUp: true, resource: "user",
  summary: "Invite a child user. Returns a one-time invite link (shown once; also emailed if an email provider is configured).",
  body: S.obj({ email: { type: "string", format: "email", maxLength: 254 }, name: S.str(100, { minLength: 1 }), role_id: S.slug() }, ["email", "name", "role_id"]),
  handler: async (ctx, { body }) => {
    const db = ctx.env.DB;
    await assertCanAssign(ctx, body.role_id);
    const email = body.email.toLowerCase();
    const exists = await db.prepare("SELECT id, status FROM users WHERE email = ?").bind(email).first();
    if (exists && exists.status !== "removed") throw new ApiError(409, "conflict", "A user with this email already exists");
    const id = exists?.id || randomId("usr_", 12);
    const tok = await prepareToken(ctx.env, "invite", id, INVITE_TTL, ctx.actor.id, ctx.now);
    const user = { id, email, name: body.name.trim(), role_id: body.role_id, status: "invited" };
    const tx = new Tx(ctx);
    if (exists) tx.run("UPDATE users SET name = ?, role_id = ?, status = 'invited', password_hash = NULL, totp_enabled = 0, totp_secret_enc = NULL, recovery_codes = NULL, version = version + 1, updated_at = ? WHERE id = ?", user.name, user.role_id, ctx.now, id);
    else tx.run("INSERT INTO users (id, email, name, role_id, status, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, 'invited', ?, ?, ?)", id, email, user.name, user.role_id, ctx.now, ctx.now, ctx.actor.id);
    tx.stmts.push(tok.stmt);
    tx.audit({ action: "user.invite", resourceType: "user", resourceId: id, label: email, after: user, changes: Object.entries(user).map(([k, v]) => ({ path: k, op: "added", new: v })) });
    tx.event("user.created", { id, email, name: user.name, role_id: user.role_id });
    await tx.commit();
    if (ctx.dryRun) return { user };
    const url = linkFor(ctx, "invite", tok.token);
    const sent = await sendEmail(ctx.env, { to: email, subject: "You're invited to the Tiny Comet Studio admin", text: `Hi ${user.name},\n\n${ctx.actor.name} invited you to the Tiny Comet Studio admin.\nSet your password and connect your authenticator app here (valid 7 days, one use):\n\n${url}\n` });
    return reply({ user: publicUser({ ...user, created_at: ctx.now, updated_at: ctx.now, version: 1 }), invite_url: url, invite_expires_at: iso(tok.expiresAt), email_sent: sent }, { status: 201 });
  }
});

const getUser = async (db, id) => { const u = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first(); if (!u) throw notFound("User"); return u; };

route({
  method: "GET", path: "/users/{id}", op: "users.get", tag: TU, perm: "users:read", resource: "user", summary: "Get a user.",
  handler: async (ctx, { params }) => { const u = await getUser(ctx.env.DB, params.id); ctx.etag = etag(u.version); return publicUser(u); }
});

route({
  method: "PATCH", path: "/users/{id}", op: "users.update", tag: TU, resource: "user",
  perm: (ctx, { body }) => ["users:update", ...(body.status ? ["users:manage"] : [])],
  summary: "Update name / role / status (active ↔ suspended). Role changes need step-up and can't exceed your own access.",
  body: S.obj({ name: S.str(100, { minLength: 1 }), role_id: S.slug(), status: S.enumOf(["active", "suspended"]) }),
  handler: async (ctx, { params, body }) => {
    const db = ctx.env.DB;
    const u = await getUser(db, params.id);
    checkIfMatch(ctx, u.version);
    if (u.status === "removed") throw new ApiError(409, "conflict", "This user was removed");
    await assertCanManage(ctx, u);
    if ((body.role_id && body.role_id !== u.role_id) || body.status) {
      if (u.id === ctx.user.id) throw forbidden("You can't change your own role or status");
      if (ctx.actor.type === "user" && ctx.now - ctx.session.stepup_at > 10 * 60_000) throw new ApiError(403, "step_up_required", "Confirm with your authenticator code to change roles or status");
    }
    if (body.role_id && body.role_id !== u.role_id) await assertCanAssign(ctx, body.role_id);
    if (body.status && u.status === "invited") throw new ApiError(409, "conflict", "The user hasn't accepted their invite yet");
    const before = publicUser(u);
    const next = { ...u, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
    const after = publicUser(next);
    const changes = diff(before, after);
    if (!changes.length) return before;
    const tx = new Tx(ctx);
    tx.guard("SELECT 1 FROM users WHERE id = ? AND version = ?", [u.id, u.version]);
    tx.run("UPDATE users SET name = ?, role_id = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?", next.name, next.role_id, next.status, ctx.now, u.id);
    if (next.status === "suspended") tx.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", ctx.now, u.id);
    tx.audit({ action: body.role_id && body.role_id !== u.role_id ? "user.role_change" : body.status ? `user.${body.status === "suspended" ? "suspend" : "reactivate"}` : "user.update", resourceType: "user", resourceId: u.id, label: u.email, before, after, changes });
    tx.event("user.updated", { id: u.id, changes: changes.map((c) => c.path) });
    await tx.commit();
    return { ...after, version: u.version + (ctx.dryRun ? 0 : 1) };
  }
});

route({
  method: "DELETE", path: "/users/{id}", op: "users.remove", tag: TU, perm: "users:delete", stepUp: true, resource: "user",
  summary: "Remove a user: signs them out everywhere and revokes their API keys. Owners can't be removed.",
  handler: async (ctx, { params }) => {
    const db = ctx.env.DB;
    const u = await getUser(db, params.id);
    if (u.role_id === "owner") throw forbidden("An owner can't be removed — transfer ownership first");
    if (u.id === ctx.user.id) throw forbidden("You can't remove yourself");
    await assertCanManage(ctx, u);
    const tx = new Tx(ctx);
    tx.run("UPDATE users SET status = 'removed', password_hash = NULL, totp_enabled = 0, totp_secret_enc = NULL, recovery_codes = NULL, version = version + 1, updated_at = ? WHERE id = ?", ctx.now, u.id);
    tx.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", ctx.now, u.id);
    tx.run("UPDATE api_keys SET revoked_at = ?, enabled = 0 WHERE owner_user_id = ? AND revoked_at IS NULL", ctx.now, u.id);
    tx.run("UPDATE tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL", ctx.now, u.id);
    tx.audit({ action: "user.remove", resourceType: "user", resourceId: u.id, label: u.email, before: publicUser(u), changes: [{ path: "status", op: "changed", old: u.status, new: "removed" }] });
    tx.event("user.removed", { id: u.id, email: u.email });
    await tx.commit();
    return { removed: u.id };
  }
});

async function issueLink(ctx, u, kind, ttl, action, extraSql = []) {
  const tok = await prepareToken(ctx.env, kind, u.id, ttl, ctx.actor.id, ctx.now);
  const tx = new Tx(ctx);
  tx.run("UPDATE tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL", ctx.now, u.id, kind);
  extraSql.forEach(([sql, ...p]) => tx.run(sql, ...p));
  tx.stmts.push(tok.stmt);
  return { tok, tx };
}

route({
  method: "POST", path: "/users/{id}/reset-2fa", op: "users.reset_2fa", tag: TU, perm: "users:manage", stepUp: true, resource: "user",
  summary: "Reset a user's authenticator: signs them out and returns a one-time enrollment link (they also need their password).",
  handler: async (ctx, { params }) => {
    const u = await getUser(ctx.env.DB, params.id);
    if (u.id === ctx.user.id) throw forbidden("Re-enroll your own authenticator from your account page");
    await assertCanManage(ctx, u);
    const { tok, tx } = await issueLink(ctx, u, "enroll", ENROLL_LINK_TTL, "user.reset_2fa", [
      ["UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_pending_enc = NULL, recovery_codes = NULL, totp_last_step = -1, version = version + 1, updated_at = ? WHERE id = ?", ctx.now, u.id],
      ["UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", ctx.now, u.id]
    ]);
    tx.audit({ action: "user.reset_2fa", resourceType: "user", resourceId: u.id, label: u.email, changes: [{ path: "mfa_enabled", op: "changed", old: !!u.totp_enabled, new: false }, { path: "totp_secret_enc", op: "removed", old: "[redacted]" }] });
    await tx.commit();
    if (ctx.dryRun) return { user: publicUser(u) };
    const url = linkFor(ctx, "enroll", tok.token);
    const sent = await sendEmail(ctx.env, { to: u.email, subject: "Set up your authenticator again", text: `Your two-factor authentication was reset by ${ctx.actor.name}. Set it up again here (valid 72 h, needs your password):\n\n${url}\n` });
    return { enroll_url: url, expires_at: iso(tok.expiresAt), email_sent: sent };
  }
});
route({
  method: "POST", path: "/users/{id}/reset-password", op: "users.reset_password", tag: TU, perm: "users:manage", stepUp: true, resource: "user",
  summary: "Issue a one-time password-reset link (24 h). Signs the user out everywhere.",
  handler: async (ctx, { params }) => {
    const u = await getUser(ctx.env.DB, params.id);
    if (u.status !== "active") throw new ApiError(409, "conflict", "Only active users can reset their password (resend the invite instead)");
    await assertCanManage(ctx, u);
    const { tok, tx } = await issueLink(ctx, u, "reset", RESET_TTL, "user.reset_password", [["UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", ctx.now, u.id]]);
    tx.audit({ action: "user.reset_password", resourceType: "user", resourceId: u.id, label: u.email, meta: { link_expires_at: iso(tok.expiresAt) } });
    await tx.commit();
    if (ctx.dryRun) return { user: publicUser(u) };
    const url = linkFor(ctx, "invite", tok.token);
    const sent = await sendEmail(ctx.env, { to: u.email, subject: "Reset your Tiny Comet admin password", text: `Reset your password here (valid 24 h, one use):\n\n${url}\n` });
    return { reset_url: url, expires_at: iso(tok.expiresAt), email_sent: sent };
  }
});
route({
  method: "POST", path: "/users/{id}/resend-invite", op: "users.resend_invite", tag: TU, perm: "users:create", resource: "user", summary: "New invite link for a user who hasn't accepted yet.",
  handler: async (ctx, { params }) => {
    const u = await getUser(ctx.env.DB, params.id);
    if (u.status !== "invited") throw new ApiError(409, "conflict", "This user already accepted their invite");
    await assertCanManage(ctx, u);
    const { tok, tx } = await issueLink(ctx, u, "invite", INVITE_TTL, "user.resend_invite");
    tx.audit({ action: "user.resend_invite", resourceType: "user", resourceId: u.id, label: u.email });
    await tx.commit();
    return ctx.dryRun ? {} : { invite_url: linkFor(ctx, "invite", tok.token), expires_at: iso(tok.expiresAt) };
  }
});
route({
  method: "GET", path: "/users/{id}/sessions", op: "users.sessions", tag: TU, perm: "users:manage", resource: "user", summary: "A user's active sessions.",
  handler: async (ctx, { params }) => (await activeSessions(ctx.env.DB, params.id, ctx.now)).map((s) => ({ id: s.public_id, created_at: iso(s.created_at), last_seen_at: iso(s.last_seen_at), ip: s.ip, country: s.country, user_agent: s.user_agent }))
});
route({
  method: "POST", path: "/users/{id}/revoke-sessions", op: "users.revoke_sessions", tag: TU, perm: "users:manage", resource: "user", summary: "Sign a user out everywhere.",
  handler: async (ctx, { params }) => {
    const u = await getUser(ctx.env.DB, params.id);
    await assertCanManage(ctx, u);
    const tx = new Tx(ctx);
    tx.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", ctx.now, u.id);
    tx.audit({ action: "user.revoke_sessions", resourceType: "user", resourceId: u.id, label: u.email });
    await tx.commit();
    return { revoked: true };
  }
});
route({
  method: "POST", path: "/users/{id}/transfer-ownership", op: "users.transfer_ownership", tag: TU, ownerOnly: true, auth: "session", stepUp: true, resource: "user",
  summary: "Owner only: make another active user the owner. You become an admin.",
  body: S.obj({ confirm_email: { type: "string", maxLength: 254 } }, ["confirm_email"]),
  handler: async (ctx, { params, body }) => {
    const u = await getUser(ctx.env.DB, params.id);
    if (u.id === ctx.user.id) throw new ApiError(400, "validation_failed", "You're already the owner");
    if (u.status !== "active" || !u.totp_enabled) throw new ApiError(409, "conflict", "The new owner must be an active user with 2FA set up");
    if (body.confirm_email.toLowerCase() !== u.email.toLowerCase()) throw new ApiError(400, "validation_failed", "confirm_email must match the new owner's email");
    const tx = new Tx(ctx);
    tx.run("UPDATE users SET role_id = 'owner', version = version + 1, updated_at = ? WHERE id = ?", ctx.now, u.id);
    tx.run("UPDATE users SET role_id = 'admin', version = version + 1, updated_at = ? WHERE id = ?", ctx.now, ctx.user.id);
    const parent = tx.audit({ action: "user.transfer_ownership", resourceType: "user", resourceId: u.id, label: `${ctx.user.email} → ${u.email}` });
    tx.audit({ parentId: parent, action: "user.role_change", resourceType: "user", resourceId: u.id, label: u.email, changes: [{ path: "role_id", op: "changed", old: u.role_id, new: "owner" }] });
    tx.audit({ parentId: parent, action: "user.role_change", resourceType: "user", resourceId: ctx.user.id, label: ctx.user.email, changes: [{ path: "role_id", op: "changed", old: "owner", new: "admin" }] });
    await tx.commit();
    return { owner: u.id, previous_owner_role: "admin" };
  }
});

/* ---------------------------------------------------------------- roles */
route({
  method: "GET", path: "/permissions", op: "permissions.catalog", tag: TR, summary: "Permission catalogue: resources × actions, built-in roles, owner-only permissions.",
  handler: async () => ({ resources: RESOURCES, actions: ACTIONS, owner_only: OWNER_ONLY, shorthands: { "resource:*": "all actions on a resource", "resource:write": "create + update + delete", "*": "everything (owner keys only)" }, builtin_roles: Object.fromEntries(Object.entries(BUILTIN_ROLES).map(([k, v]) => [k, v])) })
});
route({
  method: "GET", path: "/roles", op: "roles.list", tag: TR, perm: "roles:read", resource: "role", summary: "List roles with member counts.",
  handler: async (ctx) => {
    const db = ctx.env.DB;
    const { results } = await db.prepare("SELECT * FROM roles ORDER BY builtin DESC, created_at, name").all();
    const { results: c } = await db.prepare("SELECT role_id, COUNT(*) AS n FROM users WHERE status != 'removed' GROUP BY role_id").all();
    const counts = Object.fromEntries(c.map((x) => [x.role_id, x.n]));
    return results.map((r) => roleOut(r, counts));
  }
});
route({
  method: "GET", path: "/roles/{id}", op: "roles.get", tag: TR, perm: "roles:read", resource: "role", summary: "Get a role.",
  handler: async (ctx, { params }) => { const r = await ctx.env.DB.prepare("SELECT * FROM roles WHERE id = ?").bind(params.id).first(); if (!r) throw notFound("Role"); ctx.etag = etag(r.version); return roleOut(r); }
});

const roleBody = S.obj({
  id: S.slug(), name: S.str(60, { minLength: 1 }), description: S.str(300),
  permissions: S.arr({ type: "string", maxLength: 40 }, 200, { uniqueItems: true }),
  game_scope: { type: ["array", "null"], items: S.slug(), maxItems: 100 }
}, ["name", "permissions"]);

async function checkRolePayload(ctx, body) {
  const bad = invalidPermissions(body.permissions);
  if (bad.length) throw new ApiError(400, "validation_failed", `Unknown permissions: ${bad.join(", ")}`, { invalid: bad });
  const own = body.permissions.filter((p) => OWNER_ONLY.includes(p));
  if (own.length) throw new ApiError(400, "validation_failed", `Owner-only permissions can't be put in a role: ${own.join(", ")}`);
  if (body.game_scope?.length) {
    const { results } = await ctx.env.DB.prepare("SELECT id FROM games").all();
    const ids = new Set(results.map((r) => r.id));
    const unknown = body.game_scope.filter((g) => !ids.has(g));
    if (unknown.length) throw new ApiError(400, "validation_failed", `Unknown games in game_scope: ${unknown.join(", ")}`);
  }
  const missing = missingForGrant(ctx.grant, body.permissions, body.game_scope);
  if (missing.length) throw forbidden(`You can't grant permissions you don't have: ${missing.join(", ")}`, { missing });
}

route({
  method: "POST", path: "/roles", op: "roles.create", tag: TR, perm: "roles:manage", stepUp: true, resource: "role",
  summary: "Create a custom role from a permission matrix (optionally limited to some games).", body: roleBody,
  handler: async (ctx, { body }) => {
    await checkRolePayload(ctx, body);
    const id = body.id || body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || randomId("role-", 6);
    if (BUILTIN_ROLES[id] || (await ctx.env.DB.prepare("SELECT 1 FROM roles WHERE id = ?").bind(id).first())) throw new ApiError(409, "conflict", `A role with id "${id}" already exists`);
    const role = { id, name: body.name, description: body.description || "", permissions: body.permissions, game_scope: body.game_scope?.length ? body.game_scope : null };
    const tx = new Tx(ctx);
    tx.run("INSERT INTO roles (id, name, description, builtin, permissions, game_scope, created_at, updated_at, created_by) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)",
      id, role.name, role.description, JSON.stringify(role.permissions), role.game_scope ? JSON.stringify(role.game_scope) : null, ctx.now, ctx.now, ctx.actor.id);
    tx.audit({ action: "role.create", resourceType: "role", resourceId: id, label: role.name, after: role, changes: diff({}, role) });
    await tx.commit();
    return reply(roleOut({ ...role, builtin: 0, permissions: JSON.stringify(role.permissions), game_scope: JSON.stringify(role.game_scope), version: 1, updated_at: ctx.now }), { status: 201 });
  }
});
route({
  method: "PATCH", path: "/roles/{id}", op: "roles.update", tag: TR, perm: "roles:manage", stepUp: true, resource: "role",
  summary: "Edit a custom role (built-in roles are fixed).", body: { ...roleBody, required: [] },
  handler: async (ctx, { params, body }) => {
    const db = ctx.env.DB;
    const r = await loadRole(db, params.id);
    if (!r) throw notFound("Role");
    if (r.builtin) throw forbidden("Built-in roles can't be edited — create a custom role instead");
    checkIfMatch(ctx, r.version);
    const before = { id: r.id, name: r.name, description: r.description, permissions: r.permissions, game_scope: r.game_scope };
    const after = { ...before, ...Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && k !== "id")) };
    if (after.game_scope && !after.game_scope.length) after.game_scope = null;
    await checkRolePayload(ctx, after);
    // You also can't edit a role that currently holds more than you (e.g. strip an admin-level role).
    if (!isSubset(roleGrant(r), ctx.grant)) throw forbidden("You can't edit a role that has more access than you");
    const changes = diff(before, after);
    if (!changes.length) return roleOut({ ...r, permissions: JSON.stringify(r.permissions), game_scope: JSON.stringify(r.game_scope) });
    const tx = new Tx(ctx);
    tx.guard("SELECT 1 FROM roles WHERE id = ? AND version = ?", [r.id, r.version]);
    tx.run("UPDATE roles SET name = ?, description = ?, permissions = ?, game_scope = ?, version = version + 1, updated_at = ? WHERE id = ?",
      after.name, after.description, JSON.stringify(after.permissions), after.game_scope ? JSON.stringify(after.game_scope) : null, ctx.now, r.id);
    tx.audit({ action: "role.update", resourceType: "role", resourceId: r.id, label: after.name, before, after, changes });
    await tx.commit();
    return roleOut({ ...after, builtin: 0, permissions: JSON.stringify(after.permissions), game_scope: JSON.stringify(after.game_scope), version: r.version + 1, updated_at: ctx.now });
  }
});
route({
  method: "DELETE", path: "/roles/{id}", op: "roles.delete", tag: TR, perm: "roles:manage", stepUp: true, resource: "role", summary: "Delete an unused custom role.",
  handler: async (ctx, { params }) => {
    const db = ctx.env.DB;
    const r = await loadRole(db, params.id);
    if (!r) throw notFound("Role");
    if (r.builtin) throw forbidden("Built-in roles can't be deleted");
    if (!isSubset(roleGrant(r), ctx.grant)) throw forbidden("You can't delete a role that has more access than you");
    const used = await db.prepare("SELECT (SELECT COUNT(*) FROM users WHERE role_id = ? AND status != 'removed') + (SELECT COUNT(*) FROM api_keys WHERE role_id = ? AND revoked_at IS NULL) AS n").bind(r.id, r.id).first();
    if (used.n > 0) throw new ApiError(409, "conflict", "This role is still assigned to users or API keys");
    const tx = new Tx(ctx);
    tx.run("UPDATE users SET role_id = 'viewer' WHERE role_id = ? AND status = 'removed'", r.id);
    tx.run("DELETE FROM roles WHERE id = ?", r.id);
    tx.audit({ action: "role.delete", resourceType: "role", resourceId: r.id, label: r.name, before: { name: r.name, permissions: r.permissions, game_scope: r.game_scope } });
    await tx.commit();
    return { deleted: r.id };
  }
});

export { loadRole, grantOfRole, toList };

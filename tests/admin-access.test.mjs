/* Access control: permission matrix, no-escalation, API key scopes / IP allowlist / expiry / env / rate limit / rotation,
   kill switch, dry-run, approval queue, idempotency, ETag. Run: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { can, grant, expand, missingForGrant, intersect, BUILTIN_ROLES, ALL_PERMISSIONS, OWNER_ONLY, roleGrant, invalidPermissions } from "../lib/admin/permissions.js";
import { ipInCidr, ipAllowed, validCidr } from "../lib/admin/http.js";
import { makeEnv, call, Session, bootstrapOwner, nextCode } from "./helpers.mjs";

const bearer = (k, extra = {}) => ({ Authorization: `Bearer ${k}`, ...extra });
async function userWithRole(env, owner, roleId, email = `u${Math.random().toString(36).slice(2, 8)}@tinycometstudio.com`) {
  const inv = await owner.req("POST", "/users", { body: { email, name: "Child", role_id: roleId } });
  assert.equal(inv.status, 201, inv.text);
  const token = inv.data.invite_url.split("#")[1];
  const acc = await call(env, "POST", "/auth/invite/accept", { body: { token, password: "Stardust-notes-blue-77" } });
  const s = new Session(env);
  const setup = await s.req("POST", "/auth/totp/setup", { body: { mfa_token: acc.data.mfa_token } });
  s.secret = setup.data.secret;
  await s.req("POST", "/auth/totp/confirm", { body: { mfa_token: acc.data.mfa_token, code: await nextCode(s.secret) } });
  return s;
}
async function makeKey(owner, body) {
  const r = await owner.req("POST", "/api-keys", { body: { name: "agent", ...body } });
  assert.equal(r.status, 201, r.text);
  return r.data;
}

test("permission matrix: built-in roles, shorthands, game scoping", () => {
  assert.equal(can(grant(["*"]), "users:manage"), true);
  const admin = roleGrant({ id: "admin", builtin: 1 });
  assert.equal(can(admin, "users:manage"), true);
  assert.equal(can(admin, "audit:manage"), false, "owner-only");
  const editor = roleGrant({ id: "editor", builtin: 1 });
  assert.equal(can(editor, "news:publish"), true);
  assert.equal(can(editor, "games:delete"), false);
  assert.equal(can(editor, "users:read"), false);
  const viewer = roleGrant({ id: "viewer", builtin: 1 });
  assert.ok([...viewer.perms].every((p) => p.endsWith(":read")));
  assert.deepEqual([...expand(["games:write"])].sort(), ["games:create", "games:delete", "games:update"]);
  assert.equal(expand(["news:*"]).size, 5);
  assert.deepEqual(invalidPermissions(["games:fly", "nope:read", "news:read"]), ["games:fly", "nope:read"]);
  const scoped = grant(["games:read", "games:update", "games:create"], ["project-nova"]);
  assert.equal(can(scoped, "games:update", { gameId: "project-nova" }), true);
  assert.equal(can(scoped, "games:update", { gameId: "orbit-garden" }), false);
  assert.equal(can(scoped, "games:create"), false);
  assert.equal(can(scoped, "games:read"), true);
  for (const r of Object.values(BUILTIN_ROLES)) for (const p of r.permissions) assert.ok(p === "*" || ALL_PERMISSIONS.includes(p), p);
});

test("no escalation: nobody can grant what they don't hold", () => {
  const editor = roleGrant({ id: "editor", builtin: 1 });
  assert.deepEqual(missingForGrant(editor, ["news:read", "news:publish"]), []);
  assert.deepEqual(missingForGrant(editor, ["users:manage"]), ["users:manage"]);
  assert.deepEqual(missingForGrant(editor, ["*"]), ["*"]);
  const admin = roleGrant({ id: "admin", builtin: 1 });
  assert.deepEqual(missingForGrant(admin, OWNER_ONLY), OWNER_ONLY);
  const scoped = grant(["games:read", "games:update"], ["project-nova"]);
  assert.deepEqual(missingForGrant(scoped, ["games:update"]), ["game_scope:all"]);
  assert.deepEqual(missingForGrant(scoped, ["games:update"], ["project-nova"]), []);
  assert.deepEqual(missingForGrant(scoped, ["games:update"], ["orbit-garden"]), ["game_scope:orbit-garden"]);
  const k = intersect(grant(["games:read", "users:manage"]), editor);
  assert.deepEqual([...k.perms], ["games:read"], "key ∩ owner access");
});

test("API: roles & users — custom roles, matrix limits, owner protection", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const role = await owner.req("POST", "/roles", { body: { name: "Nova team", permissions: ["games:read", "games:update", "news:read"], game_scope: ["project-nova"] } });
  assert.equal(role.status, 201);
  assert.equal((await owner.req("POST", "/roles", { body: { name: "Auditor", permissions: ["audit:manage"] } })).status, 400, "owner-only permission can't go in a role");
  const nova = await userWithRole(env, owner, "nova-team");
  assert.equal((await nova.req("PATCH", "/games/project-nova", { body: { tagline: "Nova!" } })).status, 200);
  const other = await nova.req("PATCH", "/games/orbit-garden", { body: { tagline: "x" } });
  assert.equal(other.status, 403, "game-scoped role can't edit other games");
  assert.equal((await nova.req("GET", "/users")).status, 403);
  // an admin can't create a role with more than they have, can't touch the owner, can't make owners
  const admin = await userWithRole(env, owner, "admin");
  assert.equal((await admin.req("POST", "/roles", { body: { name: "Root", permissions: ["audit:manage", "games:read"] } })).status, 400);
  const ownerId = (await owner.req("GET", "/auth/session")).data.user.id;
  assert.equal((await admin.req("PATCH", `/users/${ownerId}`, { body: { status: "suspended" } })).status, 403);
  assert.equal((await admin.req("DELETE", `/users/${ownerId}`)).status, 403);
  assert.equal((await admin.req("POST", "/users", { body: { email: "x@tinycometstudio.com", name: "X", role_id: "owner" } })).status, 403);
  // an editor can't invite anyone, and can't create roles
  const editor = await userWithRole(env, owner, "editor");
  assert.equal((await editor.req("POST", "/users", { body: { email: "y@tinycometstudio.com", name: "Y", role_id: "viewer" } })).status, 403);
  assert.equal((await editor.req("POST", "/roles", { body: { name: "Mine", permissions: ["news:read"] } })).status, 403);
  // owner can't be removed; ownership transfer keeps exactly one owner
  assert.equal((await owner.req("DELETE", `/users/${ownerId}`)).status, 403);
  const adminId = (await admin.req("GET", "/auth/session")).data.user.id;
  const t = await owner.req("POST", `/users/${adminId}/transfer-ownership`, { body: { confirm_email: (await admin.req("GET", "/auth/session")).data.user.email } });
  assert.equal(t.status, 200, t.text);
  const users = (await admin.req("GET", "/users")).data;
  assert.equal(users.filter((u) => u.role_id === "owner").length, 1);
  assert.equal(users.find((u) => u.id === ownerId).role_id, "admin");
  const denied = (await admin.req("GET", "/audit?result=denied")).data;
  assert.ok(denied.some((e) => e.result_reason?.includes("missing permission")), "denials are audited");
});

test("API keys: scopes enforced, can't exceed creator, '*' owner-only, secret shown once & hashed", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const k = await makeKey(owner, { scopes: ["games:read", "news:create"] });
  assert.match(k.secret, /^tck_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
  const stored = env.DB.db.prepare("SELECT key_hash FROM api_keys").get();
  assert.ok(!JSON.stringify(stored).includes(k.secret.split("_").pop()), "only the hash is stored");
  assert.ok(!(await owner.req("GET", `/api-keys/${k.api_key.id}`)).text.includes(k.secret));
  assert.equal((await call(env, "GET", "/games", { headers: bearer(k.secret) })).status, 200);
  assert.equal((await call(env, "PATCH", "/games/project-nova", { body: { tagline: "x" }, headers: bearer(k.secret) })).status, 403);
  assert.equal((await call(env, "POST", "/news", { body: { title: "From agent" }, headers: bearer(k.secret) })).status, 201);
  assert.equal((await call(env, "POST", "/news", { body: { title: "Live now", status: "published" }, headers: bearer(k.secret) })).status, 403, "publishing needs news:publish");
  assert.equal((await call(env, "GET", "/games", { headers: bearer(k.secret.slice(0, -1) + "x") })).status, 401);
  assert.equal((await call(env, "POST", "/auth/logout", { headers: bearer(k.secret) })).status, 403, "session-only endpoint");
  const editor = await userWithRole(env, owner, "editor");
  assert.equal((await editor.req("POST", "/api-keys", { body: { name: "e", scopes: ["news:read"] } })).status, 403, "editor role has no api_keys:create");
  const dev = await userWithRole(env, owner, "developer");
  const tooMuch = await dev.req("POST", "/api-keys", { body: { name: "d", scopes: ["users:manage"] } });
  assert.equal(tooMuch.status, 403);
  assert.deepEqual(tooMuch.error.details.missing, ["users:manage"]);
  assert.equal((await dev.req("POST", "/api-keys", { body: { name: "d", scopes: ["*"] } })).status, 403);
  const devKey = (await dev.req("POST", "/api-keys", { body: { name: "d", scopes: ["games:read", "games:update"] } })).data.secret;
  assert.equal((await call(env, "PATCH", "/games/orbit-garden", { body: { tagline: "dev" }, headers: bearer(devKey) })).status, 200);
  // demote the creator → their key loses access immediately (key access = scopes ∩ creator's current access)
  const devId = (await dev.req("GET", "/auth/session")).data.user.id;
  assert.equal((await owner.req("PATCH", `/users/${devId}`, { body: { role_id: "viewer" } })).status, 200);
  assert.equal((await call(env, "PATCH", "/games/orbit-garden", { body: { tagline: "dev2" }, headers: bearer(devKey) })).status, 403);
  // a key can't mint a stronger key
  const keyAdmin = (await makeKey(owner, { scopes: ["api_keys:create", "games:read"] })).secret;
  assert.equal((await call(env, "POST", "/api-keys", { body: { name: "child", scopes: ["users:manage"] }, headers: bearer(keyAdmin) })).status, 403);
  assert.equal((await call(env, "POST", "/api-keys", { body: { name: "child", scopes: ["games:read"] }, headers: bearer(keyAdmin) })).status, 201);
});

test("API keys: IP allowlist (IPv4/IPv6 CIDR), expiry, environments, disable, revoke, rotation grace", async () => {
  assert.equal(ipInCidr("203.0.113.7", "203.0.113.0/24"), true);
  assert.equal(ipInCidr("203.0.114.7", "203.0.113.0/24"), false);
  assert.equal(ipInCidr("2001:db8::1", "2001:db8::/32"), true);
  assert.equal(ipInCidr("2001:db9::1", "2001:db8::/32"), false);
  assert.equal(ipInCidr("::ffff:10.0.0.5", "10.0.0.0/8"), true);
  assert.equal(ipAllowed("1.2.3.4", []), true);
  assert.equal(validCidr("10.0.0.0/33"), false);
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const ipKey = await makeKey(owner, { scopes: ["games:read"], ip_allowlist: ["198.51.100.0/24"] });
  const r1 = await call(env, "GET", "/games", { headers: bearer(ipKey.secret) });
  assert.equal(r1.status, 401);
  assert.equal(r1.error.details.reason, "ip_not_allowed");
  assert.equal((await call(env, "GET", "/games", { headers: bearer(ipKey.secret, { "CF-Connecting-IP": "198.51.100.20" }) })).status, 200);
  assert.equal((await owner.req("POST", "/api-keys", { body: { name: "bad", scopes: ["games:read"], ip_allowlist: ["300.1.1.1"] } })).status, 400);
  const exp = await makeKey(owner, { scopes: ["games:read"], expires_at: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await call(env, "GET", "/games", { headers: bearer(exp.secret) })).status, 200);
  env.DB.db.exec(`UPDATE api_keys SET expires_at = ${Date.now() - 1} WHERE id = '${exp.api_key.id}'`);
  assert.equal((await call(env, "GET", "/games", { headers: bearer(exp.secret) })).error.details.reason, "expired");
  const envKey = await makeKey(owner, { scopes: ["games:read"], environments: ["development"] });
  assert.equal((await call(env, "GET", "/games", { headers: bearer(envKey.secret) })).error.details.reason, "environment_not_allowed");
  const k = await makeKey(owner, { scopes: ["games:read"] });
  await owner.req("PATCH", `/api-keys/${k.api_key.id}`, { body: { enabled: false } });
  assert.equal((await call(env, "GET", "/games", { headers: bearer(k.secret) })).error.details.reason, "disabled");
  await owner.req("PATCH", `/api-keys/${k.api_key.id}`, { body: { enabled: true } });
  const rot = await owner.req("POST", `/api-keys/${k.api_key.id}/rotate`, { body: { grace_hours: 1 } });
  assert.notEqual(rot.data.secret, k.secret);
  assert.equal((await call(env, "GET", "/games", { headers: bearer(k.secret) })).status, 200, "old secret valid during grace");
  assert.equal((await call(env, "GET", "/games", { headers: bearer(rot.data.secret) })).status, 200);
  env.DB.db.exec(`UPDATE api_keys SET prev_valid_until = ${Date.now() - 1}`);
  assert.equal((await call(env, "GET", "/games", { headers: bearer(k.secret) })).status, 401, "grace over");
  await owner.req("POST", `/api-keys/${k.api_key.id}/revoke`);
  assert.equal((await call(env, "GET", "/games", { headers: bearer(rot.data.secret) })).error.details.reason, "revoked");
  const used = (await owner.req("GET", `/api-keys/${ipKey.api_key.id}`)).data;
  assert.equal(used.usage_count, 1);
  assert.equal(used.last_used_ip, "198.51.100.20");
  const audit = (await owner.req("GET", "/audit?action=auth.api_key")).data;
  assert.ok(["ip_not_allowed", "expired", "environment_not_allowed", "disabled", "revoked"].every((r) => audit.some((e) => e.result_reason === r)), "every key refusal is audited");
});

test("API keys: per-key rate limit (429 + headers)", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const k = await makeKey(owner, { scopes: ["games:read"], rate_limit: 3 });
  const s = [];
  for (let i = 0; i < 5; i++) s.push(await call(env, "GET", "/games", { headers: bearer(k.secret) }));
  assert.deepEqual(s.map((r) => r.status), [200, 200, 200, 429, 429]);
  assert.equal(s[0].headers.get("RateLimit-Limit"), "3");
  assert.equal(s[2].headers.get("RateLimit-Remaining"), "0");
  assert.ok(Number(s[3].headers.get("Retry-After")) >= 1);
  assert.equal(s[3].error.code, "rate_limited");
});

test("kill switch: blocks every API key instantly, sessions keep working, only a human can turn it off", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const k = await makeKey(owner, { scopes: ["system:manage", "games:read"] });
  assert.equal((await call(env, "GET", "/games", { headers: bearer(k.secret) })).status, 200);
  assert.equal((await call(env, "PUT", "/system/kill-switch", { body: { enabled: false }, headers: bearer(k.secret) })).status, 403);
  assert.equal((await owner.req("PUT", "/system/kill-switch", { body: { enabled: true, reason: "suspicious agent" } })).status, 200);
  const blocked = await call(env, "GET", "/games", { headers: bearer(k.secret) });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.error.code, "api_keys_disabled");
  assert.equal((await owner.req("GET", "/games")).status, 200, "admin UI unaffected");
  await owner.req("PUT", "/system/kill-switch", { body: { enabled: false } });
  assert.equal((await call(env, "GET", "/games", { headers: bearer(k.secret) })).status, 200);
  const log = (await owner.req("GET", "/audit?action=system.*")).data.map((e) => e.action);
  assert.ok(log.includes("system.kill_switch_on") && log.includes("system.kill_switch_off"));
  assert.ok((await owner.req("GET", "/audit?action=auth.api_key&result=denied")).data.some((e) => e.result_reason === "kill_switch"));
});

test("dry-run: returns the would-be diff, writes nothing except a dry_run audit entry", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const k = await makeKey(owner, { scopes: ["games:read", "games:update", "games:delete"] });
  const before = (await call(env, "GET", "/games/project-nova", { headers: bearer(k.secret) })).data;
  const r = await call(env, "PATCH", "/games/project-nova", { body: { tagline: "Preview only" }, headers: bearer(k.secret, { "X-Dry-Run": "true" }) });
  assert.equal(r.status, 200);
  assert.equal(r.json.meta.dry_run, true);
  assert.deepEqual(r.json.meta.would_change[0].changes, [{ path: "tagline", op: "changed", old: before.tagline, new: "Preview only" }]);
  assert.deepEqual(r.json.meta.would_emit, ["game.updated"]);
  const after = (await call(env, "GET", "/games/project-nova", { headers: bearer(k.secret) })).data;
  assert.equal(after.tagline, before.tagline);
  assert.equal(after._meta.version, before._meta.version);
  const del = await call(env, "DELETE", "/games/project-nova", { headers: bearer(k.secret, { "X-Dry-Run": "1" }) });
  assert.equal(del.json.meta.dry_run, true);
  assert.equal((await call(env, "GET", "/games/project-nova", { headers: bearer(k.secret) })).data._meta.deleted_at, null);
  const entries = (await owner.req("GET", "/audit?result=dry_run")).data;
  assert.equal(entries.length, 2);
  // force_dry_run keys can never write
  const safe = await makeKey(owner, { scopes: ["games:update", "games:read"], force_dry_run: true });
  const f = await call(env, "PATCH", "/games/project-nova", { body: { tagline: "nope" }, headers: bearer(safe.secret) });
  assert.equal(f.json.meta.dry_run, true);
  assert.equal((await call(env, "GET", "/games/project-nova", { headers: bearer(k.secret) })).data.tagline, before.tagline);
});

test("approval queue: destructive calls wait for a human; approve runs them as the key, reject doesn't", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const k = await makeKey(owner, { scopes: ["games:read", "games:update", "games:delete", "news:read", "news:publish"], require_approval: true });
  assert.equal((await call(env, "PATCH", "/games/project-nova", { body: { tagline: "fine without approval" }, headers: bearer(k.secret) })).status, 200, "non-destructive writes run");
  const q = await call(env, "DELETE", "/games/orbit-garden", { headers: bearer(k.secret, { "X-Change-Reason": "game cancelled", "X-Agent-Name": "cleanup-bot" }) });
  assert.equal(q.status, 202);
  assert.equal(q.data.approval.status, "pending");
  assert.equal(q.data.approval.preview[0].action, "game.delete");
  assert.equal((await call(env, "GET", "/games/orbit-garden", { headers: bearer(k.secret) })).data._meta.deleted_at, null, "nothing happened yet");
  const q2 = await call(env, "POST", "/news/hello-world/unpublish", { headers: bearer(k.secret) });
  assert.equal(q2.status, 202);
  const pending = (await owner.req("GET", "/approvals")).data;
  assert.equal(pending.length, 2);
  // approvals can't be decided with an API key
  assert.equal((await call(env, "POST", `/approvals/${q.data.approval.id}/approve`, { body: {}, headers: bearer(k.secret) })).status, 403);
  const ok = await owner.req("POST", `/approvals/${q.data.approval.id}/approve`, { body: { note: "agreed" } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.data.status, "approved");
  assert.ok((await call(env, "GET", "/games/orbit-garden", { headers: bearer(k.secret) })).data._meta.deleted_at);
  const no = await owner.req("POST", `/approvals/${q2.data.approval.id}/reject`, { body: { note: "keep it" } });
  assert.equal(no.data.status, "rejected");
  assert.equal((await call(env, "GET", "/news/hello-world", { headers: bearer(k.secret) })).data.status, "published");
  const del = (await owner.req("GET", "/audit?action=game.delete")).data[0];
  assert.equal(del.actor_type, "api_key");
  assert.equal(del.api_key_id, k.api_key.id);
  assert.equal(del.source, "agent:cleanup-bot");
  assert.equal(del.reason, "game cancelled");
  assert.equal(del.meta.approval_id, q.data.approval.id);
  assert.equal(del.meta.approved_by.email, owner.email);
});

test("idempotency keys and If-Match optimistic concurrency", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const k = (await makeKey(owner, { scopes: ["news:create", "news:read", "games:read", "games:update"] })).secret;
  const a = await call(env, "POST", "/news", { body: { title: "Once" }, headers: bearer(k, { "Idempotency-Key": "abc" }) });
  const b = await call(env, "POST", "/news", { body: { title: "Once" }, headers: bearer(k, { "Idempotency-Key": "abc" }) });
  assert.equal(a.status, 201);
  assert.equal(b.headers.get("Idempotent-Replayed"), "true");
  assert.equal(b.data.slug, a.data.slug);
  assert.equal((await call(env, "POST", "/news", { body: { title: "Different" }, headers: bearer(k, { "Idempotency-Key": "abc" }) })).status, 422);
  const g = await call(env, "GET", "/games/project-nova", { headers: bearer(k) });
  const etag = g.headers.get("ETag");
  assert.equal(etag, `"v${g.data._meta.version}"`);
  assert.equal((await call(env, "PATCH", "/games/project-nova", { body: { tagline: "one" }, headers: bearer(k, { "If-Match": etag }) })).status, 200);
  const stale = await call(env, "PATCH", "/games/project-nova", { body: { tagline: "two" }, headers: bearer(k, { "If-Match": etag }) });
  assert.equal(stale.status, 412);
  assert.equal(stale.error.code, "precondition_failed");
});

test("validation: strict schemas, unknown fields and bad values rejected with details", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const r1 = await owner.req("PATCH", "/games/project-nova", { body: { status: "shipped" } });
  assert.equal(r1.status, 400);
  assert.equal(r1.error.code, "validation_failed");
  assert.ok(r1.error.details[0].path.includes("status"));
  assert.equal((await owner.req("PATCH", "/games/project-nova", { body: { evil: 1 } })).status, 400);
  assert.equal((await owner.req("PATCH", "/games/project-nova", { body: { links: { android: "javascript:alert(1)" } } })).status, 400);
  assert.equal((await owner.req("POST", "/games", { body: { id: "admin", title: "x", status: "released" } })).status, 400, "reserved slug");
  assert.equal((await owner.req("POST", "/news", { body: { title: "x", game: "nope" } })).status, 400);
  const nf = await call(env, "GET", "/nope");
  assert.equal(nf.status, 404);
  assert.ok(nf.error.request_id.startsWith("req_"));
  assert.equal((await call(env, "GET", "/games")).status, 401);
});

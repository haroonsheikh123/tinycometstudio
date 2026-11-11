/* Setup, login (email + password → authenticator code), TOTP enrollment, step-up, sessions, password, invites. */
import { route, reply } from "../router.js";
import { S } from "../schema.js";
import { ApiError } from "../http.js";
import { Tx } from "../tx.js";
import { hashPassword, verifyPassword, passwordProblems, DUMMY_HASH, encrypt, decrypt, safeEqual, randomId } from "../crypto.js";
import { generateTotpSecret, verifyTotp, otpauthUri } from "../totp.js";
import { qrSvg } from "../qr.js";
import { hit, peek, enforce } from "../ratelimit.js";
import { prepareSession, prepareToken, findToken, consumeTokenSql, generateRecoveryCodes, hashRecovery, clearSessionCookie, csrfToken, STEP_UP_MS } from "../auth.js";
import { makeEntry, writeAudit } from "../audit.js";
import { j } from "../content.js";
import { getState, setStateStmt } from "../state.js";
import { toList, RESOURCES } from "../permissions.js";
import { iso } from "./_util.js";

const T = "Auth";
const MFA_TTL = 5 * 60_000;
const ENROLL_TTL = 30 * 60_000;
const email = () => ({ type: "string", format: "email", maxLength: 254 });
const password = () => ({ type: "string", minLength: 1, maxLength: 256 });
const code = () => ({ type: "string", pattern: "^\\s*\\d{3}\\s?\\d{3}\\s*$", maxLength: 10 });

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name, role_id: u.role_id, status: u.status, mfa_enabled: !!u.totp_enabled,
    recovery_codes_left: j(u.recovery_codes, []).length, locked_until: iso(u.locked_until && u.locked_until > Date.now() ? u.locked_until : null),
    last_login_at: iso(u.last_login_at), last_login_ip: u.last_login_ip, created_at: iso(u.created_at), updated_at: iso(u.updated_at), version: u.version
  };
}
const userSnapshot = (u) => publicUser(u);

async function audit1(ctx, e, actor) {
  await writeAudit(ctx.env, [makeEntry(actor ? { ...ctx, actor } : ctx, e)]);
}
const actorOf = (u, sessionId = null) => ({ type: "user", id: u.id, name: u.name, email: u.email, role: u.role_id, sessionId });

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token || token.length > 2048) return false;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET); body.append("response", token);
  if (ip) body.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(8000) });
    return (await r.json())?.success === true;
  } catch { return false; }
}
async function siteKey(env) {
  const s = await env.DB.prepare("SELECT data FROM settings WHERE id = 'site'").first();
  return j(s?.data, {})?.turnstileSiteKey || null;
}

function lockoutFor(failed) {
  if (failed < 5) return null;
  return Math.min(24 * 3600_000, 15 * 60_000 * 2 ** (failed - 5));
}

/** Record a failed factor; returns statements for the lockout counter. */
function failStmts(ctx, user) {
  const failed = (user.failed_logins || 0) + 1;
  const lock = lockoutFor(failed);
  return ctx.env.DB.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").bind(failed, lock ? ctx.now + lock : user.locked_until ?? null, user.id);
}

/** Session login completed: reset counters, create session, audit. Returns reply with Set-Cookie. */
async function finishLogin(ctx, user, { method, extra = {}, tokenHash, extraStmts = [], recoveryCodes } = {}) {
  const sess = await prepareSession(ctx.env, user, ctx, ctx.now);
  const tx = new Tx(ctx);
  ctx.actor = actorOf(user, sess.publicId);
  if (tokenHash) tx.run(consumeTokenSql, ctx.now, tokenHash);
  tx.run("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ? WHERE id = ?", ctx.now, ctx.ip, user.id);
  tx.stmts.push(sess.stmt, ...extraStmts);
  tx.audit({ action: "auth.login", resourceType: "user", resourceId: user.id, label: user.email, meta: { method, session: sess.publicId, device: ctx.device, ...extra } });
  await tx.commit();
  const fresh = await ctx.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  const data = { user: publicUser(fresh), csrf_token: sess.csrf, session_id: sess.publicId };
  if (recoveryCodes) data.recovery_codes = recoveryCodes;
  return reply(data, { headers: { "Set-Cookie": sess.cookie } });
}

/* ---------------------------------------------------------------- first-owner setup */
route({
  method: "GET", path: "/setup", op: "setup.status", tag: T, auth: "public", summary: "Is first-owner setup still available?",
  handler: async (ctx) => {
    const n = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    const st = await getState(ctx.env.DB, ["setup_done", "seeded_at"]);
    return { setup_required: n.n === 0 && !st.setup_done, setup_token_configured: Boolean(ctx.env.SETUP_TOKEN), content_seeded: Boolean(st.seeded_at) };
  }
});
route({
  method: "POST", path: "/setup", op: "setup.create_owner", tag: T, auth: "public", dryRun: false, ipLimit: [10, 3600],
  summary: "Create the first owner with the one-time SETUP_TOKEN (disables itself afterwards). Returns an enrollment token for TOTP.",
  body: S.obj({ setup_token: S.str(500, { minLength: 1 }), email: email(), name: S.str(100, { minLength: 1 }), password: password() }, ["setup_token", "email", "name", "password"]),
  handler: async (ctx, { body }) => {
    const db = ctx.env.DB;
    const n = await db.prepare("SELECT COUNT(*) AS n FROM users").first();
    const st = await getState(db, ["setup_done"]);
    if (n.n > 0 || st.setup_done) throw new ApiError(410, "setup_complete", "Setup was already completed. Sign in instead.");
    if (!ctx.env.SETUP_TOKEN || String(ctx.env.SETUP_TOKEN).length < 16) throw new ApiError(503, "not_configured", "Set the SETUP_TOKEN secret (≥ 16 random characters) to enable first-owner setup");
    if (!safeEqual(body.setup_token, ctx.env.SETUP_TOKEN)) {
      await audit1(ctx, { action: "setup.create_owner", result: "denied", resultReason: "wrong setup token", label: body.email });
      throw new ApiError(403, "forbidden", "Wrong setup token");
    }
    const probs = passwordProblems(body.password, body);
    if (probs.length) throw new ApiError(400, "weak_password", `Password ${probs.join(", ")}`, probs);
    const id = randomId("usr_", 12);
    const user = { id, email: body.email.toLowerCase(), name: body.name.trim(), role_id: "owner", status: "active" };
    ctx.actor = actorOf(user);
    ctx.source = "setup";
    const tok = await prepareToken(ctx.env, "enroll", id, ENROLL_TTL, null, ctx.now);
    const tx = new Tx(ctx);
    tx.run("INSERT INTO users (id, email, name, role_id, status, password_hash, password_changed_at, created_at, updated_at, created_by) VALUES (?, ?, ?, 'owner', 'active', ?, ?, ?, ?, 'setup')",
      id, user.email, user.name, await hashPassword(body.password), ctx.now, ctx.now, ctx.now);
    tx.stmts.push(tok.stmt, setStateStmt(db, "setup_done", { at: ctx.now, by: id }, ctx.now));
    tx.audit({ action: "setup.create_owner", resourceType: "user", resourceId: id, label: user.email, after: { ...user, password: "set" }, changes: [{ path: "role_id", op: "added", new: "owner" }, { path: "password", op: "added", new: "[redacted: changed]" }] });
    await tx.commit();
    return reply({ user: { id, email: user.email, name: user.name, role_id: "owner" }, mfa_required: "enroll", mfa_token: tok.token, expires_in: ENROLL_TTL / 1000 }, { status: 201 });
  }
});

/* ---------------------------------------------------------------- login */
route({
  method: "POST", path: "/auth/login", op: "auth.login", tag: T, auth: "public", dryRun: false, ipLimit: [30, 900],
  summary: "Step 1: email + password. Returns an mfa_token to exchange with an authenticator code at /auth/mfa.",
  body: S.obj({ email: email(), password: password(), turnstile_token: S.str(2048) }, ["email", "password"]),
  handler: async (ctx, { body }) => {
    const db = ctx.env.DB;
    const addr = body.email.trim().toLowerCase();
    const user = await db.prepare("SELECT * FROM users WHERE email = ?").bind(addr).first();
    const ipFails = await peek(db, `loginfail:${ctx.ip}`, 900, ctx.now);
    const needCaptcha = Boolean(ctx.env.TURNSTILE_SECRET) && (ipFails >= 3 || (user?.failed_logins || 0) >= 3);
    const label = addr;
    if (needCaptcha) {
      if (!body.turnstile_token) throw new ApiError(401, "captcha_required", "Please complete the human check and try again", { site_key: await siteKey(ctx.env) });
      if (!(await verifyTurnstile(ctx.env, body.turnstile_token, ctx.ip))) {
        await audit1(ctx, { action: "auth.login", result: "denied", resultReason: "captcha_failed", resourceType: "user", resourceId: user?.id, label, actorEmail: addr });
        throw new ApiError(401, "captcha_required", "The human check failed — please try again", { site_key: await siteKey(ctx.env) });
      }
    }
    const pwOk = await verifyPassword(body.password, user?.password_hash || DUMMY_HASH);
    const deny = async (reason, err, stmts = []) => {
      await hit(db, `loginfail:${ctx.ip}`, 1e9, 900, ctx.now);
      if (stmts.length) await db.batch(stmts);
      await audit1(ctx, { action: "auth.login", result: "denied", resultReason: reason, resourceType: "user", resourceId: user?.id, label, actorEmail: addr, actorId: user?.id ?? null, actorName: user?.name ?? null, meta: { step: "password" } });
      throw err;
    };
    const invalid = new ApiError(401, "invalid_credentials", "Wrong email or password");
    if (!user) return deny("unknown_account", invalid);
    if (user.locked_until && user.locked_until > ctx.now) return deny("account_locked", new ApiError(423, "account_locked", "Too many failed attempts — this account is temporarily locked. Try again later or ask an admin.", { locked_until: iso(user.locked_until) }));
    if (!pwOk || !user.password_hash) return deny("wrong_password", invalid, [failStmts(ctx, user)]);
    if (user.status !== "active") return deny(`account_${user.status}`, new ApiError(403, "account_disabled", "This account is not active. Ask an admin."));
    if (!user.totp_enabled) return deny("mfa_not_enrolled", new ApiError(403, "mfa_enrollment_required", "Two-factor authentication must be set up first. Ask an admin for a new enrollment link."));
    const tok = await prepareToken(ctx.env, "mfa", user.id, MFA_TTL, null, ctx.now);
    await tok.stmt.run();
    return { mfa_required: "totp", mfa_token: tok.token, expires_in: MFA_TTL / 1000 };
  }
});

route({
  method: "POST", path: "/auth/mfa", op: "auth.mfa", tag: T, auth: "public", dryRun: false, ipLimit: [30, 900],
  summary: "Step 2: exchange the mfa_token + a 6-digit authenticator code (or a recovery code) for a session cookie.",
  body: S.obj({ mfa_token: S.str(100, { minLength: 1 }), code: code(), recovery_code: S.str(20) }, ["mfa_token"]),
  handler: async (ctx, { body }) => {
    const db = ctx.env.DB;
    const t = await findToken(ctx.env, body.mfa_token, ["mfa"], ctx.now);
    if (!t) throw new ApiError(401, "mfa_token_invalid", "This sign-in attempt expired. Start again with your email and password.");
    const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(t.user_id).first();
    if (!user || user.status !== "active" || !user.totp_enabled) throw new ApiError(401, "mfa_token_invalid", "This sign-in attempt is no longer valid.");
    if (user.locked_until && user.locked_until > ctx.now) throw new ApiError(423, "account_locked", "Too many failed attempts — try again later.");
    const fail = async (reason) => {
      await db.batch([db.prepare("UPDATE tokens SET attempts = attempts + 1 WHERE token_hash = ?").bind(t.token_hash), failStmts(ctx, user)]);
      await audit1(ctx, { action: "auth.login", result: "denied", resultReason: reason, resourceType: "user", resourceId: user.id, label: user.email, meta: { step: "mfa" } }, actorOf(user));
      throw new ApiError(401, "invalid_code", reason === "reused_code" ? "That code was already used — wait for the next one" : "That code isn't right — check your authenticator app and try again");
    };
    if (body.recovery_code) {
      const codes = j(user.recovery_codes, []);
      const h = await hashRecovery(body.recovery_code);
      if (!codes.includes(h)) return fail("wrong_recovery_code");
      const left = codes.filter((c) => c !== h);
      return finishLogin(ctx, user, { method: "recovery_code", tokenHash: t.token_hash, extra: { recovery_codes_left: left.length }, extraStmts: [db.prepare("UPDATE users SET recovery_codes = ? WHERE id = ?").bind(JSON.stringify(left), user.id)] });
    }
    if (!body.code) throw new ApiError(400, "validation_failed", "Send `code` (6 digits) or `recovery_code`");
    const secret = await decrypt(ctx.env.ENCRYPTION_KEY, user.totp_secret_enc, `totp:${user.id}`);
    const step = await verifyTotp(secret, body.code, { now: ctx.now, lastStep: user.totp_last_step });
    if (step === null) {
      const replay = (await verifyTotp(secret, body.code, { now: ctx.now, lastStep: -1 })) !== null;
      return fail(replay ? "reused_code" : "wrong_code");
    }
    return finishLogin(ctx, user, { method: "totp", tokenHash: t.token_hash, extraStmts: [db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ?").bind(step, user.id)] });
  }
});

/* ---------------------------------------------------------------- TOTP enrollment */
async function enrollSubject(ctx, body) {
  if (body.mfa_token) {
    const t = await findToken(ctx.env, body.mfa_token, ["enroll"], ctx.now);
    if (!t) throw new ApiError(401, "mfa_token_invalid", "This enrollment link expired or was already used. Ask an admin for a new one.");
    const user = await ctx.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(t.user_id).first();
    if (!user || user.status === "suspended" || user.status === "removed") throw new ApiError(403, "account_disabled", "This account is not active");
    if (t.created_by) {
      // Links from an admin's "reset 2FA" also need the user's password (link + password = two things).
      if (!body.password || !(await verifyPassword(body.password, user.password_hash || DUMMY_HASH))) {
        await ctx.env.DB.prepare("UPDATE tokens SET attempts = attempts + 1 WHERE token_hash = ?").bind(t.token_hash).run();
        throw new ApiError(401, "invalid_credentials", "Enter your current password to set up your authenticator");
      }
    }
    return { user, token: t };
  }
  const { readSession } = await import("../auth.js");
  const s = await readSession(ctx.env, ctx.request, ctx.now);
  if (!s) throw new ApiError(401, "unauthenticated", "Send an mfa_token (enrollment link) or sign in");
  const { checkCsrf } = await import("../auth.js");
  await checkCsrf(ctx.env, ctx.request, s.sid);
  if (ctx.now - s.session.stepup_at > STEP_UP_MS) throw new ApiError(403, "step_up_required", "Confirm with your current authenticator code first");
  ctx.session = s.session;
  return { user: s.user, session: s.session };
}

route({
  method: "POST", path: "/auth/totp/setup", op: "auth.totp_setup", tag: T, auth: "mfa", dryRun: false, ipLimit: [20, 900],
  summary: "Start authenticator enrollment: returns the secret, otpauth:// URI and a QR code (SVG). Use an enrollment mfa_token, or a signed-in session (re-enroll, needs step-up).",
  body: S.obj({ mfa_token: S.str(100), password: S.str(256) }),
  handler: async (ctx, { body }) => {
    const { user } = await enrollSubject(ctx, body);
    const secret = generateTotpSecret();
    ctx.actor = actorOf(user, ctx.session?.public_id);
    const tx = new Tx(ctx);
    tx.run("UPDATE users SET totp_pending_enc = ?, updated_at = ? WHERE id = ?", await encrypt(ctx.env.ENCRYPTION_KEY, secret, `totp:${user.id}`), ctx.now, user.id);
    tx.audit({ action: "auth.totp_setup_started", resourceType: "user", resourceId: user.id, label: user.email, changes: [{ path: "totp_pending_enc", op: "changed", old: "[redacted]", new: "[redacted: changed]" }] });
    await tx.commit();
    const uri = otpauthUri({ secret, account: user.email });
    return { secret, secret_grouped: secret.match(/.{1,4}/g).join(" "), otpauth_uri: uri, qr_svg: qrSvg(uri), issuer: "Tiny Comet Studio", account: user.email, digits: 6, period: 30, algorithm: "SHA1" };
  }
});

route({
  method: "POST", path: "/auth/totp/confirm", op: "auth.totp_confirm", tag: T, auth: "mfa", dryRun: false, ipLimit: [30, 900],
  summary: "Finish enrollment with a valid code. Returns 10 one-time recovery codes (shown once). With an mfa_token this also signs you in.",
  body: S.obj({ mfa_token: S.str(100), password: S.str(256), code: code() }, ["code"]),
  handler: async (ctx, { body }) => {
    const db = ctx.env.DB;
    const { user, token, session } = await enrollSubject(ctx, body);
    if (!user.totp_pending_enc) throw new ApiError(409, "conflict", "Start enrollment first (POST /auth/totp/setup)");
    const secret = await decrypt(ctx.env.ENCRYPTION_KEY, user.totp_pending_enc, `totp:${user.id}`);
    const step = await verifyTotp(secret, body.code, { now: ctx.now, lastStep: -1 });
    if (step === null) {
      if (token) await db.prepare("UPDATE tokens SET attempts = attempts + 1 WHERE token_hash = ?").bind(token.token_hash).run();
      await audit1(ctx, { action: "auth.totp_enroll", result: "denied", resultReason: "wrong_code", resourceType: "user", resourceId: user.id, label: user.email }, actorOf(user));
      throw new ApiError(401, "invalid_code", "That code isn't right — make sure your phone's clock is set automatically and try the newest code");
    }
    const codes = generateRecoveryCodes(10);
    const hashes = await Promise.all(codes.map(hashRecovery));
    const enrollStmt = db.prepare("UPDATE users SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_enabled = 1, totp_last_step = ?, recovery_codes = ?, status = CASE WHEN status = 'invited' THEN 'active' ELSE status END, version = version + 1, updated_at = ? WHERE id = ?")
      .bind(step, JSON.stringify(hashes), ctx.now, user.id);
    const changes = [{ path: "totp_secret_enc", op: user.totp_enabled ? "changed" : "added", old: user.totp_enabled ? "[redacted]" : undefined, new: "[redacted: changed]" }, { path: "mfa_enabled", op: "changed", old: !!user.totp_enabled, new: true }, { path: "recovery_codes", op: "changed", old: "[redacted]", new: "[redacted: changed]" }];
    if (token) {
      const fresh = { ...user, totp_enabled: 1, status: user.status === "invited" ? "active" : user.status };
      ctx.actor = actorOf(user);
      const tx = new Tx(ctx);
      tx.stmts.push(enrollStmt);
      tx.audit({ action: "auth.totp_enroll", resourceType: "user", resourceId: user.id, label: user.email, changes });
      await tx.commit();
      return finishLogin(ctx, fresh, { method: "totp_enrollment", tokenHash: token.token_hash, recoveryCodes: codes });
    }
    ctx.actor = actorOf(user, session.public_id);
    const tx = new Tx(ctx);
    tx.stmts.push(enrollStmt);
    tx.audit({ action: "auth.totp_enroll", resourceType: "user", resourceId: user.id, label: user.email, changes, meta: { re_enrollment: true } });
    await tx.commit();
    return { recovery_codes: codes, mfa_enabled: true };
  }
});

/* ---------------------------------------------------------------- signed-in session */
route({
  method: "GET", path: "/auth/session", op: "auth.whoami", tag: T, summary: "Who am I? Returns the user (or API key), effective permissions and — for cookie sessions — the CSRF token.",
  handler: async (ctx) => {
    const out = { actor_type: ctx.actor.type, user: publicUser(ctx.user), role: ctx.role ? { id: ctx.role.id, name: ctx.role.name } : { id: ctx.user.role_id }, is_owner: !!ctx.isOwner, permissions: toList(ctx.grant), game_scope: ctx.grant.gameScope };
    if (ctx.session) {
      out.csrf_token = await csrfToken(ctx.env, ctx.sid);
      out.session = { id: ctx.session.public_id, created_at: iso(ctx.session.created_at), expires_at: iso(ctx.session.expires_at), step_up_valid_until: iso(ctx.session.stepup_at + STEP_UP_MS) };
    }
    if (ctx.key) out.api_key = { id: ctx.key.id, name: ctx.key.name, prefix: ctx.key.prefix, require_approval: !!ctx.key.require_approval, force_dry_run: !!ctx.key.force_dry_run, rate_limit: ctx.key.rate_limit, expires_at: iso(ctx.key.expires_at) };
    out.resources = Object.keys(RESOURCES);
    return out;
  }
});

route({
  method: "POST", path: "/auth/step-up", op: "auth.step_up", tag: T, auth: "session", dryRun: false,
  summary: "Re-confirm with a 6-digit code before sensitive actions (valid 10 minutes).",
  body: S.obj({ code: code() }, ["code"]),
  handler: async (ctx, { body }) => {
    const db = ctx.env.DB;
    await enforce(db, `stepup:${ctx.session.public_id}`, 6, 900, ctx.now);
    const u = await db.prepare("SELECT * FROM users WHERE id = ?").bind(ctx.user.id).first();
    const secret = await decrypt(ctx.env.ENCRYPTION_KEY, u.totp_secret_enc, `totp:${u.id}`);
    const step = await verifyTotp(secret, body.code, { now: ctx.now, lastStep: u.totp_last_step });
    if (step === null) {
      await audit1(ctx, { action: "auth.step_up", result: "denied", resultReason: "wrong_code", resourceType: "user", resourceId: u.id, label: u.email });
      throw new ApiError(401, "invalid_code", "That code isn't right");
    }
    const until = ctx.now + STEP_UP_MS;
    const tx = new Tx(ctx);
    tx.run("UPDATE sessions SET stepup_at = ? WHERE id_hash = ?", ctx.now, ctx.session.id_hash);
    tx.run("UPDATE users SET totp_last_step = ? WHERE id = ?", step, u.id);
    tx.audit({ action: "auth.step_up", resourceType: "session", resourceId: ctx.session.public_id, label: u.email });
    await tx.commit();
    return { step_up_valid_until: iso(until) };
  }
});

route({
  method: "POST", path: "/auth/logout", op: "auth.logout", tag: T, auth: "session", dryRun: false, summary: "Sign out (revokes this session).",
  handler: async (ctx) => {
    const tx = new Tx(ctx);
    tx.run("UPDATE sessions SET revoked_at = ? WHERE id_hash = ?", ctx.now, ctx.session.id_hash);
    tx.audit({ action: "auth.logout", resourceType: "session", resourceId: ctx.session.public_id, label: ctx.user.email });
    await tx.commit();
    return reply({ signed_out: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
  }
});

const sessionOut = (s, current) => ({ id: s.public_id, current: s.public_id === current, created_at: iso(s.created_at), last_seen_at: iso(s.last_seen_at), expires_at: iso(s.expires_at), ip: s.ip, country: s.country, user_agent: s.user_agent, revoked_at: iso(s.revoked_at) });
export async function activeSessions(db, userId, now) {
  const { results } = await db.prepare("SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 100").bind(userId, now).all();
  return results;
}

route({
  method: "GET", path: "/auth/sessions", op: "auth.sessions_list", tag: T, auth: "session", summary: "My active sessions / devices.",
  handler: async (ctx) => (await activeSessions(ctx.env.DB, ctx.user.id, ctx.now)).map((s) => sessionOut(s, ctx.session.public_id))
});
route({
  method: "DELETE", path: "/auth/sessions/{id}", op: "auth.session_revoke", tag: T, auth: "session", dryRun: false, summary: "Sign out one of my devices.",
  handler: async (ctx, { params }) => {
    const s = await ctx.env.DB.prepare("SELECT * FROM sessions WHERE public_id = ? AND user_id = ?").bind(params.id, ctx.user.id).first();
    if (!s) throw new ApiError(404, "not_found", "Session not found");
    const tx = new Tx(ctx);
    tx.run("UPDATE sessions SET revoked_at = ? WHERE public_id = ?", ctx.now, params.id);
    tx.audit({ action: "auth.session_revoke", resourceType: "session", resourceId: params.id, label: `${ctx.user.email} · ${s.user_agent?.slice(0, 60) || "device"}` });
    await tx.commit();
    return { revoked: params.id };
  }
});
route({
  method: "POST", path: "/auth/sessions/revoke-all", op: "auth.sessions_revoke_all", tag: T, auth: "session", dryRun: false, summary: "Sign out everywhere (optionally keep this device).",
  body: S.obj({ keep_current: S.bool({ default: true }) }),
  handler: async (ctx, { body }) => {
    const tx = new Tx(ctx);
    if (body.keep_current) tx.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id_hash != ?", ctx.now, ctx.user.id, ctx.session.id_hash);
    else tx.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", ctx.now, ctx.user.id);
    tx.audit({ action: "auth.sessions_revoke_all", resourceType: "user", resourceId: ctx.user.id, label: ctx.user.email, meta: { keep_current: body.keep_current } });
    await tx.commit();
    return reply({ revoked: true }, body.keep_current ? {} : { headers: { "Set-Cookie": clearSessionCookie() } });
  }
});

route({
  method: "POST", path: "/auth/password", op: "auth.password_change", tag: T, auth: "session", dryRun: false, ipLimit: [10, 900],
  summary: "Change my password (signs out my other devices).",
  body: S.obj({ current_password: password(), new_password: password() }, ["current_password", "new_password"]),
  handler: async (ctx, { body }) => {
    const u = await ctx.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(ctx.user.id).first();
    if (!(await verifyPassword(body.current_password, u.password_hash))) {
      await audit1(ctx, { action: "auth.password_change", result: "denied", resultReason: "wrong_password", resourceType: "user", resourceId: u.id, label: u.email });
      throw new ApiError(401, "invalid_credentials", "Your current password is wrong");
    }
    const probs = passwordProblems(body.new_password, u);
    if (probs.length) throw new ApiError(400, "weak_password", `Password ${probs.join(", ")}`, probs);
    const tx = new Tx(ctx);
    tx.run("UPDATE users SET password_hash = ?, password_changed_at = ?, version = version + 1, updated_at = ? WHERE id = ?", await hashPassword(body.new_password), ctx.now, ctx.now, u.id);
    tx.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id_hash != ?", ctx.now, u.id, ctx.session.id_hash);
    tx.audit({ action: "auth.password_change", resourceType: "user", resourceId: u.id, label: u.email, changes: [{ path: "password", op: "changed", old: "[redacted]", new: "[redacted: changed]" }] });
    await tx.commit();
    return { changed: true };
  }
});

route({
  method: "POST", path: "/auth/recovery-codes", op: "auth.recovery_codes_regenerate", tag: T, auth: "session", dryRun: false, stepUp: true,
  summary: "Generate 10 new recovery codes (the old ones stop working). Shown once.",
  handler: async (ctx) => {
    const codes = generateRecoveryCodes(10);
    const tx = new Tx(ctx);
    tx.run("UPDATE users SET recovery_codes = ?, updated_at = ? WHERE id = ?", JSON.stringify(await Promise.all(codes.map(hashRecovery))), ctx.now, ctx.user.id);
    tx.audit({ action: "auth.recovery_codes_regenerate", resourceType: "user", resourceId: ctx.user.id, label: ctx.user.email, changes: [{ path: "recovery_codes", op: "changed", old: "[redacted]", new: "[redacted: changed]" }] });
    await tx.commit();
    return { recovery_codes: codes };
  }
});

/* ---------------------------------------------------------------- invites & password resets */
route({
  method: "POST", path: "/auth/invite/inspect", op: "auth.invite_inspect", tag: T, auth: "public", dryRun: false, ipLimit: [30, 900],
  summary: "Look up an invite / reset / enrollment link token (token travels in the body, never in a URL).",
  body: S.obj({ token: S.str(100, { minLength: 1 }) }, ["token"]),
  handler: async (ctx, { body }) => {
    const t = await findToken(ctx.env, body.token, ["invite", "reset", "enroll"], ctx.now);
    if (!t) throw new ApiError(404, "token_invalid", "This link is invalid, expired or already used. Ask an admin for a new one.");
    const u = await ctx.env.DB.prepare("SELECT id, email, name, status FROM users WHERE id = ?").bind(t.user_id).first();
    if (!u || u.status === "removed" || u.status === "suspended") throw new ApiError(404, "token_invalid", "This link is no longer valid.");
    return { kind: t.kind, email: u.email, name: u.name, expires_at: iso(t.expires_at), needs_password: t.kind === "enroll" && !!t.created_by };
  }
});
route({
  method: "POST", path: "/auth/invite/accept", op: "auth.invite_accept", tag: T, auth: "public", dryRun: false, ipLimit: [20, 900],
  summary: "Accept an invite or password-reset link: set a password. Invites continue with authenticator enrollment (returns an enrollment mfa_token).",
  body: S.obj({ token: S.str(100, { minLength: 1 }), password: password(), name: S.str(100) }, ["token", "password"]),
  handler: async (ctx, { body }) => {
    const db = ctx.env.DB;
    const t = await findToken(ctx.env, body.token, ["invite", "reset"], ctx.now);
    if (!t) throw new ApiError(404, "token_invalid", "This link is invalid, expired or already used.");
    const u = await db.prepare("SELECT * FROM users WHERE id = ?").bind(t.user_id).first();
    if (!u || u.status === "removed" || u.status === "suspended") throw new ApiError(404, "token_invalid", "This link is no longer valid.");
    const name = (body.name || u.name).trim() || u.name;
    const probs = passwordProblems(body.password, { email: u.email, name });
    if (probs.length) throw new ApiError(400, "weak_password", `Password ${probs.join(", ")}`, probs);
    ctx.actor = actorOf(u);
    const tx = new Tx(ctx);
    tx.run(consumeTokenSql, ctx.now, t.token_hash);
    tx.run("UPDATE users SET password_hash = ?, password_changed_at = ?, name = ?, failed_logins = 0, locked_until = NULL, version = version + 1, updated_at = ? WHERE id = ?", await hashPassword(body.password), ctx.now, name, ctx.now, u.id);
    tx.run("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", ctx.now, u.id);
    const changes = [{ path: "password", op: u.password_hash ? "changed" : "added", old: u.password_hash ? "[redacted]" : undefined, new: "[redacted: changed]" }];
    if (name !== u.name) changes.push({ path: "name", op: "changed", old: u.name, new: name });
    let enroll = null;
    if (!u.totp_enabled) { enroll = await prepareToken(ctx.env, "enroll", u.id, ENROLL_TTL, null, ctx.now); tx.stmts.push(enroll.stmt); }
    tx.audit({ action: t.kind === "invite" ? "auth.invite_accept" : "auth.password_reset", resourceType: "user", resourceId: u.id, label: u.email, changes });
    await tx.commit();
    return enroll ? { next: "enroll", mfa_token: enroll.token, expires_in: ENROLL_TTL / 1000 } : { next: "login" };
  }
});

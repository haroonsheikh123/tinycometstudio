/* Auth: TOTP (RFC 6238 vectors), passwords, setup, login, sessions, CSRF, lockout, step-up. Run: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hotp, totp, verifyTotp, base32Encode, base32Decode, otpauthUri, timeStep } from "../lib/admin/totp.js";
import { hashPassword, verifyPassword, passwordProblems, encrypt, decrypt, PBKDF2_ITERATIONS } from "../lib/admin/crypto.js";
import { encodeQr, qrSvg } from "../lib/admin/qr.js";
import { makeEnv, call, Session, bootstrapOwner, login, SETUP_TOKEN, nextCode, sql } from "./helpers.mjs";

const enc = new TextEncoder();

test("TOTP: RFC 6238 Appendix B test vectors (SHA-1/256/512, 8 digits)", async () => {
  const seeds = { SHA1: enc.encode("12345678901234567890"), SHA256: enc.encode("12345678901234567890123456789012"), SHA512: enc.encode("1234567890123456789012345678901234567890123456789012345678901234") };
  const vectors = [
    [59, "94287082", "46119246", "90693936"], [1111111109, "07081804", "68084774", "25091201"], [1111111111, "14050471", "67062674", "99943326"],
    [1234567890, "89005924", "91819424", "93441116"], [2000000000, "69279037", "90698825", "38618901"], [20000000000, "65353130", "77737706", "47863826"]
  ];
  for (const [t, s1, s256, s512] of vectors) {
    assert.equal(await totp(seeds.SHA1, t * 1000, { digits: 8 }), s1, `SHA1 @${t}`);
    assert.equal(await totp(seeds.SHA256, t * 1000, { digits: 8, algorithm: "SHA256" }), s256, `SHA256 @${t}`);
    assert.equal(await totp(seeds.SHA512, t * 1000, { digits: 8, algorithm: "SHA512" }), s512, `SHA512 @${t}`);
  }
  // RFC 4226 HOTP vectors (6 digits)
  const h = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  for (let i = 0; i < 10; i++) assert.equal(await hotp(seeds.SHA1, i), h[i]);
});

test("TOTP: ±1 step window, replay protection, base32, otpauth URI", async () => {
  const secret = base32Encode(enc.encode("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual([...base32Decode(secret)], [...enc.encode("12345678901234567890")]);
  const now = 1_700_000_000_000, step = timeStep(now);
  const prev = await totp(secret, now - 30_000), cur = await totp(secret, now), next = await totp(secret, now + 30_000), far = await totp(secret, now + 90_000);
  assert.equal(await verifyTotp(secret, cur, { now }), step);
  assert.equal(await verifyTotp(secret, prev, { now }), step - 1);
  assert.equal(await verifyTotp(secret, next, { now }), step + 1);
  assert.equal(await verifyTotp(secret, far, { now }), null, "outside the window");
  assert.equal(await verifyTotp(secret, cur, { now, lastStep: step }), null, "same code twice is rejected");
  assert.equal(await verifyTotp(secret, "12345", { now }), null);
  assert.equal(await verifyTotp(secret, "abcdef", { now }), null);
  assert.match(otpauthUri({ secret, account: "a@b.co" }), /^otpauth:\/\/totp\/Tiny%20Comet%20Studio%3Aa%40b\.co\?secret=GEZ.*&issuer=Tiny%20Comet%20Studio&algorithm=SHA1&digits=6&period=30$/);
});

test("QR encoder: structure + finder patterns + SVG", () => {
  const { size, modules, version } = encodeQr("otpauth://totp/x?secret=ABC", "M");
  assert.equal(size, version * 4 + 17);
  for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let i = 0; i < 7; i++) { assert.equal(modules[y0][x0 + i], true); assert.equal(modules[y0 + 6][x0 + i], true); }
    assert.equal(modules[y0 + 1][x0 + 1], false);
    assert.equal(modules[y0 + 3][x0 + 3], true);
  }
  assert.match(qrSvg("hello"), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29"/);
});

test("passwords: PBKDF2-SHA256 100k, salted, verify; policy", async () => {
  const h1 = await hashPassword("Orbit-Garden-42-sparkle!"), h2 = await hashPassword("Orbit-Garden-42-sparkle!");
  assert.match(h1, new RegExp(`^pbkdf2-sha256\\$${PBKDF2_ITERATIONS}\\$`));
  assert.ok(PBKDF2_ITERATIONS >= 100_000);
  assert.notEqual(h1, h2, "per-user salt");
  assert.equal(await verifyPassword("Orbit-Garden-42-sparkle!", h1), true);
  assert.equal(await verifyPassword("orbit-garden-42-sparkle!", h1), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
  assert.ok(passwordProblems("short").length);
  assert.ok(passwordProblems("passwordpassword").length);
  assert.ok(passwordProblems("haroon-super-long-pass", { email: "haroon@x.com" }).length);
  assert.deepEqual(passwordProblems("Comet-launch-Lahore-2026!"), []);
});

test("AES-GCM at rest: round-trip, bound to context", async () => {
  const box = await encrypt("k".repeat(32), "JBSWY3DPEHPK3PXP", "totp:usr_1");
  assert.match(box, /^v1\./);
  assert.equal(await decrypt("k".repeat(32), box, "totp:usr_1"), "JBSWY3DPEHPK3PXP");
  await assert.rejects(decrypt("k".repeat(32), box, "totp:usr_2"));
  await assert.rejects(decrypt("x".repeat(32), box, "totp:usr_1"));
});

test("setup: needs SETUP_TOKEN, creates the owner once, then disables itself", async () => {
  const env = await makeEnv();
  assert.equal((await call(env, "GET", "/setup")).data.setup_required, true);
  const bad = await call(env, "POST", "/setup", { body: { setup_token: "nope", email: "a@b.co", name: "A", password: "Comet-launch-Lahore-2026!" } });
  assert.equal(bad.status, 403);
  const weak = await call(env, "POST", "/setup", { body: { setup_token: SETUP_TOKEN, email: "a@b.co", name: "A", password: "password" } });
  assert.equal(weak.status, 400);
  const s = await bootstrapOwner(env);
  assert.ok(s.cookie && s.csrf);
  assert.equal(s.recovery.length, 10);
  assert.equal((await call(env, "GET", "/setup")).data.setup_required, false);
  const again = await call(env, "POST", "/setup", { body: { setup_token: SETUP_TOKEN, email: "x@b.co", name: "X", password: "Comet-launch-Lahore-2026!" } });
  assert.equal(again.status, 410);
  const noToken = await makeEnv({ extra: { SETUP_TOKEN: undefined } });
  assert.equal((await call(noToken, "POST", "/setup", { body: { setup_token: "whatever-long-enough", email: "a@b.co", name: "A", password: "Comet-launch-Lahore-2026!" } })).status, 503);
});

test("login: password then TOTP (mandatory); wrong password vs wrong code are audited separately", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const wrongPw = await call(env, "POST", "/auth/login", { body: { email: owner.email, password: "nope-nope-nope" } });
  assert.equal(wrongPw.status, 401);
  assert.equal(wrongPw.error.code, "invalid_credentials");
  const unknown = await call(env, "POST", "/auth/login", { body: { email: "ghost@x.co", password: "nope-nope-nope" } });
  assert.equal(unknown.error.code, "invalid_credentials", "same error for unknown accounts");
  const step1 = await call(env, "POST", "/auth/login", { body: { email: owner.email, password: owner.password } });
  assert.equal(step1.status, 200);
  assert.equal(step1.data.mfa_required, "totp");
  assert.equal(step1.headers.get("Set-Cookie"), null, "no session before the second factor");
  const wrongCode = await call(env, "POST", "/auth/mfa", { body: { mfa_token: step1.data.mfa_token, code: "000000" } });
  assert.equal(wrongCode.status, 401);
  const { res } = await login(env, owner.email, owner.password, owner.secret);
  assert.equal(res.status, 200);
  const cookie = res.headers.get("Set-Cookie");
  assert.match(cookie, /^__Host-tc_session=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
  const audit = await owner.req("GET", "/audit", { query: undefined });
  const reasons = audit.data.filter((e) => e.action === "auth.login").map((e) => `${e.result}:${e.result_reason ?? ""}`);
  for (const r of ["denied:wrong_password", "denied:unknown_account", "denied:wrong_code", "success:"]) assert.ok(reasons.includes(r), `missing ${r} in ${reasons}`);
  const ok = audit.data.find((e) => e.action === "auth.login" && e.result === "success");
  assert.equal(ok.ip, "203.0.113.7");
  assert.equal(ok.device, "Chrome on Linux");
});

test("login: recovery code works once", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const go = async () => { const a = await call(env, "POST", "/auth/login", { body: { email: owner.email, password: owner.password } }); return call(env, "POST", "/auth/mfa", { body: { mfa_token: a.data.mfa_token, recovery_code: owner.recovery[0].toUpperCase() } }); };
  const first = await go();
  assert.equal(first.status, 200);
  assert.equal(first.data.user.recovery_codes_left, 9);
  assert.equal((await go()).status, 401);
});

test("lockout after repeated failures; Turnstile required after failures when configured", async () => {
  const env = await makeEnv({ extra: { TURNSTILE_SECRET: "1x0000000000000000000000000000000AA" } });
  const owner = await bootstrapOwner(env);
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await call(env, "POST", "/auth/login", { body: { email: owner.email, password: "wrong-wrong-wrong", ...(i >= 3 ? { turnstile_token: "XXXX.DUMMY.TOKEN" } : {}) }, headers: { "CF-Connecting-IP": `198.51.100.${i}` } });
    statuses.push(r.error.code);
  }
  assert.deepEqual(statuses.slice(0, 3), ["invalid_credentials", "invalid_credentials", "invalid_credentials"]);
  // after 3 failures the account needs a captcha: without a token → captcha_required
  const noCaptcha = await call(env, "POST", "/auth/login", { body: { email: owner.email, password: owner.password }, headers: { "CF-Connecting-IP": "198.51.100.99" } });
  assert.equal(noCaptcha.error.code, "captcha_required");
  assert.equal(noCaptcha.error.details.site_key, "1x00000000000000000000AA");
  // 5+ failures → temporary lockout even with the right password (captcha mocked as passing)
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ success: true }));
  try {
    const locked = await call(env, "POST", "/auth/login", { body: { email: owner.email, password: owner.password, turnstile_token: "ok" }, headers: { "CF-Connecting-IP": "198.51.100.98" } });
    assert.equal(locked.status, 423);
  } finally { globalThis.fetch = orig; }
});

test("sessions: CSRF required for cookie writes, cross-origin refused, logout & sign-out-everywhere revoke", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const noCsrf = await call(env, "PATCH", "/games/project-nova", { body: { tagline: "x" }, headers: { Cookie: owner.cookie } });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.error.code, "csrf_failed");
  const xo = await call(env, "PATCH", "/games/project-nova", { body: { tagline: "x" }, headers: { Cookie: owner.cookie, "X-CSRF-Token": owner.csrf, Origin: "https://evil.example" } });
  assert.equal(xo.error.code, "csrf_failed");
  const forged = await call(env, "GET", "/auth/session", { headers: { Cookie: owner.cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A")) } });
  assert.equal(forged.status, 401, "tampered cookie signature");
  const second = (await login(env, owner.email, owner.password, owner.secret)).session;
  const list = await owner.req("GET", "/auth/sessions");
  assert.equal(list.data.length, 2);
  assert.ok(list.data.some((s) => s.current));
  assert.equal((await owner.req("POST", "/auth/sessions/revoke-all", { body: { keep_current: true } })).status, 200);
  assert.equal((await second.req("GET", "/auth/session")).status, 401, "other device signed out");
  assert.equal((await owner.req("GET", "/auth/session")).status, 200);
  await owner.req("POST", "/auth/logout");
  assert.equal(owner.cookie, null);
});

test("sessions: idle timeout and absolute expiry", async () => {
  const env = await makeEnv({ extra: { SESSION_IDLE_MINUTES: "5" } });
  const owner = await bootstrapOwner(env);
  await sql(env, `UPDATE sessions SET last_seen_at = ${Date.now() - 6 * 60_000}`);
  assert.equal((await owner.req("GET", "/auth/session")).status, 401, "idle");
  const s2 = (await login(env, owner.email, owner.password, owner.secret)).session;
  await sql(env, `UPDATE sessions SET expires_at = ${Date.now() - 1} WHERE revoked_at IS NULL`);
  assert.equal((await s2.req("GET", "/auth/session")).status, 401, "absolute");
});

test("step-up: sensitive actions need a fresh TOTP code", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  await sql(env, `UPDATE sessions SET stepup_at = ${Date.now() - 11 * 60_000}`);
  const r = await owner.req("POST", "/api-keys", { body: { name: "k", scopes: ["games:read"] } });
  assert.equal(r.status, 403);
  assert.equal(r.error.code, "step_up_required");
  assert.equal((await owner.req("POST", "/auth/step-up", { body: { code: "000000" } })).status, 401);
  assert.equal((await owner.req("POST", "/auth/step-up", { body: { code: await nextCode(owner.secret) } })).status, 200);
  assert.equal((await owner.req("POST", "/api-keys", { body: { name: "k", scopes: ["games:read"] } })).status, 201);
});

test("invite → set password → mandatory TOTP enrollment; password alone never creates a session", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const inv = await owner.req("POST", "/users", { body: { email: "sana@tinycometstudio.com", name: "Sana", role_id: "editor" } });
  assert.equal(inv.status, 201);
  const token = inv.data.invite_url.split("#")[1];
  assert.equal((await call(env, "POST", "/auth/invite/inspect", { body: { token } })).data.email, "sana@tinycometstudio.com");
  const acc = await call(env, "POST", "/auth/invite/accept", { body: { token, password: "Stardust-notes-blue-77" } });
  assert.equal(acc.data.next, "enroll");
  assert.equal(acc.headers.get("Set-Cookie"), null);
  assert.equal((await call(env, "POST", "/auth/invite/accept", { body: { token, password: "Stardust-notes-blue-77" } })).status, 404, "one use");
  const pwOnly = await call(env, "POST", "/auth/login", { body: { email: "sana@tinycometstudio.com", password: "Stardust-notes-blue-77" } });
  assert.equal(pwOnly.error.code, "mfa_enrollment_required");
  const s = new Session(env);
  const setup = await s.req("POST", "/auth/totp/setup", { body: { mfa_token: acc.data.mfa_token } });
  assert.match(setup.data.qr_svg, /^<svg/);
  const conf = await s.req("POST", "/auth/totp/confirm", { body: { mfa_token: acc.data.mfa_token, code: await nextCode(setup.data.secret) } });
  assert.equal(conf.status, 200);
  assert.equal((await s.req("GET", "/auth/session")).data.user.status, "active");
  // admin resets 2FA → enrollment link that ALSO needs the password
  const reset = await owner.req("POST", `/users/${conf.data.user.id}/reset-2fa`);
  assert.equal(reset.status, 200);
  assert.equal((await s.req("GET", "/auth/session")).status, 401, "signed out");
  const et = reset.data.enroll_url.split("#")[1];
  assert.equal((await call(env, "POST", "/auth/totp/setup", { body: { mfa_token: et } })).status, 401);
  assert.equal((await call(env, "POST", "/auth/totp/setup", { body: { mfa_token: et, password: "Stardust-notes-blue-77" } })).status, 200);
  const audit = await owner.req("GET", "/audit", { query: undefined });
  assert.ok(audit.data.some((e) => e.action === "user.reset_2fa" && e.actor_email === owner.email));
});

test("TOTP secrets and password hashes are never returned by the API", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  for (const path of ["/auth/session", "/users", "/audit?limit=100", "/audit/export"]) {
    const r = await owner.req("GET", path);
    const t = r.text;
    assert.ok(!t.includes(owner.secret), `${path} leaks the TOTP secret`);
    assert.ok(!/pbkdf2-sha256\$/.test(t), `${path} leaks a password hash`);
    assert.ok(!/"v1\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"/.test(t), `${path} leaks ciphertext`);
  }
});

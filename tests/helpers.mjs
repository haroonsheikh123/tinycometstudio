/* Test harness: real migrations on node:sqlite (D1-compatible shim), in-memory R2, a cookie/CSRF-aware client. */
import { D1Shim, R2Mock } from "../tools/dev/d1-shim.mjs";
import { buildSeedSql } from "../tools/db-seed.mjs";
import { handleApi } from "../lib/admin/api.js";
import { totp } from "../lib/admin/totp.js";

export const ORIGIN = "https://tinycometstudio.com";
export const SETUP_TOKEN = "test-setup-token-0123456789abcdef";

export async function makeEnv({ seed = true, extra = {} } = {}) {
  const db = new D1Shim().migrate();
  if (seed) db.db.exec(await buildSeedSql());
  return { DB: db, MEDIA: new R2Mock(), SIGNING_KEY: "s".repeat(48), ENCRYPTION_KEY: "e".repeat(48), SETUP_TOKEN, ENVIRONMENT: "production", DISABLE_AUTO_TICK: "1", ...extra };
}

/** Call the API like Pages would. */
export async function call(env, method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { Origin: ORIGIN, "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36", "CF-Connecting-IP": "203.0.113.7", ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const waits = [];
  const res = await handleApi({ request: new Request(ORIGIN + "/api/v1" + path, init), env, waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, text, data: json?.data, error: json?.error };
}

/** A signed-in admin browser session (cookie + CSRF), created through the real API flow. */
export class Session {
  constructor(env) { this.env = env; this.cookie = null; this.csrf = null; this.secret = null; this.clock = Date.now(); }
  async req(method, path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.csrf && method !== "GET") headers["X-CSRF-Token"] = this.csrf;
    const r = await call(this.env, method, path, { ...opts, headers });
    const sc = r.headers.get("Set-Cookie");
    if (sc) { const v = sc.split(";")[0]; this.cookie = v.endsWith("=") ? null : v; }
    if (r.data?.csrf_token) this.csrf = r.data.csrf_token;
    return r;
  }
  /** A fresh, never-used code (advances a fake clock by 30 s per call to dodge replay protection). */
  async code() { this.clock += 31_000; return totp(this.secret, this.clock); }
}

/** setup → enroll → signed-in owner session */
export async function bootstrapOwner(env, { email = "haroon@tinycometstudio.com", name = "Haroon Sheikh", password = "Orbit-Garden-42-sparkle!" } = {}) {
  const s = new Session(env);
  const r = await s.req("POST", "/setup", { body: { setup_token: SETUP_TOKEN, email, name, password } });
  if (r.status !== 201) throw new Error("setup failed " + r.text);
  const setup = await s.req("POST", "/auth/totp/setup", { body: { mfa_token: r.data.mfa_token } });
  s.secret = setup.data.secret;
  const conf = await s.req("POST", "/auth/totp/confirm", { body: { mfa_token: r.data.mfa_token, code: await totp(s.secret) } });
  if (conf.status !== 200) throw new Error("confirm failed " + conf.text);
  s.recovery = conf.data.recovery_codes;
  s.password = password; s.email = email;
  return s;
}

/** Log in an existing user (email/password/TOTP) with real codes. */
export async function login(env, email, password, secret) {
  const s = new Session(env);
  s.secret = secret;
  const a = await s.req("POST", "/auth/login", { body: { email, password } });
  if (a.status !== 200) return { session: s, res: a };
  const b = await s.req("POST", "/auth/mfa", { body: { mfa_token: a.data.mfa_token, code: await totp(secret) } });
  return { session: s, res: b };
}

/** Run with a mocked fetch (webhooks, Turnstile). */
export function mockFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

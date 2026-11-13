/* Test harness: real migrations on node:sqlite (D1-compatible shim) — or on MySQL/MariaDB with
   TEST_DB_DRIVER=mysql (MYSQL_URL=mysql://user:pass@host/any, a fresh database per env, dropped afterwards) —
   in-memory R2 (or the Node host's FsBucket with TEST_STORAGE=fs), a cookie/CSRF-aware client. */
import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D1Shim, R2Mock } from "../tools/dev/d1-shim.mjs";
import { buildSeedSql } from "../tools/db-seed.mjs";
import { handleApi } from "../lib/admin/api.js";
import { totp, timeStep } from "../lib/admin/totp.js";

/** A never-reused code (server rejects steps ≤ the last one used): current step, else the next one (±1 window). */
const usedSteps = new Map();
export function nextCode(secret) {
  const last = usedSteps.get(secret) ?? -1, cur = timeStep();
  const step = cur > last ? cur : last + 1;
  if (step > cur + 1) throw new Error("test used more than 2 codes in one 30 s window");
  usedSteps.set(secret, step);
  return totp(secret, step * 30_000 + 500);
}

export const ORIGIN = "https://tinycometstudio.com";
export const SETUP_TOKEN = "test-setup-token-0123456789abcdef";

export const DB_DRIVER = process.env.TEST_DB_DRIVER || "sqlite";
const cleanups = [];
after(async () => { for (const c of cleanups.splice(0)) await c().catch(() => {}); });
let dbCounter = 0;

export async function makeDb({ seed = true } = {}) {
  if (DB_DRIVER === "mysql") {
    const { MysqlD1, parseMysqlUrl } = await import("../lib/platform/db/mysql.js");
    const { migrate } = await import("../lib/platform/db/migrate.js");
    const base = parseMysqlUrl(process.env.MYSQL_URL || "mysql://tc:tcpass@127.0.0.1:3306/tinycomet_test");
    const name = `tinycomet_t${process.pid}_${dbCounter++}`;
    const admin = await MysqlD1.open({ ...base, database: "" });
    await admin.rawQuery(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    const db = await MysqlD1.open({ ...base, database: name });
    cleanups.push(async () => { await db.close(); await admin.rawQuery(`DROP DATABASE IF EXISTS \`${name}\``); await admin.close(); });
    await migrate(db);
    if (seed) await db.exec(await buildSeedSql());
    return db;
  }
  const db = new D1Shim().migrate();
  if (seed) await db.exec(await buildSeedSql());
  return db;
}
/** MySQL only: create an empty database for a test and return its mysql:// URL (dropped after the file's tests). */
export async function freshMysqlUrl() {
  const { MysqlD1, parseMysqlUrl } = await import("../lib/platform/db/mysql.js");
  const raw = process.env.MYSQL_URL || "mysql://tc:tcpass@127.0.0.1:3306/tinycomet_test";
  const base = parseMysqlUrl(raw);
  const name = `tinycomet_t${process.pid}_${dbCounter++}`;
  const admin = await MysqlD1.open({ ...base, database: "" });
  await admin.rawQuery(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  cleanups.push(async () => { await admin.rawQuery(`DROP DATABASE IF EXISTS \`${name}\``); await admin.close(); });
  const u = new URL(raw); u.pathname = "/" + name;
  return u.toString();
}
export function makeMedia() {
  if (process.env.TEST_STORAGE !== "fs") return new R2Mock();
  const dir = mkdtempSync(join(tmpdir(), "tc-media-"));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  return import("../lib/platform/storage/fs-bucket.js").then(({ FsBucket }) => new FsBucket(dir));
}
/** Driver-agnostic raw SQL for tests (SQLite dialect; translated on MySQL). */
export const sql = (env, script) => env.DB.exec(script);
export const row = (env, q, ...p) => env.DB.prepare(q).bind(...p).first();
export const rows = async (env, q, ...p) => (await env.DB.prepare(q).bind(...p).all()).results;

export async function makeEnv({ seed = true, extra = {} } = {}) {
  const db = await makeDb({ seed });
  return { DB: db, MEDIA: await makeMedia(), SIGNING_KEY: "s".repeat(48), ENCRYPTION_KEY: "e".repeat(48), SETUP_TOKEN, ENVIRONMENT: "production", DISABLE_AUTO_TICK: "1", ...extra };
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
  code() { return nextCode(this.secret); }
}

/** setup → enroll → signed-in owner session */
export async function bootstrapOwner(env, { email = "haroon@tinycometstudio.com", name = "Haroon Sheikh", password = "Orbit-Garden-42-sparkle!" } = {}) {
  const s = new Session(env);
  const r = await s.req("POST", "/setup", { body: { setup_token: SETUP_TOKEN, email, name, password } });
  if (r.status !== 201) throw new Error("setup failed " + r.text);
  const setup = await s.req("POST", "/auth/totp/setup", { body: { mfa_token: r.data.mfa_token } });
  s.secret = setup.data.secret;
  const conf = await s.req("POST", "/auth/totp/confirm", { body: { mfa_token: r.data.mfa_token, code: await nextCode(s.secret) } });
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
  const b = await s.req("POST", "/auth/mfa", { body: { mfa_token: a.data.mfa_token, code: await nextCode(secret) } });
  return { session: s, res: b };
}

/** Run with a mocked fetch (webhooks, Turnstile). */
export function mockFetch(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

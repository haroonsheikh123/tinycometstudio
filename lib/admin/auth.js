/* Sessions (cookie), CSRF, one-time tokens, API keys. */
import { randomToken, randomId, sha256Hex, hmacB64, deriveKey, safeEqual, b64url, randomBytes } from "./crypto.js";
import { ApiError } from "./http.js";
import { ipAllowed } from "./http.js";
import { grant, roleGrant, intersect, expand } from "./permissions.js";
import { j } from "./content.js";

export const SESSION_COOKIE = "__Host-tc_session";
export const STEP_UP_MS = 10 * 60 * 1000;
export const sessionLimits = (env) => ({
  idleMs: Math.max(5, Number(env?.SESSION_IDLE_MINUTES) || 120) * 60_000,
  maxMs: Math.min(24 * 30, Math.max(1, Number(env?.SESSION_MAX_HOURS) || 12)) * 3_600_000
});

const subKeys = new Map();
async function subKey(env, purpose) {
  if (!env.SIGNING_KEY) throw new ApiError(500, "misconfigured", "SIGNING_KEY is not configured");
  const id = purpose + ":" + env.SIGNING_KEY;
  if (!subKeys.has(id)) subKeys.set(id, await deriveKey(env.SIGNING_KEY, purpose));
  return subKeys.get(id);
}

/* ---------------------------------------------------------------- cookies */
export function getCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
export const sessionCookie = (value, maxAgeSec) => `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`;
export const clearSessionCookie = () => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/* ---------------------------------------------------------------- sessions */
/** Prepare a new session: returns { stmt, cookie, csrf, publicId }. The cookie is "<id>.<HMAC>"; only SHA-256(id) is stored.
    The caller runs `stmt` inside its Tx so the session and its audit entry are written together. */
export async function prepareSession(env, user, info, now = Date.now()) {
  const sid = randomToken(32);
  const publicId = randomId("ses_", 12);
  const { maxMs } = sessionLimits(env);
  const stmt = env.DB.prepare("INSERT INTO sessions (id_hash, public_id, user_id, created_at, last_seen_at, expires_at, stepup_at, ip, country, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(sid), publicId, user.id, now, now, now + maxMs, now, info.ip || null, info.country || null, String(info.ua || "").slice(0, 300));
  const sig = await hmacB64(await subKey(env, "session-cookie"), sid);
  return { stmt, cookie: sessionCookie(`${sid}.${sig}`, Math.floor(maxMs / 1000)), csrf: await csrfToken(env, sid), publicId, sid };
}

/** Resolve the session cookie → { session, user, sid } or null. Applies idle/absolute timeouts and slides last_seen_at. */
export async function readSession(env, request, now = Date.now()) {
  const raw = getCookie(request, SESSION_COOKIE);
  if (!raw || raw.length > 200) return null;
  const [sid, sig] = raw.split(".");
  if (!sid || !sig) return null;
  const expect = await hmacB64(await subKey(env, "session-cookie"), sid);
  if (!safeEqual(expect, sig)) return null;
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(await sha256Hex(sid)).first();
  if (!s || s.revoked_at) return null;
  const { idleMs } = sessionLimits(env);
  if (now > s.expires_at || now - s.last_seen_at > idleMs) return null;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(s.user_id).first();
  if (!user || user.status !== "active" || !user.totp_enabled) return null;
  if (now - s.last_seen_at > 60_000) await env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?").bind(now, s.id_hash).run();
  return { session: s, user, sid };
}

export async function csrfToken(env, sid) { return hmacB64(await subKey(env, "csrf"), sid); }
export async function checkCsrf(env, request, sid) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) throw new ApiError(403, "csrf_failed", "Cross-origin request refused");
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") throw new ApiError(403, "csrf_failed", "Cross-site request refused");
  const token = request.headers.get("X-CSRF-Token") || "";
  if (!token || !safeEqual(token, await csrfToken(env, sid))) throw new ApiError(403, "csrf_failed", "Missing or invalid X-CSRF-Token header");
}

/* ---------------------------------------------------------------- one-time tokens (invite, reset, mfa, enroll) */
/** Prepare a one-time token: returns { token, stmt } (only its SHA-256 is stored). */
export async function prepareToken(env, kind, userId, ttlMs, createdBy = null, now = Date.now()) {
  const token = randomToken(32);
  const stmt = env.DB.prepare("INSERT INTO tokens (token_hash, kind, user_id, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), kind, userId, now, now + ttlMs, createdBy);
  return { token, stmt, expiresAt: now + ttlMs };
}
/** Look up a usable token of one of `kinds` (not used, not expired, < 5 failed attempts). */
export async function findToken(env, token, kinds, now = Date.now()) {
  if (!token || typeof token !== "string" || token.length > 100) return null;
  const t = await env.DB.prepare("SELECT * FROM tokens WHERE token_hash = ?").bind(await sha256Hex(token)).first();
  if (!t || !kinds.includes(t.kind) || t.used_at || t.expires_at < now || t.attempts >= 5) return null;
  return t;
}
export const consumeTokenSql = "UPDATE tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL";

/* ---------------------------------------------------------------- recovery codes */
export function generateRecoveryCodes(n = 10) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () => {
    const b = randomBytes(10);
    const s = [...b].map((x) => alphabet[x % alphabet.length]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
export const normRecovery = (c) => String(c || "").toLowerCase().replace(/[^a-z0-9]/g, "");
export const hashRecovery = (c) => sha256Hex("tc-recovery:" + normRecovery(c));

/* ---------------------------------------------------------------- API keys */
export const KEY_PREFIX = "tck_";
/** New key: "tck_<12-char id>_<43-char secret>" (or a new secret for an existing prefix — rotation). Returns { key, prefix, hash }. */
export async function generateApiKey(existingPrefix = null) {
  const prefix = existingPrefix || `${KEY_PREFIX}${randomId("", 12)}`;
  const key = `${prefix}_${b64url(randomBytes(32))}`;
  return { key, prefix, hash: await sha256Hex(key) };
}
export const parseKeyPrefix = (key) => { const m = /^(tck_[a-z0-9]{12})_[A-Za-z0-9_-]{43}$/.exec(String(key || "")); return m ? m[1] : null; };

/** Effective grant of a key = (scopes ∪ role) ∩ creator's current access. */
export function keyGrant(key, keyRole, owner, ownerRole) {
  const scopes = j(key.scopes, []);
  const scopeGrant = grant(scopes);
  let g = scopeGrant;
  if (keyRole) {
    const rg = roleGrant(keyRole);
    g = rg.all || scopeGrant.all ? { all: true, perms: new Set(["*"]), gameScope: rg.gameScope } : { all: false, perms: new Set([...scopeGrant.perms, ...rg.perms]), gameScope: rg.gameScope };
  }
  const ownerG = owner.status === "active" ? roleGrant(ownerRole) : grant([]);
  return intersect(g, ownerG);
}

/**
 * Verify a bearer key against everything except the kill switch and the rate limit (checked by the caller).
 * @returns {{ key, reason?: string }}  reason ∈ unknown|revoked|disabled|expired|ip_not_allowed|environment_not_allowed
 */
export async function checkApiKey(env, presented, ip, now = Date.now()) {
  const prefix = parseKeyPrefix(presented);
  if (!prefix) return { key: null, reason: "malformed" };
  const key = await env.DB.prepare("SELECT * FROM api_keys WHERE prefix = ?").bind(prefix).first();
  if (!key) return { key: null, reason: "unknown" };
  const h = await sha256Hex(presented);
  const current = safeEqual(h, key.key_hash);
  const previous = !current && key.prev_key_hash && key.prev_valid_until > now && safeEqual(h, key.prev_key_hash);
  if (!current && !previous) return { key: null, reason: "unknown" };
  if (key.revoked_at) return { key, reason: "revoked" };
  if (!key.enabled) return { key, reason: "disabled" };
  if (key.expires_at && key.expires_at <= now) return { key, reason: "expired" };
  if (!ipAllowed(ip, j(key.ip_allowlist, []))) return { key, reason: "ip_not_allowed" };
  const envName = env.ENVIRONMENT || "production";
  if (!j(key.environments, []).includes(envName)) return { key, reason: "environment_not_allowed" };
  return { key, previous };
}

export const expandScopes = (s) => [...expand(s)];

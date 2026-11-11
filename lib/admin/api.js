/* /api/v1 request pipeline.
   auth (session cookie + CSRF, or Bearer API key) → kill switch → rate limit → permission → validation
   → dry-run / approval queue / idempotency → handler (writes only through Tx, which audits) → response envelope. */
import { match, routes } from "./router.js";
import "./routes/index.js";
import { ApiError, jsonResponse, errorResponse, clientInfo, readJson, forbidden } from "./http.js";
import { validate } from "./schema.js";
import { randomId, sha256Hex } from "./crypto.js";
import { can, roleGrant, grant as makeGrant } from "./permissions.js";
import { readSession, checkCsrf, checkApiKey, keyGrant, STEP_UP_MS } from "./auth.js";
import { enforce, headers as rlHeaders } from "./ratelimit.js";
import { makeEntry, writeAudit } from "./audit.js";
import { getState, invalidatePublicState } from "./state.js";
import { attemptDelivery } from "./webhooks.js";
import { runTick } from "./tick.js";
import { j } from "./content.js";
import { Tx } from "./tx.js";

export const API_PREFIX = "/api/v1";

export function baseContext({ request, env, waitUntil }) {
  const info = clientInfo(request);
  const h = request.headers;
  const agent = (h.get("X-Agent-Name") || "").replace(/[^\w .:@/-]/g, "").slice(0, 80) || null;
  const wait = waitUntil || ((p) => { p?.catch?.(() => {}); });
  const ctx = {
    env, request, url: new URL(request.url), reqId: "req_" + randomId("", 16), now: Date.now(), method: request.method,
    ip: info.ip, country: info.country, city: info.city, ua: info.ua, device: info.deviceLabel, deviceType: info.device,
    source: "api", agentName: agent, changeReason: (h.get("X-Change-Reason") || "").slice(0, 1000) || null,
    actor: { type: "anonymous", id: null, name: "Anonymous" }, grant: makeGrant([]), user: null, key: null, session: null,
    dryRun: false, txs: [], resHeaders: {}, waitUntil: wait
  };
  ctx.onContentChanged = (paths) => { invalidatePublicState(); wait(purgeZone(env, paths)); };
  ctx.onDeliveries = (ids) => wait((async () => { for (const id of ids) await attemptDelivery(env, id).catch(() => {}); })());
  return ctx;
}

async function principalForUser(env, user) {
  const role = await env.DB.prepare("SELECT * FROM roles WHERE id = ?").bind(user.role_id).first();
  const r = role ? { ...role, permissions: j(role.permissions, []), game_scope: j(role.game_scope, null) } : null;
  return { role: r, grant: user.role_id === "owner" ? makeGrant(["*"]) : roleGrant(r) };
}
export async function loadKeyPrincipal(ctx, key) {
  const env = ctx.env;
  const owner = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(key.owner_user_id).first();
  if (!owner) throw new ApiError(401, "invalid_api_key", "The key's owner no longer exists");
  const { role: ownerRole } = await principalForUser(env, owner);
  let keyRole = null;
  if (key.role_id) { const r = await env.DB.prepare("SELECT * FROM roles WHERE id = ?").bind(key.role_id).first(); keyRole = r && { ...r, permissions: j(r.permissions, []), game_scope: j(r.game_scope, null) }; }
  ctx.key = key;
  ctx.user = owner;
  ctx.isOwner = owner.role_id === "owner";
  ctx.grant = keyGrant(key, keyRole, owner, ownerRole);
  ctx.actor = { type: "api_key", id: owner.id, name: owner.name, email: owner.email, role: ownerRole?.name || owner.role_id, apiKeyId: key.id, apiKeyName: key.name };
  ctx.source = ctx.agentName ? `agent:${ctx.agentName}` : "api";
  if (key.force_dry_run) ctx.forceDryRun = true;
}

async function authenticate(ctx, route) {
  const { env, request } = ctx;
  const authz = request.headers.get("Authorization") || "";
  if (/^Bearer\s+/i.test(authz)) {
    const presented = authz.replace(/^Bearer\s+/i, "").trim();
    const { key, reason } = await checkApiKey(env, presented, ctx.ip, ctx.now);
    if (reason) {
      const label = key ? key.name : null;
      await auditDenied(ctx, { action: "auth.api_key", resultReason: reason, resourceType: "api_key", resourceId: key?.id, label, apiKey: key });
      const msg = { revoked: "This API key was revoked", disabled: "This API key is disabled", expired: "This API key has expired", ip_not_allowed: "Requests from this IP are not allowed for this key", environment_not_allowed: "This key is not allowed in this environment" }[reason];
      throw new ApiError(401, "invalid_api_key", msg || "Invalid API key", key ? { reason } : undefined);
    }
    const st = await getState(env.DB, ["kill_switch"]);
    if (st.kill_switch?.enabled) {
      await auditDenied(ctx, { action: "auth.api_key", resultReason: "kill_switch", resourceType: "api_key", resourceId: key.id, label: key.name, apiKey: key });
      throw new ApiError(503, "api_keys_disabled", "API-key access is switched off by an administrator (kill switch)");
    }
    await loadKeyPrincipal(ctx, key);
    let rl;
    try { rl = await enforce(env.DB, `key:${key.id}`, key.rate_limit, 60, ctx.now); }
    catch (e) {
      if (e.code === "rate_limited" && e.details?.retry_after != null) await auditDenied(ctx, { action: "auth.rate_limited", resultReason: `exceeded ${key.rate_limit}/min`, resourceType: "api_key", resourceId: key.id, label: key.name, once: `rl:${key.id}:${Math.floor(ctx.now / 60000)}` });
      throw e;
    }
    Object.assign(ctx.resHeaders, rlHeaders(rl));
    await env.DB.prepare("UPDATE api_keys SET last_used_at = ?, last_used_ip = ?, usage_count = usage_count + 1 WHERE id = ?").bind(ctx.now, ctx.ip, key.id).run();
    if (route.auth === "session") throw new ApiError(403, "session_required", "This endpoint can only be used from a signed-in admin session, not with an API key");
    return;
  }
  const s = await readSession(env, request, ctx.now);
  if (s) {
    const { role, grant } = await principalForUser(env, s.user);
    ctx.user = s.user; ctx.session = s.session; ctx.sid = s.sid; ctx.grant = grant; ctx.role = role;
    ctx.isOwner = s.user.role_id === "owner";
    ctx.actor = { type: "user", id: s.user.id, name: s.user.name, email: s.user.email, role: role?.name || s.user.role_id, sessionId: s.session.public_id };
    ctx.source = "admin_ui";
    if (route.write && route.auth !== "public" && route.auth !== "mfa") await checkCsrf(env, request, s.sid);
    Object.assign(ctx.resHeaders, rlHeaders(await enforce(env.DB, `user:${s.user.id}`, Number(env.SESSION_RATE_LIMIT) || 600, 60, ctx.now)));
    return;
  }
  if (route.auth === "user" || route.auth === "session") throw new ApiError(401, "unauthenticated", "Sign in, or send an API key as 'Authorization: Bearer tck_…'");
}
function checkOrigin(ctx, route) {
  // public / mfa routes: unsafe requests must be same-origin when sent by a browser
  const { request } = ctx;
  if (route.write && (route.auth === "public" || route.auth === "mfa")) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== ctx.url.origin && !route.crossOrigin) throw new ApiError(403, "csrf_failed", "Cross-origin request refused");
  }
}

async function auditDenied(ctx, { action, resultReason, resourceType, resourceId, label, apiKey, once, result = "denied", meta }) {
  if (!ctx.env.SIGNING_KEY) return;
  if (once) { if (seenOnce.has(once)) return; seenOnce.add(once); if (seenOnce.size > 500) seenOnce.clear(); }
  const actor = ctx.actor?.type !== "anonymous" ? ctx.actor : apiKey ? { type: "api_key", id: apiKey.owner_user_id, name: null, apiKeyId: apiKey.id, apiKeyName: apiKey.name } : ctx.actor;
  const entry = makeEntry({ ...ctx, actor }, { action, result, resultReason, resourceType, resourceId, label, meta });
  try { await writeAudit(ctx.env, [entry]); } catch (e) { console.error("audit write failed", e); }
}
const seenOnce = new Set();

function coerceQuery(schema, params) {
  const out = {};
  for (const [k, v] of params) {
    const s = schema?.properties?.[k];
    if (!s) { out[k] = v; continue; }
    const t = [].concat(s.type || "string");
    if (t.includes("integer") || t.includes("number")) out[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    else if (t.includes("boolean")) out[k] = v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v;
    else if (t.includes("array")) out[k] = v.split(",").filter(Boolean);
    else out[k] = v;
  }
  return out;
}

/** Permission check + validation + handler. Shared by live requests and approved (replayed) requests. */
export async function runRoute(ctx, route, params, rawQuery, rawBody) {
  // owner / permission checks
  if (route.ownerOnly && !(ctx.isOwner && (ctx.actor.type === "user" || ctx.grant.all))) {
    await auditDenied(ctx, { action: route.op, resultReason: "owner only", resourceType: route.resource, resourceId: params.id });
    throw forbidden("Only the owner can do this");
  }
  const query = route.query ? validateOrThrow(route.query, coerceQuery(route.query, rawQuery), "query") : Object.fromEntries(rawQuery);
  const body = route.rawBody ? rawBody : route.body ? validateOrThrow(route.body, rawBody ?? {}, "body") : rawBody;
  const input = { params, query, body };
  const perms = typeof route.perm === "function" ? route.perm(ctx, input) : route.perm;
  const gameId = route.gameParam ? params[route.gameParam] : undefined;
  const missing = [].concat(perms || []).filter((p) => !can(ctx.grant, p, { gameId }));
  if (missing.length) {
    await auditDenied(ctx, { action: route.op, resultReason: `missing permission: ${missing.join(", ")}`, resourceType: route.resource, resourceId: params.id ?? params.slug, meta: { required: missing } });
    throw forbidden(`Missing permission: ${missing.join(", ")}`, { required: missing });
  }
  if (route.stepUp && ctx.actor.type === "user" && ctx.now - ctx.session.stepup_at > STEP_UP_MS) {
    throw new ApiError(403, "step_up_required", "Confirm with a code from your authenticator app to continue (POST /api/v1/auth/step-up)");
  }
  return route.handler(ctx, input);
}
function validateOrThrow(schema, value, where) {
  const { value: v, errors } = validate(schema, value, where === "query" ? "query" : "body");
  if (errors.length) throw new ApiError(400, "validation_failed", `Invalid ${where}: ${errors[0].path.replace(/^(body|query)\.?/, "") || where} ${errors[0].message}`, errors);
  return v;
}

function envelope(result, ctx) {
  if (result instanceof Response) return { response: result };
  const r = result && result.$reply ? result : { data: result, status: 200, headers: {} };
  const body = { data: r.data };
  const meta = { ...(r.meta || {}) };
  if (ctx.dryRun) {
    meta.dry_run = true;
    meta.would_change = ctx.txs.flatMap((t) => t.audits.map((a) => ({ action: a.action, resource_type: a.resource_type, resource_id: a.resource_id, label: a.resource_label, changes: a.changes })));
    meta.would_emit = ctx.txs.flatMap((t) => t.events.map((e) => e.name));
  }
  if (Object.keys(meta).length) body.meta = meta;
  return { status: r.status || 200, body, headers: r.headers || {} };
}

export async function handleApi(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.slice(API_PREFIX.length) || "/";
  const ctx = baseContext(context);
  const baseHeaders = { "X-Request-Id": ctx.reqId };
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: "GET, POST, PUT, PATCH, DELETE", ...baseHeaders } });
  const { route, params, allowed } = match(method, path);
  if (!route) {
    if (allowed) return errorResponse(new ApiError(405, "method_not_allowed", `Use ${allowed.join(", ")}`), ctx.reqId, { Allow: allowed.join(", "), ...baseHeaders });
    return errorResponse(new ApiError(404, "not_found", `No such endpoint: ${method} ${API_PREFIX}${path} — see ${API_PREFIX}/openapi.json`), ctx.reqId, baseHeaders);
  }
  ctx.route = `${route.method} ${API_PREFIX}${route.path}`;
  ctx.op = route.op;
  ctx.routeDef = route;
  if (!env.DB && !route.noDb) return errorResponse(new ApiError(503, "not_configured", "The D1 database binding (DB) is not configured — see README › Admin setup"), ctx.reqId, baseHeaders);
  try {
    if (!env.SIGNING_KEY && !route.noDb) throw new ApiError(503, "not_configured", "SIGNING_KEY is not configured");
    checkOrigin(ctx, route);
    if (!route.noDb) await authenticate(ctx, route);
    else if (route.auth !== "public") throw new ApiError(500, "bad_route", "noDb routes must be public");
    if (route.auth === "public" && route.ipLimit && env.DB) Object.assign(ctx.resHeaders, rlHeaders(await enforce(env.DB, `ip:${route.op}:${ctx.ip}`, route.ipLimit[0], route.ipLimit[1], ctx.now)));

    const dryHeader = /^(1|true|yes)$/i.test(request.headers.get("X-Dry-Run") || "");
    if ((dryHeader || ctx.forceDryRun) && route.write) {
      if (route.dryRun === false) { if (dryHeader) throw new ApiError(400, "dry_run_unsupported", "This endpoint does not support X-Dry-Run"); }
      else ctx.dryRun = true;
    }
    ctx.ifMatch = request.headers.get("If-Match");

    const rawBody = route.rawBody ? request : route.write ? await readJson(request, route.maxBody || 2_000_000) : undefined;

    // Approval queue: destructive calls from keys that require approval are parked for a human.
    if (ctx.key && ctx.key.require_approval && route.destructive && !ctx.dryRun && route.approvable !== false && !route.rawBody) {
      const { queueApproval } = await import("./routes/keys.js");
      const res = await queueApproval(ctx, route, params, url, rawBody);
      return jsonResponse(res, 202, { ...baseHeaders, ...ctx.resHeaders });
    }

    // Idempotency keys (POST)
    let idem = null;
    const idemKey = request.headers.get("Idempotency-Key");
    if (idemKey && method === "POST" && !ctx.dryRun && env.DB) {
      if (idemKey.length > 200) throw new ApiError(400, "validation_failed", "Idempotency-Key must be ≤ 200 characters");
      const who = ctx.key ? `key:${ctx.key.id}` : ctx.user ? `user:${ctx.user.id}` : `ip:${ctx.ip}`;
      idem = { id: await sha256Hex(`${who}|${route.op}|${idemKey}`), hash: await sha256Hex(`${url.pathname}${url.search}|${JSON.stringify(rawBody ?? null)}`) };
      const prev = await env.DB.prepare("SELECT * FROM idempotency WHERE id = ? AND created_at > ?").bind(idem.id, ctx.now - 86_400_000).first();
      if (prev) {
        if (prev.request_hash !== idem.hash) throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request");
        return new Response(prev.response, { status: prev.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Idempotent-Replayed": "true", ...baseHeaders } });
      }
    }

    const result = await runRoute(ctx, route, params, url.searchParams, rawBody);
    const out = envelope(result, ctx);
    if (out.response) {
      for (const [k, v] of Object.entries({ ...baseHeaders, ...ctx.resHeaders })) out.response.headers.set(k, v);
      return out.response;
    }
    const headers = { ...baseHeaders, ...ctx.resHeaders, ...out.headers };
    if (ctx.etag) headers.ETag = ctx.etag;
    if (idem && out.status < 300) {
      await env.DB.prepare("INSERT OR REPLACE INTO idempotency (id, request_hash, status, response, created_at) VALUES (?, ?, ?, ?, ?)").bind(idem.id, idem.hash, out.status, JSON.stringify(out.body), ctx.now).run();
    }
    if (env.DB && !route.noDb) maybeTick(ctx);
    if (method === "HEAD") return new Response(null, { status: out.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    return jsonResponse(out.status === 204 ? null : out.body, out.status, headers);
  } catch (err) {
    if (!(err instanceof ApiError)) console.error(`[${ctx.reqId}] ${ctx.route}`, err);
    const status = err instanceof ApiError ? err.status : 500;
    if (route.write && env.DB && env.SIGNING_KEY && (status === 409 || status === 412 || status >= 500) && ctx.actor.type !== "anonymous") {
      await auditDenied(ctx, { action: route.op, result: "error", resultReason: `${status} ${err.code || "internal_error"}: ${err.message}`.slice(0, 500), resourceType: route.resource, resourceId: params.id ?? params.slug });
    }
    return errorResponse(err, ctx.reqId, { ...baseHeaders, ...ctx.resHeaders, ...(err.headers || {}) });
  }
}

/* Opportunistic housekeeping (scheduled publishing, webhook retries, cleanup) at most once a minute per isolate. */
let lastTick = 0;
function maybeTick(ctx) {
  if (ctx.now - lastTick < 60_000 || ctx.env.DISABLE_AUTO_TICK) return;
  lastTick = ctx.now;
  ctx.waitUntil(runTick(ctx.env).catch((e) => console.error("tick failed", e)));
}

/** Optional: purge Cloudflare's zone cache for changed public URLs (set CF_ZONE_ID + CF_API_TOKEN with Cache Purge permission). */
async function purgeZone(env, paths) {
  if (!env.CF_ZONE_ID || !env.CF_API_TOKEN || !env.SITE_URL) return;
  const base = String(env.SITE_URL).replace(/\/+$/, "");
  const files = [...new Set(["/", "/news/", "/news/feed.xml", "/sitemap.xml", ...paths])].slice(0, 30).map((p) => base + p);
  await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`, {
    method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ files })
  }).catch(() => {});
}

export { routes, Tx };

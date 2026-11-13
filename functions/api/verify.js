/* POST /api/verify — server-side Cloudflare Turnstile check for web play.
   Body (form-encoded or multipart): slug, cf-turnstile-response
   Success → sets a signed, HttpOnly play cookie for /<slug>/play/ and returns
             { ok: true, redirect: "/<slug>/play/" }
   Errors  → { ok: false, error: "bad_request" | "not_enabled" | "captcha_failed" |
                                  "verify_unavailable" | "misconfigured" | "forbidden" }
   Secrets (never committed): TURNSTILE_SECRET, SIGNING_KEY.
   Optional vars: PLAY_TTL_HOURS (default 4), ALLOWED_HOSTNAMES (comma list). */
import { PLAY_GAMES } from "../../lib/games.generated.js";
import { SLUG_RE, json, signTicket, playCookie, ttlSeconds } from "../../lib/play-auth.js";
import { playableFromD1 } from "../../lib/site-render.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);

  // Same-origin only (browsers always send Origin on POST fetches).
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ ok: false, error: "forbidden" }, 403);

  if (!env.TURNSTILE_SECRET || !env.SIGNING_KEY) return json({ ok: false, error: "misconfigured" }, 500);

  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > 8192) return json({ ok: false, error: "bad_request" }, 413);
  let form;
  try { form = await request.formData(); } catch { return json({ ok: false, error: "bad_request" }, 400); }

  const slug = String(form.get("slug") || "");
  const token = String(form.get("cf-turnstile-response") || "");
  if (!SLUG_RE.test(slug)) return json({ ok: false, error: "bad_request" }, 400);
  // Same source of truth as the play gate: the admin's "web play" toggle in the database, else lib/games.generated.js.
  const d1 = await playableFromD1(env, slug);
  const playable = d1 !== null ? Boolean(d1) : Object.prototype.hasOwnProperty.call(PLAY_GAMES, slug);
  if (!playable) return json({ ok: false, error: "not_enabled" }, 404);
  if (!token || token.length > 2048) return json({ ok: false, error: "captcha_failed" }, 400);

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Real-IP");
  if (ip) body.append("remoteip", ip);
  body.append("idempotency_key", crypto.randomUUID());

  let result;
  try {
    const r = await fetch(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(8000) });
    result = await r.json();
  } catch {
    return json({ ok: false, error: "verify_unavailable" }, 502);
  }
  if (!result || result.success !== true) return json({ ok: false, error: "captcha_failed", codes: result?.["error-codes"] || [] }, 403);

  // Extra binding checks. Cloudflare's test keys return dummy values, so skip them there.
  const testing = result.metadata?.result_with_testing_key === true;
  if (!testing) {
    const allowed = String(env.ALLOWED_HOSTNAMES || url.hostname).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(String(result.hostname || "").toLowerCase())) return json({ ok: false, error: "captcha_failed", codes: ["hostname-mismatch"] }, 403);
    if (result.action && result.action !== "play") return json({ ok: false, error: "captcha_failed", codes: ["action-mismatch"] }, 403);
    if (result.cdata && result.cdata !== slug) return json({ ok: false, error: "captcha_failed", codes: ["cdata-mismatch"] }, 403);
  }

  const ttl = ttlSeconds(env);
  const ticket = await signTicket(slug, env.SIGNING_KEY, ttl);
  return json({ ok: true, redirect: `/${slug}/play/` }, 200, { "Set-Cookie": playCookie(slug, ticket, ttl) });
}

export const onRequest = () => json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });

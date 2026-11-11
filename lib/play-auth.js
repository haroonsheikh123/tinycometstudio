/* Shared helpers for the web-play gate (Cloudflare Pages Functions).
   Web Crypto only (crypto.subtle) — no npm dependencies. Also runs in Node 18+ for tests. */

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const COOKIE_NAME = "tc_play";
export const DEFAULT_TTL_HOURS = 4;
export const MAX_TTL_HOURS = 24;

/** CSP applied to the game build under /<slug>/play/. Loosened for WebGL/WASM engines (Unity, Godot…). */
export const GAME_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "font-src 'self' data:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'"
].join("; ");

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const keyCache = new Map();
async function hmacKey(secret) {
  if (!keyCache.has(secret)) {
    keyCache.set(secret, crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  }
  return keyCache.get(secret);
}
const payload = (slug, exp) => `tc-play:v1:${slug}:${exp}`;

export function ttlSeconds(env) {
  const h = Number(env?.PLAY_TTL_HOURS);
  return Math.round((Number.isFinite(h) && h > 0 ? Math.min(h, MAX_TTL_HOURS) : DEFAULT_TTL_HOURS) * 3600);
}

/** Create a signed ticket "slug.exp.sig" (exp = unix seconds). */
export async function signTicket(slug, secret, ttl, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttl;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload(slug, exp)));
  return `${slug}.${exp}.${b64url(sig)}`;
}

/** Constant-time verification of a ticket for `slug`. */
export async function verifyTicket(ticket, slug, secret, now = Date.now()) {
  if (!ticket || !secret || typeof ticket !== "string" || ticket.length > 300) return false;
  const parts = ticket.split(".");
  if (parts.length !== 3) return false;
  const [tSlug, expStr, sig] = parts;
  if (tSlug !== slug || !/^\d{1,12}$/.test(expStr) || !/^[A-Za-z0-9_-]{20,100}$/.test(sig)) return false;
  const exp = Number(expStr);
  const nowS = Math.floor(now / 1000);
  if (exp <= nowS || exp > nowS + MAX_TTL_HOURS * 3600 + 60) return false;
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(payload(slug, exp)));
  } catch { return false; }
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function playCookie(slug, ticket, maxAge) {
  return `${COOKIE_NAME}=${encodeURIComponent(ticket)}; Path=/${slug}/play/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }
  });
}

/** Fetch a static file from the Pages asset server, following its pretty-URL redirects. */
export async function fetchAsset(env, origin, path) {
  if (!env?.ASSETS) return null;
  let url = new URL(path, origin);
  for (let i = 0; i < 3; i++) {
    const res = await env.ASSETS.fetch(new Request(url.toString(), { method: "GET" }));
    if (res.status >= 300 && res.status < 400 && res.headers.get("Location")) { url = new URL(res.headers.get("Location"), url); continue; }
    return res.ok ? res : null;
  }
  return null;
}

/** Return the site's on-brand 404 page (status 404), or a plain fallback. */
export async function notFound(env, request) {
  const origin = new URL(request.url).origin;
  const page = await fetchAsset(env, origin, "/404.html");
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
  if (page) return new Response(page.body, { status: 404, headers });
  return new Response('<!doctype html><meta charset="utf-8"><title>Not found</title><p>Page not found. <a href="/">Go home</a></p>', { status: 404, headers });
}

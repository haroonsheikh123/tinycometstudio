/* HTTP envelope, errors, and request-metadata helpers for /api/v1. */

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status; this.code = code; this.details = details;
  }
}
export const bad = (message, details) => new ApiError(400, "validation_failed", message, details);
export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);
export const forbidden = (message = "You don't have permission to do this", details) => new ApiError(403, "forbidden", message, details);
export const conflict = (message, details) => new ApiError(409, "conflict", message, details);

/** Security headers on every API response. */
export const API_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
};

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { ...API_HEADERS, ...headers } });
}
export function errorResponse(err, reqId, headers = {}) {
  const status = err instanceof ApiError ? err.status : 500;
  const code = err instanceof ApiError ? err.code : "internal_error";
  const message = err instanceof ApiError ? err.message : "Something went wrong. The error was logged with this request id.";
  const error = { code, message, request_id: reqId };
  if (err instanceof ApiError && err.details !== undefined) error.details = err.details;
  return jsonResponse({ error }, status, headers);
}

export function clientInfo(request) {
  const h = request.headers;
  const cf = request.cf || {};
  const ua = h.get("User-Agent") || "";
  return {
    ip: h.get("CF-Connecting-IP") || h.get("X-Real-IP") || (h.get("X-Forwarded-For") || "").split(",")[0].trim() || "127.0.0.1",
    country: cf.country || h.get("CF-IPCountry") || null,
    city: cf.city || null,
    ua,
    ...parseUserAgent(ua)
  };
}

/** Very small UA classifier (device type, browser, OS) — enough for dashboards and the audit log. */
export function parseUserAgent(ua = "") {
  const s = String(ua);
  const bot = isBot(s);
  const device = bot ? "bot" : /iPad|Tablet|Nexus (7|9|10)|SM-T|Kindle|Silk/i.test(s) ? "tablet" : /Mobi|iPhone|Android.+Mobile|Windows Phone/i.test(s) ? "mobile" : /curl|wget|python|node|go-http|okhttp|axios|undici|httpie|postman/i.test(s) ? "script" : "desktop";
  const browser = /Edg\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /Firefox\//.test(s) ? "Firefox" : /SamsungBrowser/.test(s) ? "Samsung Internet"
    : /Chrome\/|CriOS/.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : /curl\//i.test(s) ? "curl" : s ? "Other" : "Unknown";
  const os = /Windows/.test(s) ? "Windows" : /iPhone|iPad|iPod/.test(s) ? "iOS" : /Mac OS X|Macintosh/.test(s) ? "macOS" : /Android/.test(s) ? "Android"
    : /CrOS/.test(s) ? "ChromeOS" : /Linux/.test(s) ? "Linux" : "Other";
  return { device, browser, os, deviceLabel: `${browser} on ${os}${device === "mobile" || device === "tablet" ? ` (${device})` : ""}` };
}
export const isBot = (ua = "") => !ua || /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|headless|lighthouse|pagespeed|phantom|puppeteer|playwright|selenium|preview|monitor|uptime|pingdom|httpclient|python-requests|scrapy|wget/i.test(ua);

/* ---------- IP / CIDR matching (IPv4 + IPv6) ---------- */
function ipToBig(ip) {
  ip = String(ip).trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const p = ip.split(".").map(Number);
    if (p.some((x) => x > 255)) return null;
    return { v: 4, n: BigInt(((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) };
  }
  if (!ip.includes(":")) return null;
  const m4 = ip.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (m4) { const v4 = ipToBig(m4[2]); if (!v4) return null; const hi = Number(v4.n >> 16n).toString(16), lo = Number(v4.n & 0xffffn).toString(16); ip = `${m4[1]}${hi}:${lo}`; }
  const [head, tail] = ip.split("::");
  if (ip.split("::").length > 2) return null;
  const h = head ? head.split(":") : [], t = tail !== undefined && tail ? tail.split(":") : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(0, fill)).fill("0"), ...t];
  if (parts.length !== 8 || parts.some((x) => !/^[0-9a-f]{1,4}$/i.test(x))) return null;
  const n = parts.reduce((acc, x) => (acc << 16n) + BigInt(parseInt(x, 16)), 0n);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) → treat as IPv4
  if (n >> 32n === 0xffffn) return { v: 4, n: n & 0xffffffffn };
  return { v: 6, n };
}
export function validCidr(c) {
  const [ip, bits] = String(c).split("/");
  const p = ipToBig(ip);
  if (!p) return false;
  if (bits === undefined) return true;
  const b = Number(bits);
  return /^\d{1,3}$/.test(bits) && b >= 0 && b <= (p.v === 4 ? 32 : 128);
}
export function ipInCidr(ip, cidr) {
  const a = ipToBig(ip);
  const [base, bitsStr] = String(cidr).split("/");
  const b = ipToBig(base);
  if (!a || !b || a.v !== b.v) return false;
  const width = a.v === 4 ? 32 : 128;
  const bits = bitsStr === undefined ? width : Number(bitsStr);
  const shift = BigInt(width - bits);
  return a.n >> shift === b.n >> shift;
}
export const ipAllowed = (ip, list) => !list || !list.length || list.some((c) => ipInCidr(ip, c));

/* ---------- cursors ---------- */
export const encodeCursor = (o) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function decodeCursor(c) {
  if (!c) return null;
  try { return JSON.parse(atob(String(c).replace(/-/g, "+").replace(/_/g, "/"))); } catch { throw bad("Invalid cursor"); }
}

export async function readJson(request, limit = 1_000_000) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > limit) throw new ApiError(413, "payload_too_large", `Body must be ≤ ${limit} bytes`);
  const text = await request.text();
  if (text.length > limit) throw new ApiError(413, "payload_too_large", `Body must be ≤ ${limit} bytes`);
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw bad("Body must be valid JSON"); }
}

/* Gate for /<slug>/play/*  (Cloudflare Pages Functions middleware)
   - Unknown slug, or web play not enabled → on-brand 404
   - Valid signed cookie for this slug    → serve the game files (R2 build uploaded in the admin, else public/<slug>/play/)
   - Otherwise                            → serve the Turnstile gate page for this game
   Which games are playable comes from D1 when it's configured (admin "web play" toggle), else lib/games.generated.js. */
import { PLAY_GAMES } from "../../../lib/games.generated.js";
import { SLUG_RE, COOKIE_NAME, GAME_CSP, getCookie, verifyTicket, fetchAsset, notFound } from "../../../lib/play-auth.js";
import { playableFromD1, renderGateFromD1 } from "../../../lib/site-render.js";
import { MIME } from "../../../lib/admin/routes/media.js";

async function serveBuild(env, slug, build, url) {
  let rel = decodeURIComponent(url.pathname.slice(`/${slug}/play/`.length));
  if (!rel || rel.endsWith("/")) rel += "index.html";
  if (rel.split("/").some((s) => s === "..")) return new Response("Not found", { status: 404 });
  const obj = await env.MEDIA.get(`builds/${slug}/${build.id}/${rel}`);
  if (!obj) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const ext = rel.split(".").pop().toLowerCase();
  const h = new Headers({ "Content-Type": obj.httpMetadata?.contentType || MIME[ext] || "application/octet-stream" });
  // Pre-compressed Unity/Godot files (*.br / *.gz)
  if (/\.(js|wasm|data|symbols\.json)\.br$/.test(rel)) h.set("Content-Encoding", "br");
  if (/\.(js|wasm|data|symbols\.json)\.gz$/.test(rel)) h.set("Content-Encoding", "gzip");
  if (/\.wasm(\.br|\.gz)?$/.test(rel)) h.set("Content-Type", "application/wasm");
  else if (/\.js(\.br|\.gz)$/.test(rel)) h.set("Content-Type", "text/javascript");
  return new Response(obj.body, { headers: h, encodeBody: h.has("Content-Encoding") ? "manual" : "automatic" });
}

export async function onRequest(context) {
  const { request, env, params, next } = context;
  const slug = String(params.slug || "");
  if (!SLUG_RE.test(slug)) return notFound(env, request);
  const d1 = await playableFromD1(env, slug);
  const playable = d1 !== null ? Boolean(d1) : Object.prototype.hasOwnProperty.call(PLAY_GAMES, slug);
  if (!playable) return notFound(env, request);

  const url = new URL(request.url);
  if (url.pathname === `/${slug}/play`) return Response.redirect(`${url.origin}/${slug}/play/${url.search}`, 308);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });

  const ticket = getCookie(request, COOKIE_NAME);
  if (env.SIGNING_KEY && (await verifyTicket(ticket, slug, env.SIGNING_KEY))) {
    const res = d1?.build?.id && env.MEDIA ? await serveBuild(env, slug, d1.build, url) : await next();
    const out = new Response(res.body, res);
    const isHtml = (out.headers.get("Content-Type") || "").includes("text/html");
    out.headers.set("Cache-Control", isHtml ? "private, no-cache" : "private, max-age=3600");
    out.headers.set("Content-Security-Policy", GAME_CSP);
    out.headers.set("X-Robots-Tag", "noindex");
    out.headers.set("X-Content-Type-Options", "nosniff");
    out.headers.set("X-Frame-Options", "SAMEORIGIN");
    return out;
  }

  // Not unlocked. Only page navigations get the gate; sub-resources (game.js, .wasm…) are refused.
  const dest = request.headers.get("Sec-Fetch-Dest");
  const wantsHtml = dest ? dest === "document" : (request.headers.get("Accept") || "").includes("text/html");
  if (!wantsHtml) return new Response("Verification required", { status: 403, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" } });

  let gate = d1 ? await renderGateFromD1(env, slug).catch(() => null) : null;
  if (!gate) gate = (await fetchAsset(env, url.origin, `/${slug}/gate/`))?.body;
  if (!gate) return Response.redirect(`${url.origin}/${slug}/`, 302);
  return new Response(gate, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    }
  });
}

/* Gate for /<slug>/play/*  (Cloudflare Pages Functions middleware)
   - Unknown slug, or web play not enabled → on-brand 404
   - Valid signed cookie for this slug    → serve the static game files (context.next())
   - Otherwise                            → serve the Turnstile gate page for this game */
import { PLAY_GAMES } from "../../../lib/games.generated.js";
import { SLUG_RE, COOKIE_NAME, GAME_CSP, getCookie, verifyTicket, fetchAsset, notFound } from "../../../lib/play-auth.js";

export async function onRequest(context) {
  const { request, env, params, next } = context;
  const slug = String(params.slug || "");
  if (!SLUG_RE.test(slug) || !Object.prototype.hasOwnProperty.call(PLAY_GAMES, slug)) return notFound(env, request);

  const url = new URL(request.url);
  if (url.pathname === `/${slug}/play`) return Response.redirect(`${url.origin}/${slug}/play/${url.search}`, 308);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });

  const ticket = getCookie(request, COOKIE_NAME);
  if (env.SIGNING_KEY && (await verifyTicket(ticket, slug, env.SIGNING_KEY))) {
    const res = await next();
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

  const gate = await fetchAsset(env, url.origin, `/${slug}/gate/`);
  if (!gate) return Response.redirect(`${url.origin}/${slug}/`, 302);
  return new Response(gate.body, {
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

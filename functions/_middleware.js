/* Root middleware (Cloudflare Pages Functions).
   Public pages are rendered from D1 when it's configured and seeded (edge-cached, purged on every content change);
   otherwise — and for every path it doesn't own — the static files in public/ answer exactly as before.
   /api, /admin and /media have their own functions; static assets (css/js/assets) never reach Functions (_routes.json). */
import { renderPublic } from "../lib/site-render.js";

export async function onRequest(context) {
  const p = new URL(context.request.url).pathname;
  if (p.startsWith("/api/") || p === "/api" || p.startsWith("/admin") || p.startsWith("/media/")) return context.next();
  try {
    const res = await renderPublic(context);
    if (res) return res;
  } catch (e) {
    console.error("D1 render failed — falling back to static files", e);
  }
  return context.next();
}

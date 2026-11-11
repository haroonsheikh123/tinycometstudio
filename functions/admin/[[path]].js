/* /admin/* — serves the admin single-page app shell (public/admin/index.html) for every route,
   with a strict CSP, noindex and no-store. Its scripts/styles live in /admin/assets/ (static, excluded from Functions).
   The admin UI talks only to the public /api/v1 API. */
import { ADMIN_HEADERS } from "../../lib/site-headers.js";

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD", ...ADMIN_HEADERS } });
  if (url.pathname === "/admin") return Response.redirect(`${url.origin}/admin/${url.search}`, 308);
  let res;
  if (/\.[a-z0-9]+$/i.test(url.pathname) && !url.pathname.endsWith("/index.html")) res = await next();
  else res = env.ASSETS ? await env.ASSETS.fetch(new Request(new URL("/admin/", url.origin), { method: "GET" })) : await next();
  const out = new Response(request.method === "HEAD" ? null : res.body, { status: res.status === 304 ? 200 : res.status, headers: res.headers });
  for (const [k, v] of Object.entries(ADMIN_HEADERS)) out.headers.set(k, v);
  return out;
}

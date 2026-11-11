/* /media/* — files from the R2 media library (uploaded via the admin / API). Keys are content-hashed → cache forever. */
export async function onRequest({ request, env, params }) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  if (!env.MEDIA) return new Response("Not found", { status: 404 });
  const rel = [].concat(params.path || []).join("/");
  if (!rel || rel.includes("..")) return new Response("Not found", { status: 404 });
  const obj = await env.MEDIA.get(`media/${rel}`);
  if (!obj) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  const type = h.get("Content-Type") || "application/octet-stream";
  h.set("Cache-Control", "public, max-age=31536000, immutable");
  h.set("ETag", obj.httpEtag);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  // Uploaded SVG/PDF can carry scripts: sandbox them so they can never run in the site's origin.
  h.set("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  if (!/^(image\/(png|jpeg|webp|avif|gif|svg\+xml|x-icon)|video\/|audio\/)/.test(type)) h.set("Content-Disposition", "attachment");
  if (request.headers.get("If-None-Match") === obj.httpEtag) return new Response(null, { status: 304, headers: h });
  return new Response(request.method === "HEAD" ? null : obj.body, { headers: h });
}

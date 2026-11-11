/* Media library (R2), signed direct uploads, game web builds (zip → R2). */
import { route, reply } from "../router.js";
import { S } from "../schema.js";
import { ApiError, notFound } from "../http.js";
import { Tx } from "../tx.js";
import { randomId, sha256Hex, hmacB64, deriveKey, safeEqual, b64url, fromB64url, enc, dec } from "../crypto.js";
import { j, gameFromRow } from "../content.js";
import { paginate, iso, checkIfMatch } from "./_util.js";
import { GAMES } from "./content.js";
import { diff } from "../audit.js";

const T = "Media";
export const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif", gif: "image/gif", svg: "image/svg+xml", ico: "image/x-icon",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", pdf: "application/pdf", zip: "application/zip",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json", wasm: "application/wasm", txt: "text/plain; charset=utf-8", xml: "application/xml", data: "application/octet-stream", unityweb: "application/octet-stream",
  pck: "application/octet-stream", bin: "application/octet-stream", glb: "model/gltf-binary", gltf: "model/gltf+json", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", br: "application/octet-stream", gz: "application/gzip"
};
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif", "image/svg+xml", "image/x-icon", "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/wav", "application/pdf", "application/zip"]);
export const MAX_MEDIA = 25 * 1024 * 1024;
const ext = (name) => (String(name).split(".").pop() || "").toLowerCase();
const safeName = (name) => String(name || "file").normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 100) || "file";

export const mediaOut = (m) => m && ({ id: m.id, url: `/media/${m.r2_key.replace(/^media\//, "")}`, filename: m.filename, content_type: m.content_type, size: m.size, sha256: m.sha256, alt: m.alt, created_at: iso(m.created_at), created_by: m.created_by });

function needR2(ctx) { if (!ctx.env.MEDIA) throw new ApiError(503, "not_configured", "The R2 bucket binding (MEDIA) is not configured — see README › Admin setup"); }

async function storeMedia(ctx, { bytes, filename, contentType, alt = "", actorName }) {
  needR2(ctx);
  const ct = (contentType || MIME[ext(filename)] || "").split(";")[0].trim().toLowerCase();
  if (!MEDIA_TYPES.has(ct)) throw new ApiError(415, "unsupported_media_type", `Allowed: ${[...MEDIA_TYPES].join(", ")}`);
  if (!bytes.byteLength) throw new ApiError(400, "validation_failed", "Empty file");
  if (bytes.byteLength > MAX_MEDIA) throw new ApiError(413, "payload_too_large", `Max ${MAX_MEDIA / 1024 / 1024} MB per file`);
  const hash = await sha256Hex(bytes);
  const name = safeName(filename);
  const key = `media/${hash.slice(0, 12)}/${name}`;
  const existing = await ctx.env.DB.prepare("SELECT * FROM media WHERE r2_key = ? AND deleted_at IS NULL").bind(key).first();
  if (existing) return { item: mediaOut(existing), duplicate: true };
  const id = randomId("med_", 12);
  const row = { id, r2_key: key, filename: name, content_type: ct, size: bytes.byteLength, sha256: hash, alt, created_at: ctx.now, created_by: actorName || ctx.actor.name };
  if (!ctx.dryRun) await ctx.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: ct, cacheControl: "public, max-age=31536000, immutable" }, customMetadata: { media_id: id } });
  const tx = new Tx(ctx);
  tx.run("INSERT OR REPLACE INTO media (id, r2_key, filename, content_type, size, sha256, alt, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, key, name, ct, row.size, hash, alt, ctx.now, row.created_by);
  tx.audit({ action: "media.upload", resourceType: "media", resourceId: id, label: name, after: mediaOut(row), changes: diff({}, { filename: name, content_type: ct, size: row.size, alt }) });
  tx.event("media.uploaded", mediaOut(row));
  try { await tx.commit(); } catch (e) { if (!ctx.dryRun) await ctx.env.MEDIA.delete(key).catch(() => {}); throw e; }
  return { item: mediaOut(row), duplicate: false };
}

route({
  method: "GET", path: "/media", op: "media.list", tag: T, perm: "media:read", resource: "media", summary: "List media (newest first). Filter by type prefix (image/, video/…) or q.",
  query: S.obj({ type: S.str(40), q: S.str(100), limit: S.int(1, 200), cursor: S.str(200) }),
  handler: async (ctx, { query }) => {
    let { results } = await ctx.env.DB.prepare("SELECT * FROM media WHERE deleted_at IS NULL ORDER BY created_at DESC").all();
    if (query.type) results = results.filter((m) => m.content_type.startsWith(query.type));
    if (query.q) { const q = query.q.toLowerCase(); results = results.filter((m) => `${m.filename} ${m.alt}`.toLowerCase().includes(q)); }
    const { page, meta } = paginate(results.map(mediaOut), query, { def: 60 });
    return reply(page, { meta });
  }
});
route({
  method: "POST", path: "/media", op: "media.upload", tag: T, perm: "media:create", resource: "media", rawBody: true,
  summary: "Upload a file: raw body with Content-Type, plus ?filename=cover.webp&alt=… (or multipart/form-data with field `file`). Max 25 MB. De-duplicated by content hash.",
  query: S.obj({ filename: S.str(200), alt: S.str(300) }),
  handler: async (ctx, { query, body: request }) => {
    const ctype = request.headers.get("Content-Type") || "";
    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > MAX_MEDIA + 1_000_000) throw new ApiError(413, "payload_too_large", "Max 25 MB");
    let bytes, filename = query.filename, contentType = ctype, alt = query.alt || "";
    if (ctype.startsWith("multipart/form-data")) {
      const form = await request.formData();
      const f = form.get("file");
      if (!f || typeof f === "string") throw new ApiError(400, "validation_failed", "multipart field `file` is required");
      bytes = new Uint8Array(await f.arrayBuffer()); filename = filename || f.name; contentType = f.type; alt = String(form.get("alt") || alt).slice(0, 300);
    } else bytes = new Uint8Array(await request.arrayBuffer());
    if (!filename) throw new ApiError(400, "validation_failed", "?filename= is required");
    const r = await storeMedia(ctx, { bytes, filename, contentType, alt });
    return reply(r.item, { status: r.duplicate ? 200 : 201, meta: { duplicate: r.duplicate } });
  }
});
route({
  method: "GET", path: "/media/{id}", op: "media.get", tag: T, perm: "media:read", resource: "media", summary: "Get one media item.",
  handler: async (ctx, { params }) => { const m = await ctx.env.DB.prepare("SELECT * FROM media WHERE id = ?").bind(params.id).first(); if (!m) throw notFound("Media"); return mediaOut(m); }
});
route({
  method: "PATCH", path: "/media/{id}", op: "media.update", tag: T, perm: "media:update", resource: "media", summary: "Edit alt text.", body: S.obj({ alt: S.str(300) }),
  handler: async (ctx, { params, body }) => {
    const m = await ctx.env.DB.prepare("SELECT * FROM media WHERE id = ? AND deleted_at IS NULL").bind(params.id).first();
    if (!m) throw notFound("Media");
    const changes = diff({ alt: m.alt }, { alt: body.alt ?? m.alt });
    if (!changes.length) return mediaOut(m);
    const tx = new Tx(ctx);
    tx.run("UPDATE media SET alt = ? WHERE id = ?", body.alt, m.id);
    tx.audit({ action: "media.update", resourceType: "media", resourceId: m.id, label: m.filename, changes });
    await tx.commit();
    return mediaOut({ ...m, alt: body.alt });
  }
});
route({
  method: "DELETE", path: "/media/{id}", op: "media.delete", tag: T, perm: "media:delete", resource: "media", summary: "Delete a file from R2 (pages that reference it will show a broken image).",
  handler: async (ctx, { params }) => {
    const m = await ctx.env.DB.prepare("SELECT * FROM media WHERE id = ? AND deleted_at IS NULL").bind(params.id).first();
    if (!m) throw notFound("Media");
    const url = mediaOut(m).url;
    const { results } = await ctx.env.DB.prepare("SELECT 'game' AS t, id FROM games WHERE deleted_at IS NULL AND data LIKE ? UNION ALL SELECT 'news', slug FROM news WHERE deleted_at IS NULL AND (data LIKE ? OR body LIKE ?) UNION ALL SELECT 'team', id FROM team WHERE deleted_at IS NULL AND data LIKE ?").bind(`%${url}%`, `%${url}%`, `%${url}%`, `%${url}%`).all();
    const tx = new Tx(ctx);
    tx.run("UPDATE media SET deleted_at = ? WHERE id = ?", ctx.now, m.id);
    tx.audit({ action: "media.delete", resourceType: "media", resourceId: m.id, label: m.filename, before: mediaOut(m), meta: { referenced_by: results } });
    tx.event("media.deleted", { id: m.id, url });
    tx.afterCommit(async () => { needR2(ctx); await ctx.env.MEDIA.delete(m.r2_key); });
    await tx.commit();
    return { deleted: m.id, was_referenced_by: results };
  }
});

/* ---------- signed direct uploads: an app/agent asks for a short-lived URL, then PUTs the bytes there ---------- */
async function uploadKey(env) { return deriveKey(env.SIGNING_KEY, "media-upload"); }
route({
  method: "POST", path: "/media/uploads", op: "media.signed_upload", tag: T, perm: "media:create", resource: "media", dryRun: false,
  summary: "Create a signed upload URL (valid 15 min). PUT the file bytes to `upload_url` — no other auth needed.",
  body: S.obj({ filename: S.str(200, { minLength: 1 }), content_type: S.str(100, { minLength: 1 }), size: S.int(1, MAX_MEDIA), alt: S.str(300) }, ["filename", "content_type", "size"]),
  handler: async (ctx, { body }) => {
    if (!MEDIA_TYPES.has(body.content_type)) throw new ApiError(415, "unsupported_media_type", `Allowed: ${[...MEDIA_TYPES].join(", ")}`);
    const claims = { f: body.filename, ct: body.content_type, s: body.size, a: body.alt || "", u: ctx.actor.id, n: ctx.actor.name, k: ctx.key?.id || null, exp: ctx.now + 15 * 60_000, jti: randomId("", 10) };
    const p = b64url(enc.encode(JSON.stringify(claims)));
    const token = `${p}.${await hmacB64(await uploadKey(ctx.env), p)}`;
    const tx = new Tx(ctx);
    tx.audit({ action: "media.signed_upload_issued", resourceType: "media", label: body.filename, meta: { content_type: body.content_type, size: body.size, expires_at: iso(claims.exp) } });
    await tx.commit();
    return { upload_url: `${ctx.url.origin}/api/v1/media/uploads/${token}`, method: "PUT", headers: { "Content-Type": body.content_type }, expires_at: iso(claims.exp) };
  }
});
route({
  method: "PUT", path: "/media/uploads/{token}", op: "media.signed_upload_put", tag: T, auth: "public", rawBody: true, dryRun: false, crossOrigin: true, ipLimit: [30, 60], resource: "media",
  summary: "Upload bytes to a signed URL from POST /media/uploads.",
  handler: async (ctx, { params, body: request }) => {
    const [p, sig] = String(params.token).split(".");
    if (!p || !sig || !safeEqual(await hmacB64(await uploadKey(ctx.env), p), sig)) throw new ApiError(403, "forbidden", "Invalid upload URL");
    const c = JSON.parse(dec.decode(fromB64url(p)));
    if (c.exp < ctx.now) throw new ApiError(410, "expired", "This upload URL expired");
    const used = await ctx.env.DB.prepare("SELECT 1 FROM site_state WHERE key = ?").bind(`upload_used:${c.jti}`).first();
    if (used) throw new ApiError(409, "conflict", "This upload URL was already used");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== c.s) throw new ApiError(400, "validation_failed", `Expected ${c.s} bytes, got ${bytes.byteLength}`);
    const u = await ctx.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(c.u).first();
    ctx.actor = { type: c.k ? "api_key" : "user", id: c.u, name: c.n, email: u?.email, role: u?.role_id, apiKeyId: c.k };
    ctx.source = "signed_upload";
    await ctx.env.DB.prepare("INSERT INTO site_state (key, value, updated_at) VALUES (?, '1', ?)").bind(`upload_used:${c.jti}`, ctx.now).run();
    const r = await storeMedia(ctx, { bytes, filename: c.f, contentType: c.ct, alt: c.a, actorName: c.n });
    return reply(r.item, { status: 201 });
  }
});

/* ---------------------------------------------------------------- web builds (zip → R2) */
export async function unzip(buf, { maxFiles = 5000, maxTotal = 300 * 1024 * 1024 } = {}) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65_557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ApiError(400, "validation_failed", "Not a zip file");
  const count = dv.getUint16(eocd + 10, true), cd = dv.getUint32(eocd + 16, true);
  if (cd === 0xffffffff || count === 0xffff) throw new ApiError(400, "validation_failed", "ZIP64 archives aren't supported — zip with standard settings");
  if (count > maxFiles) throw new ApiError(400, "validation_failed", `Too many files (max ${maxFiles})`);
  const out = [];
  let p = cd, total = 0;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new ApiError(400, "validation_failed", "Corrupt zip (central directory)");
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl)).replace(/\\/g, "/");
    p += 46 + nl + xl + cl;
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || /(^|\/)\.DS_Store$/.test(name)) continue;
    if (flags & 1) throw new ApiError(400, "validation_failed", "Encrypted zips aren't supported");
    if (name.startsWith("/") || name.split("/").some((s) => s === ".." || s === "") || /[\u0000-\u001f]/.test(name)) throw new ApiError(400, "validation_failed", `Unsafe path in zip: ${name}`);
    total += size;
    if (total > maxTotal) throw new ApiError(413, "payload_too_large", "Build is too large once unzipped");
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    const raw = u8.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else throw new ApiError(400, "validation_failed", `Unsupported compression in ${name}`);
    if (data.byteLength !== size) throw new ApiError(400, "validation_failed", `Size mismatch in ${name}`);
    out.push({ name, data });
  }
  // A single top-level folder containing index.html is unwrapped (common export layout).
  if (!out.some((f) => f.name === "index.html")) {
    const tops = new Set(out.map((f) => f.name.split("/")[0]));
    if (tops.size === 1) { const t = [...tops][0] + "/"; if (out.some((f) => f.name === t + "index.html")) out.forEach((f) => (f.name = f.name.slice(t.length))); }
  }
  return out;
}

route({
  method: "POST", path: "/games/{id}/build", op: "games.build_upload", tag: "Games", perm: "games:update", gameParam: "id", resource: "game", rawBody: true,
  summary: "Upload a browser build as a .zip (must contain index.html). Stored in R2 and served at /<id>/play/ behind the Turnstile gate. Turn on web play separately.",
  handler: async (ctx, { params, body: request }) => {
    needR2(ctx);
    const { row, obj } = await GAMES.load(ctx.env.DB, params.id);
    checkIfMatch(ctx, row.version);
    if (Number(request.headers.get("Content-Length") || 0) > 100 * 1024 * 1024) throw new ApiError(413, "payload_too_large", "Max 100 MB zip");
    const files = await unzip(await request.arrayBuffer());
    if (!files.some((f) => f.name === "index.html")) throw new ApiError(400, "validation_failed", "The zip must contain index.html at its root");
    const buildId = randomId("b", 10);
    const size = files.reduce((n, f) => n + f.data.byteLength, 0);
    const build = { id: buildId, files: files.length, size, uploaded_at: iso(ctx.now), uploaded_by: ctx.actor.name };
    if (!ctx.dryRun) for (const f of files) await ctx.env.MEDIA.put(`builds/${params.id}/${buildId}/${f.name}`, f.data, { httpMetadata: { contentType: MIME[ext(f.name)] || "application/octet-stream" } });
    const after = { ...obj, build };
    const old = obj.build;
    const tx = new Tx(ctx);
    tx.guard("SELECT 1 FROM games WHERE id = ? AND version = ?", [params.id, row.version]);
    tx.run("UPDATE games SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?", JSON.stringify(after), ctx.now, ctx.actor.name, params.id);
    tx.run("INSERT INTO revisions (resource_type, resource_id, version, data, created_at, actor) VALUES ('game', ?, ?, ?, ?, ?)", params.id, row.version + 1, JSON.stringify(after), ctx.now, ctx.actor.name);
    tx.audit({ action: "game.build_upload", resourceType: "game", resourceId: params.id, label: obj.title, changes: diff({ build: old }, { build }), meta: { file_list: files.slice(0, 200).map((f) => f.name) } });
    tx.event("game.build_uploaded", { id: params.id, build });
    tx.content(`/${params.id}/`);
    if (old?.id) tx.afterCommit(async () => { const l = await ctx.env.MEDIA.list({ prefix: `builds/${params.id}/${old.id}/` }); await ctx.env.MEDIA.delete(l.objects.map((o) => o.key)); });
    try { await tx.commit(); } catch (e) { if (!ctx.dryRun) { const l = await ctx.env.MEDIA.list({ prefix: `builds/${params.id}/${buildId}/` }); await ctx.env.MEDIA.delete(l.objects.map((o) => o.key)); } throw e; }
    return reply({ id: params.id, build, files: files.map((f) => f.name).slice(0, 500), web_play_enabled: !!obj.webPlay?.enabled, play_url: `/${params.id}/play/` }, { status: ctx.dryRun ? 200 : 201 });
  }
});
route({
  method: "DELETE", path: "/games/{id}/build", op: "games.build_delete", tag: "Games", perm: "games:update", gameParam: "id", resource: "game", destructive: true,
  summary: "Remove the uploaded R2 build (falls back to public/<id>/play/ if present).",
  handler: async (ctx, { params }) => {
    const { row, obj } = await GAMES.load(ctx.env.DB, params.id);
    if (!obj.build) throw new ApiError(404, "not_found", "No uploaded build");
    const { build, ...after } = obj;
    const tx = new Tx(ctx);
    tx.run("UPDATE games SET data = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?", JSON.stringify(after), ctx.now, ctx.actor.name, params.id);
    tx.audit({ action: "game.build_delete", resourceType: "game", resourceId: params.id, label: obj.title, changes: diff({ build }, {}) });
    tx.content(`/${params.id}/`);
    tx.afterCommit(async () => { needR2(ctx); const l = await ctx.env.MEDIA.list({ prefix: `builds/${params.id}/${build.id}/` }); await ctx.env.MEDIA.delete(l.objects.map((o) => o.key)); });
    void row;
    await tx.commit();
    return { deleted: build.id };
  }
});

export { gameFromRow, j };

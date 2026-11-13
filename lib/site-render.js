/* Public pages rendered from D1 with the same pure render functions the static build uses,
   cached at the edge (Cache API) under a content-version key that every content change bumps (= instant purge).
   Returns null whenever the static files in public/ should answer instead (no D1, not seeded, unknown path…). */
import * as R from "../tools/render/index.mjs";
import { loadContent } from "./admin/content.js";
import { publicState } from "./admin/state.js";
import { publishDue } from "./admin/tick.js";
import { getCookie, SESSION_COOKIE } from "./admin/auth.js";
import { PUBLIC_HEADERS } from "./site-headers.js";
import { ASSET_VERSION } from "./site.generated.js";

const STATIC_DIRS = new Set(["admin", "api", "assets", "css", "js", "media", "cdn-cgi", "functions"]);
const TYPES = { html: "text/html; charset=utf-8", xml: "application/xml; charset=utf-8", rss: "application/rss+xml; charset=utf-8", txt: "text/plain; charset=utf-8", json: "application/manifest+json; charset=utf-8" };

/** The cache for rendered pages: env.RENDER_CACHE on the Node host (lib/platform/cache.js), else Cloudflare's edge cache. */
export const renderCache = (env) => env.RENDER_CACHE || (typeof caches !== "undefined" ? caches.default : null);

/** Map a URL path to what should be rendered (without touching D1). */
export function classify(path) {
  if (path === "/" || path === "/index.html") return { kind: "home" };
  if (path === "/news/" || path === "/news/index.html") return { kind: "news" };
  if (path === "/news/feed.xml") return { kind: "rss" };
  if (path === "/sitemap.xml") return { kind: "sitemap" };
  if (path === "/robots.txt") return { kind: "robots" };
  if (path === "/manifest.webmanifest") return { kind: "manifest" };
  if (path === "/404.html") return { kind: "404" };
  if (path === "/press/" || path === "/press/index.html") return { kind: "press" };
  let m = path.match(/^\/news\/([a-z0-9-]+)\/(?:index\.html)?$/);
  if (m) return { kind: "post", slug: m[1] };
  m = path.match(/^\/news\/([a-z0-9-]+)$/);
  if (m) return { kind: "slash", to: `${path}/` };
  m = path.match(/^\/([a-z0-9-]+)\/(?:index\.html)?$/);
  if (m && !STATIC_DIRS.has(m[1])) return { kind: "slug", slug: m[1] };
  m = path.match(/^\/([a-z0-9-]+)$/);
  if (m && !STATIC_DIRS.has(m[1])) return { kind: "maybe-slash", slug: m[1], to: `${path}/` };
  return null;
}

function render(c, target, now) {
  const base = { settings: c.settings, version: ASSET_VERSION };
  const { games, team, posts, pages } = c;
  const author = (id) => team.find((m) => m.id === id);
  switch (target.kind) {
    case "home": return [200, "html", R.renderHomePage({ ...base, games, team, news: posts })];
    case "news": return [200, "html", R.renderNewsIndex({ ...base, posts })];
    case "rss": return [200, "rss", R.renderRss({ settings: c.settings, posts })];
    case "sitemap": return [200, "xml", sitemapWithPages(c)];
    case "robots": return [200, "txt", R.renderRobots({ settings: c.settings })];
    case "manifest": return [200, "json", R.renderManifest({ settings: c.settings })];
    case "press": return [200, "html", R.renderPressPage({ ...base, games, team })];
    case "404": return [404, "html", R.render404Page(base)];
    case "post": {
      const p = posts.find((x) => x.slug === target.slug);
      if (!p) return [404, "html", R.render404Page(base)];
      return [200, "html", R.renderNewsPost({ ...base, post: p, author: author(p.author), game: games.find((g) => g.id === p.game), related: R.relatedPosts(p, posts) })];
    }
    case "slug": {
      const g = games.find((x) => x.id === target.slug);
      if (g) return [200, "html", R.renderGamePage({ ...base, game: g, news: posts.filter((p) => p.game === g.id) })];
      const pg = pages.find((x) => x.slug === target.slug);
      if (pg) return [200, "html", R.renderMarkdownPage({ ...base, source: pg.source, path: `/${pg.slug}/` })];
      return [404, "html", R.render404Page(base)];
    }
  }
  void now;
  return null;
}
function sitemapWithPages(c) {
  const xml = R.renderSitemap({ settings: c.settings, games: c.games, posts: c.posts });
  const extra = c.pages.filter((p) => p.slug !== "privacy").map((p) => `  <url><loc>${R.components.absUrl(c.settings, `/${p.slug}/`)}</loc></url>`).join("\n");
  return extra ? xml.replace("</urlset>", `${extra}\n</urlset>`) : xml;
}

async function etagOf(body) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(body)));
  return `"${[...d.slice(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

export function maintenancePage(settings, message) {
  const main = `<section class="wrap lost"><img class="lost__mark float" src="/assets/mark.svg" alt="" width="180" height="180"><p class="eyebrow">Back soon</p><h1>We're tuning the telescope</h1><p>${R.escapeHtml(message || "We're polishing a few things — back very soon!")}</p></section>`;
  return R.renderLayout({ settings, version: ASSET_VERSION, title: `Back soon · ${settings.studioName}`, description: "Scheduled maintenance.", path: "/", main, noindex: true });
}

/**
 * @returns {Promise<Response|null>}
 */
export async function renderPublic({ request, env, waitUntil }) {
  if (!env.DB || (request.method !== "GET" && request.method !== "HEAD")) return null;
  const url = new URL(request.url);
  const target = classify(url.pathname);
  const isPlay = /^\/[a-z0-9-]+\/play(\/|$)/.test(url.pathname);
  if (!target && !isPlay) return null;
  let st;
  try { st = await publicState(env); } catch { return null; } // tables missing → static site
  if (!st.seeded) return null;
  const now = Date.now();
  if (st.nextPublishAt && now >= st.nextPublishAt) {
    try { await publishDue(env, now, waitUntil); } catch (e) { console.error("scheduled publish failed", e); }
    st = await publicState(env, now + 60_000);
  }
  if (st.maintenance && !getCookie(request, SESSION_COOKIE)) {
    const c = await loadContent(env.DB, now);
    if (!c) return null;
    return new Response(request.method === "HEAD" ? null : maintenancePage(c.settings, st.maintenance.message), { status: 503, headers: { ...PUBLIC_HEADERS, "Content-Type": TYPES.html, "Cache-Control": "no-store", "Retry-After": "600", "X-Robots-Tag": "noindex" } });
  }
  if (isPlay) return null;

  if (target.kind === "slash") return Response.redirect(`${url.origin}${target.to}${url.search}`, 308);
  const cache = renderCache(env);
  const key = new Request(`${url.origin}/__tc_render/v${st.contentVersion}${target.kind === "maybe-slash" ? `/${target.slug}` : url.pathname}`);
  let cached = null;
  if (cache && target.kind !== "maybe-slash") { try { cached = await cache.match(key); } catch { cached = null; } }
  let status, type, body, etag;
  if (cached) {
    status = cached.status; type = cached.headers.get("Content-Type"); etag = cached.headers.get("ETag"); body = await cached.text();
  } else {
    const c = await loadContent(env.DB, now);
    if (!c) return null;
    if (target.kind === "maybe-slash") {
      const known = c.games.some((g) => g.id === target.slug) || c.pages.some((p) => p.slug === target.slug);
      return known ? Response.redirect(`${url.origin}${target.to}${url.search}`, 308) : null;
    }
    const out = render(c, target, now);
    if (!out) return null;
    [status, type, body] = [out[0], TYPES[out[1]], out[2]];
    etag = await etagOf(body);
    if (cache) {
      const put = cache.put(key, new Response(body, { status, headers: { "Content-Type": type, ETag: etag, "Cache-Control": "public, max-age=86400" } })).catch(() => {});
      if (waitUntil) waitUntil(put); else await put;
    }
  }
  const headers = { ...PUBLIC_HEADERS, "Content-Type": type, "Cache-Control": "public, max-age=0, must-revalidate", ETag: etag, "X-Rendered-From": "d1", "X-Cache": cached ? "HIT" : "MISS" };
  if (status === 404) headers["X-Robots-Tag"] = "noindex";
  if (request.headers.get("If-None-Match") === etag && status === 200) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}

/* ---------- web play from D1 (+ R2 builds) ---------- */
let playMemo = { at: 0, db: null, games: new Map() };
/** Game info if browser play is enabled in D1, else undefined; null when D1 isn't the source of truth. */
export async function playableFromD1(env, slug, now = Date.now()) {
  if (!env.DB) return null;
  try {
    if (playMemo.db !== env.DB || now - playMemo.at > 10_000) {
      const st = await publicState(env, now);
      if (!st.seeded) return null;
      const { results } = await env.DB.prepare("SELECT id, data FROM games WHERE deleted_at IS NULL").all();
      const games = new Map();
      for (const r of results) { const d = JSON.parse(r.data); if (d.webPlay?.enabled) games.set(r.id, d); }
      playMemo = { at: now, db: env.DB, games };
    }
    return playMemo.games.get(slug);
  } catch { return null; }
}
export async function renderGateFromD1(env, slug) {
  const c = await loadContent(env.DB);
  const game = c?.games.find((g) => g.id === slug);
  return game ? R.renderGatePage({ settings: c.settings, game, version: ASSET_VERSION }) : null;
}

/* Content in D1 ↔ the plain objects the render layer (tools/render) expects ↔ repo files (content/). */
import { parsePost, parseFrontMatter } from "../../tools/render/index.mjs";

export const j = (s, fallback = null) => { if (s == null) return fallback; try { return JSON.parse(s); } catch { return fallback; } };

/* ---------- row → object ---------- */
export const gameFromRow = (r) => r && { ...j(r.data, {}), id: r.id, title: r.title, status: r.status };
export const memberFromRow = (r) => r && { ...j(r.data, {}), id: r.id, name: r.name };

/** Admin-facing news object (flat, editable fields). */
export function newsFromRow(r) {
  if (!r) return r;
  const d = j(r.data, {});
  return {
    slug: r.slug, title: r.title, status: r.status, publish_at: r.publish_at ? new Date(r.publish_at).toISOString() : null,
    date: r.date, updated: d.updated || "", category: r.category, game: r.game, author: r.author,
    excerpt: d.excerpt || "", cover: d.cover || "", placeholder: d.placeholder === true, body: r.body
  };
}
/** Render-layer post object (same shape parsePost produces for the static build). */
export function postFromNews(n) {
  const base = parsePost(`${n.date}-${n.slug}.md`, "---\n_: \n---\n" + (n.body || ""));
  return {
    ...base, slug: n.slug, title: n.title, date: n.date, updated: n.updated || "", category: n.category || "Update",
    author: n.author || "", excerpt: n.excerpt || base.excerpt, cover: n.cover || "", game: n.game || "",
    placeholder: n.placeholder === true, draft: n.status !== "published" && n.status !== "scheduled"
  };
}
export const pageFromRow = (r) => r && { slug: r.slug, title: r.title, source: r.source };

const isLive = (n, now) => n.status === "published" || (n.status === "scheduled" && n.publish_at && Date.parse(n.publish_at) <= now);

/** Everything the public site needs, in one D1 round-trip. */
export async function loadContent(db, now = Date.now()) {
  const [s, g, t, n, p] = await db.batch([
    db.prepare("SELECT data FROM settings WHERE id = 'site'"),
    db.prepare("SELECT * FROM games WHERE deleted_at IS NULL ORDER BY position, id"),
    db.prepare("SELECT * FROM team WHERE deleted_at IS NULL ORDER BY position, id"),
    db.prepare("SELECT * FROM news WHERE deleted_at IS NULL AND status IN ('published', 'scheduled') ORDER BY date DESC, title"),
    db.prepare("SELECT * FROM pages WHERE deleted_at IS NULL")
  ]);
  const settings = j(s.results[0]?.data, null);
  if (!settings) return null;
  const posts = n.results.map(newsFromRow).filter((x) => isLive(x, now)).map(postFromNews)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.title.localeCompare(b.title));
  return { settings, games: g.results.map(gameFromRow), team: t.results.map(memberFromRow), posts, pages: p.results.map(pageFromRow) };
}

/* ---------- repo files ↔ bundle ---------- */
const fmValue = (v) => (typeof v === "boolean" ? String(v) : `"${String(v ?? "").replace(/[\r\n]+/g, " ").replace(/"/g, '\\"')}"`);
export function newsToMarkdown(n) {
  const fm = [["title", n.title], ["date", n.date]];
  if (n.updated) fm.push(["updated", n.updated]);
  fm.push(["category", n.category], ["author", n.author], ["excerpt", n.excerpt], ["cover", n.cover], ["game", n.game]);
  if (n.status !== "published") fm.push(["draft", true]);
  if (n.status === "scheduled" && n.publish_at) fm.push(["publishAt", n.publish_at]);
  if (n.placeholder) fm.push(["placeholder", true]);
  const lines = fm.map(([k, v]) => `${k}: ${k === "date" || k === "category" || k === "author" || k === "game" ? (v ? String(v) : '""') : fmValue(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n${String(n.body || "").replace(/^\n+/, "")}`;
}
export function newsFromMarkdown(filename, source) {
  const { data } = parseFrontMatter(source);
  const p = parsePost(filename, source);
  const publishAt = data.publishAt ? Date.parse(String(data.publishAt)) : NaN;
  const status = p.draft ? (Number.isFinite(publishAt) ? "scheduled" : "draft") : "published";
  return {
    slug: p.slug, title: p.title, status, publish_at: Number.isFinite(publishAt) ? new Date(publishAt).toISOString() : null, date: p.date, updated: p.updated,
    category: p.category, game: p.game, author: p.author, excerpt: String(data.excerpt || ""), cover: p.cover, placeholder: p.placeholder, body: p.body.replace(/^\n+/, "")
  };
}

/** Export everything as repo files: { "content/settings.json": "...", "content/news/2026-..md": "..." } */
export async function exportFiles(db) {
  const [s, g, t, n, p] = await db.batch([
    db.prepare("SELECT data FROM settings WHERE id = 'site'"),
    db.prepare("SELECT * FROM games WHERE deleted_at IS NULL ORDER BY position, id"),
    db.prepare("SELECT * FROM team WHERE deleted_at IS NULL ORDER BY position, id"),
    db.prepare("SELECT * FROM news WHERE deleted_at IS NULL ORDER BY date, slug"),
    db.prepare("SELECT * FROM pages WHERE deleted_at IS NULL ORDER BY slug")
  ]);
  const pretty = (x) => JSON.stringify(x, null, 2) + "\n";
  const files = {};
  files["content/settings.json"] = pretty(j(s.results[0]?.data, {}));
  files["content/games.json"] = pretty(g.results.map(gameFromRow).map(({ build, ...rest }) => rest));
  files["content/team.json"] = pretty(t.results.map(memberFromRow));
  for (const r of n.results) { const x = newsFromRow(r); files[`content/news/${x.date}-${x.slug}.md`] = newsToMarkdown(x); }
  for (const r of p.results) files[`content/pages/${r.slug}.md`] = r.source.endsWith("\n") ? r.source : r.source + "\n";
  return files;
}

/** Parse a files bundle (same shape as exportFiles) into entities. */
export function parseFiles(files) {
  const out = { settings: null, games: null, team: null, news: [], pages: [] };
  for (const [path, text] of Object.entries(files || {})) {
    if (path === "content/settings.json") out.settings = JSON.parse(text);
    else if (path === "content/games.json") out.games = JSON.parse(text);
    else if (path === "content/team.json") out.team = JSON.parse(text);
    else if (/^content\/news\/[^/]+\.md$/.test(path)) out.news.push(newsFromMarkdown(path.split("/").pop(), text));
    else if (/^content\/pages\/[a-z0-9-]+\.md$/.test(path)) {
      const slug = path.split("/").pop().replace(/\.md$/, "");
      out.pages.push({ slug, title: String(parseFrontMatter(text).data.title || slug), source: text });
    }
  }
  return out;
}

/** Statement recomputing the earliest pending scheduled post (drives the publish tick + cache TTL). */
export const nextPublishStmt = (db, now = Date.now()) => db.prepare(
  "INSERT INTO site_state (key, value, updated_at) VALUES ('next_publish_at', COALESCE((SELECT CAST(MIN(publish_at) AS TEXT) FROM news WHERE status = 'scheduled' AND deleted_at IS NULL), '0'), ?) " +
  "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(now);

/* Newsroom renderers. Pure: (data) → HTML string. */
import { renderLayout, sectionHead } from "./layout.mjs";
import { esc, icon, absUrl, newsPath, gamePath, formatDate, newsCard, newsCover, avatar, statusBadge } from "./components.mjs";
import { markdownToHtml, markdownToText, parseFrontMatter } from "./markdown.mjs";

export const NEWS_CATEGORIES = ["Announcement", "Devlog", "Release", "Update", "Press"];
export const NEWS_PAGE_SIZE = 9;

/**
 * Turn a Markdown file (front-matter + body) into a post object.
 * Pure — the caller supplies the file name and text.
 * @returns {{slug,title,date,category,author,excerpt,cover,game,placeholder,draft,body,bodyHtml,readingMinutes}}
 */
export function parsePost(filename, source) {
  const { data, body } = parseFrontMatter(source);
  const base = String(filename).replace(/\.md$/i, "").split("/").pop();
  const slug = String(data.slug || base.replace(/^\d{4}-\d{2}-\d{2}-/, "")).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  const text = markdownToText(body);
  const words = text ? text.split(/\s+/).length : 0;
  const date = data.date ? String(data.date) : (base.match(/^\d{4}-\d{2}-\d{2}/) || [""])[0];
  return {
    slug,
    title: String(data.title || slug),
    date,
    updated: data.updated ? String(data.updated) : "",
    category: NEWS_CATEGORIES.includes(data.category) ? data.category : (data.category ? String(data.category) : "Update"),
    author: String(data.author || ""),
    excerpt: String(data.excerpt || text.slice(0, 180) + (text.length > 180 ? "…" : "")),
    cover: String(data.cover || ""),
    game: String(data.game || ""),
    placeholder: data.placeholder === true,
    draft: data.draft === true,
    body,
    bodyHtml: markdownToHtml(body),
    readingMinutes: Math.max(1, Math.round(words / 200))
  };
}

/** Newest first; drafts removed. */
export function sortPosts(posts) {
  return posts.filter((p) => !p.draft).sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.title.localeCompare(b.title));
}

export function renderNewsIndex({ settings: s, posts, version }) {
  const [featured, ...rest] = posts;
  const cats = NEWS_CATEGORIES.filter((c) => posts.some((p) => p.category === c))
    .concat([...new Set(posts.map((p) => p.category))].filter((c) => !NEWS_CATEGORIES.includes(c)));

  const featuredHtml = featured ? `
    <article class="featured reveal">
      <a class="featured__link" href="${newsPath(featured)}">
        ${newsCover(featured, { cls: "featured__cover", eager: true, uidSuffix: "-feat" })}
        <div class="featured__body">
          <p class="news-meta"><span class="eyebrow eyebrow--plain">Latest</span><span class="cat">${esc(featured.category)}</span><time datetime="${esc(featured.date)}">${esc(formatDate(featured.date))}</time></p>
          <h2 class="featured__title">${esc(featured.title)}</h2>
          <p class="featured__excerpt">${esc(featured.excerpt)}</p>
          <span class="card__more">Read the post ${icon("arrow")}</span>
        </div>
      </a>
    </article>` : `<p class="empty">No news yet — check back soon!</p>`;

  const main = `
<section class="section section--first">
  <div class="wrap">
    ${sectionHead({ eyebrow: "Newsroom", title: "News & devlogs", level: 1, text: "Announcements, behind-the-scenes devlogs and release notes from the Tiny Comet team." })}
    ${featuredHtml}
    ${rest.length ? `
    <div class="news-list" data-news-list data-page-size="${NEWS_PAGE_SIZE}">
      <div class="news-list__head">
        <h2 class="news-list__title">More posts</h2>
        ${cats.length > 1 ? `<div class="filters" role="group" aria-label="Filter by category">
          <button type="button" class="filter is-active" data-filter="all" aria-pressed="true">All</button>
          ${cats.map((c) => `<button type="button" class="filter" data-filter="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join("")}
        </div>` : ""}
      </div>
      <ul class="news-grid">${rest.map((p, i) => newsCard(p, { i })).join("")}</ul>
      <p class="news-list__empty" hidden>No posts in this category yet.</p>
      <div class="news-list__more"><button type="button" class="btn btn--ghost" data-load-more hidden>Load more</button></div>
    </div>` : ""}
    <p class="rss-note">${icon("news")} Follow along with our <a href="/news/feed.xml">RSS feed</a>.</p>
  </div>
</section>`;

  return renderLayout({
    settings: s, version, active: "news",
    title: `News · ${s.studioName}`,
    description: `News, devlogs and release notes from ${s.studioName}.`,
    path: "/news/",
    main,
    jsonLd: {
      "@context": "https://schema.org", "@type": "Blog", name: `${s.studioName} News`, url: absUrl(s, "/news/"),
      blogPost: posts.slice(0, 10).map((p) => ({ "@type": "BlogPosting", headline: p.title, url: absUrl(s, newsPath(p)), datePublished: p.date }))
    }
  });
}

function shareLinks(s, post) {
  const url = encodeURIComponent(absUrl(s, newsPath(post)));
  const text = encodeURIComponent(post.title);
  const items = [
    ["x", "X", `https://twitter.com/intent/tweet?text=${text}&url=${url}`],
    ["facebook", "Facebook", `https://www.facebook.com/sharer/sharer.php?u=${url}`],
    ["linkedin", "LinkedIn", `https://www.linkedin.com/sharing/share-offsite/?url=${url}`],
    ["whatsapp", "WhatsApp", `https://wa.me/?text=${text}%20${url}`]
  ];
  return `<div class="share" aria-label="Share this post">
      <span class="share__label">Share</span>
      <ul class="share__list">
        ${items.map(([k, label, href]) => `<li><a class="share__btn" href="${href}" target="_blank" rel="noopener" data-track="share_click" data-network="${k}" aria-label="Share on ${label}">${icon(k)}</a></li>`).join("")}
        <li><button type="button" class="share__btn" data-copy="${esc(absUrl(s, newsPath(post)))}" data-track="share_click" data-network="copy" aria-label="Copy link">${icon("link")}</button></li>
      </ul>
      <span class="share__copied" role="status" aria-live="polite"></span>
    </div>`;
}

/**
 * @param {{settings:object, post:object, author?:object, game?:object, related?:object[], version?:string}} d
 */
export function renderNewsPost({ settings: s, post, author, game, related = [], version }) {
  const body = post.bodyHtml || markdownToHtml(post.body);
  const main = `
<article class="wrap article" data-news="${esc(post.slug)}">
  <a class="back-link" href="/news/">${icon("back")}<span>All news</span></a>
  <header class="article__head">
    <p class="news-meta"><span class="cat">${esc(post.category)}</span><time datetime="${esc(post.date)}">${esc(formatDate(post.date))}</time><span>${post.readingMinutes} min read</span>${post.placeholder ? '<span class="sample-tag">Sample post</span>' : ""}</p>
    <h1>${esc(post.title)}</h1>
    ${post.excerpt ? `<p class="article__lead">${esc(post.excerpt)}</p>` : ""}
    <div class="article__byline">
      ${author ? `<div class="byline">${avatar(author, "avatar--sm")}<div><strong>${esc(author.name)}</strong><span>${esc(author.role || "")}</span></div></div>` : ""}
      ${shareLinks(s, post)}
    </div>
  </header>
  ${newsCover(post, { cls: "article__cover", eager: true, uidSuffix: "-hero" })}
  <div class="article__body prose prose--article">
    ${body}
  </div>
  ${game ? `<aside class="article__game" aria-label="Related game">
    <a class="game-link" href="${gamePath(game)}">
      <span class="game-link__text"><small>Related ${esc(String(game.kind || "game").toLowerCase())}</small><strong>${esc(game.title)}</strong><span>${esc(game.tagline || "")}</span></span>
      ${statusBadge(game.status)}
      <span class="card__more">View ${icon("arrow")}</span>
    </a>
  </aside>` : ""}
  <footer class="article__foot">${shareLinks(s, post)}</footer>
</article>
${related.length ? `<section class="section section--related" aria-labelledby="related-h">
  <div class="wrap">
    <h2 id="related-h" class="related__title">Keep reading</h2>
    <ul class="news-grid">${related.slice(0, 3).map((p, i) => newsCard(p, { i })).join("")}</ul>
  </div>
</section>` : ""}`;

  return renderLayout({
    settings: s, version, active: "news",
    title: `${post.title} · ${s.studioName}`,
    description: post.excerpt,
    path: newsPath(post),
    ogType: "article",
    ogImage: post.cover || undefined,
    main,
    extraHead: `<meta property="article:published_time" content="${esc(post.date)}">\n<meta property="article:section" content="${esc(post.category)}">`,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      headline: post.title,
      description: post.excerpt,
      datePublished: post.date,
      dateModified: post.updated || post.date,
      image: [absUrl(s, post.cover || "/assets/icon.png")],
      mainEntityOfPage: absUrl(s, newsPath(post)),
      author: author ? [{ "@type": "Person", name: author.name, jobTitle: author.role }] : [{ "@type": "Organization", name: s.studioName }],
      publisher: { "@type": "Organization", name: s.studioName, logo: { "@type": "ImageObject", url: absUrl(s, "/assets/icon.png") } },
      articleSection: post.category,
      about: game ? { "@type": game.kind === "App" ? "SoftwareApplication" : "VideoGame", name: game.title, url: absUrl(s, gamePath(game)) } : undefined
    }
  });
}

/** Related posts: same game first, then same category, then newest. */
export function relatedPosts(post, posts, n = 3) {
  const others = posts.filter((p) => p.slug !== post.slug);
  const score = (p) => (post.game && p.game === post.game ? 2 : 0) + (p.category === post.category ? 1 : 0);
  return others.map((p, i) => ({ p, s: score(p), i })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, n).map((x) => x.p);
}

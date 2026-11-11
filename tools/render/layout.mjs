/* Page shell: <head>, header, footer. Pure function — returns an HTML string. */
import { esc, absUrl, socialList, icon } from "./components.mjs";

/**
 * @param {object} o
 * @param {object} o.settings      content/settings.json
 * @param {string} o.title         full <title>
 * @param {string} o.description   meta description
 * @param {string} o.path          root-relative path of this page, e.g. "/news/"
 * @param {string} o.main          inner HTML of <main>
 * @param {string} [o.ogType]      "website" | "article"
 * @param {string} [o.ogImage]     root-relative or absolute image URL
 * @param {object|object[]} [o.jsonLd]
 * @param {string} [o.extraHead]
 * @param {string[]} [o.scripts]   extra module scripts (root-relative)
 * @param {boolean} [o.noindex]
 * @param {string} [o.version]     cache-busting version for css/js
 * @param {string} [o.active]      nav key to mark current: games|news|about|press|contact
 * @param {string} [o.bodyClass]
 */
export function renderLayout(o) {
  const s = o.settings;
  const v = o.version ? `?v=${o.version}` : "";
  const canonical = absUrl(s, o.path || "/");
  const ogImage = /^https?:/.test(o.ogImage || "") ? o.ogImage : absUrl(s, o.ogImage || "/assets/icon.png");
  const isSquare = !o.ogImage || /icon/.test(o.ogImage);
  const ld = o.jsonLd ? (Array.isArray(o.jsonLd) ? o.jsonLd : [o.jsonLd]) : [];
  const nav = [
    ["games", "/#games", "Games"],
    ["news", "/news/", "News"],
    ["about", "/#about", "About"],
    ["press", "/press/", "Press"]
  ];
  const cur = (k) => (o.active === k ? ' aria-current="page"' : "");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description || s.description)}">
<meta name="theme-color" content="#17183F">
<meta name="color-scheme" content="dark">
${o.noindex ? '<meta name="robots" content="noindex">\n' : ""}<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="${esc(o.ogType || "website")}">
<meta property="og:site_name" content="${esc(s.studioName)}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description || s.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta name="twitter:card" content="${isSquare ? "summary" : "summary_large_image"}">
<meta name="twitter:title" content="${esc(o.title)}">
<meta name="twitter:description" content="${esc(o.description || s.description)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="alternate" type="application/rss+xml" title="${esc(s.studioName)} news" href="/news/feed.xml">
<link rel="preload" href="/assets/fonts/fredoka-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/nunito-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/style.css${v}">
${s.analyticsEndpoint ? `<meta name="tc-analytics" content="${esc(s.analyticsEndpoint)}">\n` : ""}<script type="module" src="/js/main.js${v}"></script>
${(o.scripts || []).map((src) => `<script type="module" src="${esc(src)}${v}"></script>`).join("\n")}
${ld.map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`).join("\n")}
${o.extraHead || ""}
</head>
<body${o.bodyClass ? ` class="${esc(o.bodyClass)}"` : ""}>
<a class="skip-link" href="#main">Skip to content</a>
<div class="sky" aria-hidden="true"><span></span><span></span><span></span><i></i></div>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/" aria-label="${esc(s.studioName)} — home">
      <img src="/assets/logo-on-dark.svg" alt="${esc(s.studioName)}" width="160" height="42">
    </a>
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-menu" aria-label="Open menu"><span></span></button>
    <nav class="site-nav" id="site-menu" aria-label="Main">
      <ul>
        ${nav.map(([k, href, label]) => `<li><a href="${href}"${cur(k)}>${label}</a></li>`).join("\n        ")}
        <li><a class="nav-cta" href="/#contact">Contact</a></li>
      </ul>
    </nav>
  </div>
</header>
<main id="main">
${o.main}
</main>
${renderFooter(s)}
</body>
</html>
`;
}

export function renderFooter(s) {
  const year = new Date().getFullYear();
  return `<footer class="site-footer">
  <div class="wrap">
    <div class="footer-inner">
      <div class="footer-brand">
        <img src="/assets/icon.svg" alt="" width="44" height="44" decoding="async">
        <p><strong>${esc(s.studioName)}</strong><br>Games &amp; apps, made with care.</p>
      </div>
      <nav aria-label="Footer">
        <ul class="footer-links">
          <li><a href="/#games">Games</a></li>
          <li><a href="/news/">News</a></li>
          <li><a href="/press/">Press kit</a></li>
          <li><a href="/#contact">Contact</a></li>
          <li><a href="/privacy/">Privacy policy</a></li>
          <li><a href="/news/feed.xml">RSS</a></li>
        </ul>
      </nav>
      <ul class="socials footer-socials" aria-label="Social links">${socialList(s.socials, { compact: true })}</ul>
    </div>
    <div class="footer-bottom">
      <p>© <span data-year>${year}</span> ${esc(s.studioName)}. All rights reserved.</p>
      <p>Made with <span class="heart" aria-hidden="true">☄</span><span class="sr-only">a comet</span> in ${esc(s.country || "Pakistan")}</p>
    </div>
  </div>
</footer>`;
}

/** Reusable section heading block. */
export function sectionHead({ eyebrow, title, text, id, center = false, level = 2 }) {
  return `<div class="section-head${center ? " section-head--center" : ""}">` +
    (eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : "") +
    `<h${level}${id ? ` id="${id}"` : ""}>${esc(title)}</h${level}>` +
    (text ? `<p>${esc(text)}</p>` : "") + `</div>`;
}
export { icon };

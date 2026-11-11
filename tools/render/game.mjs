/* Game/app info page + web-play gate page. Pure: (data) → HTML string. */
import { renderLayout } from "./layout.mjs";
import {
  esc, icon, absUrl, gamePath, playPath, formatDate, paragraphs, statusBadge, STATUS, PLATFORM_LABELS,
  storeBadges, playButton, genreChips, gameCover, newsCard, asList
} from "./components.mjs";
import { youtubeEmbed } from "./markdown.mjs";

function gameJsonLd(s, g) {
  const isApp = String(g.kind || "Game").toLowerCase() === "app";
  const platforms = asList(g.platforms).map((p) => PLATFORM_LABELS[p] || p);
  const ld = {
    "@context": "https://schema.org",
    "@type": isApp ? "SoftwareApplication" : "VideoGame",
    name: g.title,
    description: g.tagline,
    url: absUrl(s, gamePath(g)),
    image: absUrl(s, g.cover || "/assets/icon.png"),
    genre: asList(g.genres),
    author: { "@type": "Organization", name: s.studioName, url: absUrl(s, "/") },
    publisher: { "@type": "Organization", name: s.studioName }
  };
  if (isApp) { ld.operatingSystem = platforms.join(", "); ld.applicationCategory = "UtilitiesApplication"; }
  else { ld.gamePlatform = platforms; ld.applicationCategory = "GameApplication"; }
  if (g.status === "released" && /^\d{4}/.test(g.releaseDate || "")) ld.datePublished = g.releaseDate;
  const sameAs = Object.values(g.links || {}).filter((u) => /^https?:/.test(u || ""));
  if (sameAs.length) ld.sameAs = sameAs;
  return ld;
}

/**
 * @param {{settings:object, game:object, news?:object[], version?:string}} d
 */
export function renderGamePage({ settings: s, game: g, news = [], version }) {
  const stores = storeBadges(g);
  const play = playButton(g);
  const genres = genreChips(g);
  const facts = [
    ["Status", STATUS[g.status] || STATUS["coming-soon"]],
    ["Type", g.kind || "Game"],
    ["Platforms", asList(g.platforms).map((p) => PLATFORM_LABELS[p] || p).join(", ")],
    [g.status === "released" ? "Released" : "Planned release", formatDate(g.releaseDate) || (g.status === "released" ? "" : "TBA")],
    ["Developer", s.studioName]
  ].filter((f) => f[1]).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");

  const trailer = g.trailer ? youtubeEmbed(g.trailer, `${g.title} trailer`) : "";
  const shots = asList(g.screenshots).map((x, i) => {
    const src = typeof x === "string" ? x : x.src;
    const alt = (typeof x === "object" && x.alt) || `${g.title} screenshot ${i + 1}`;
    return `<li><a class="shot" href="${esc(src)}" data-lightbox><img src="${esc(src)}" alt="${esc(alt)}" width="1600" height="900" loading="lazy" decoding="async"></a></li>`;
  }).join("");

  const main = `
<article class="wrap detail" data-game="${esc(g.id)}">
  <a class="back-link" href="/#games">${icon("back")}<span>All games</span></a>
  <header class="detail__hero">
    ${gameCover(g, { cls: "detail__cover", eager: true, uid: "hero-" + g.id })}
    <div class="detail__intro">
      <div class="detail__badges">${statusBadge(g.status)}${g.placeholder ? '<span class="sample-tag">Sample entry</span>' : ""}</div>
      <h1>${esc(g.title)}</h1>
      <p class="detail__tagline">${esc(g.tagline || "")}</p>
      ${genres ? `<ul class="chips chips--genre" aria-label="Genres">${genres}</ul>` : ""}
      ${play || stores ? `<div class="stores">${play}${stores}</div>` : ""}
    </div>
  </header>
  <div class="detail__grid">
    <div class="detail__main">
      <section class="detail__section prose" aria-labelledby="about-h">
        <h2 id="about-h">About ${esc(g.title)}</h2>
        ${paragraphs(g.description || g.tagline)}
      </section>
      ${trailer ? `<section class="detail__section" aria-labelledby="trailer-h"><h2 id="trailer-h">Trailer</h2>${trailer}</section>` : ""}
      ${shots ? `<section class="detail__section" aria-labelledby="shots-h"><h2 id="shots-h">Screenshots</h2><ul class="gallery">${shots}</ul></section>` : ""}
      ${news.length ? `<section class="detail__section" aria-labelledby="news-h"><h2 id="news-h">News about ${esc(g.title)}</h2><ul class="news-grid news-grid--compact">${news.slice(0, 4).map((p, i) => newsCard(p, { i })).join("")}</ul></section>` : ""}
    </div>
    <aside class="detail__aside" aria-label="Game facts">
      <dl class="facts">${facts}</dl>
      <p class="aside__note">Want a heads-up when it launches?</p>
      <a class="btn btn--ghost btn--block" href="/#follow">Follow along</a>
      <a class="aside__press" href="/press/#game-${esc(g.id)}">Press info ${icon("arrow")}</a>
    </aside>
  </div>
</article>
<dialog class="lightbox" id="lightbox" aria-label="Screenshot viewer">
  <img src="data:," alt="">
  <div class="lightbox__bar">
    <button type="button" class="lightbox__prev" aria-label="Previous screenshot">←</button>
    <button type="button" class="lightbox__close">Close</button>
    <button type="button" class="lightbox__next" aria-label="Next screenshot">→</button>
  </div>
</dialog>`;

  return renderLayout({
    settings: s, version, active: "games",
    title: `${g.title} — ${g.kind === "App" ? "an app" : "a game"} by ${s.studioName}`,
    description: `${g.tagline || ""} ${STATUS[g.status] || ""}${asList(g.platforms).length ? " on " + asList(g.platforms).map((p) => PLATFORM_LABELS[p] || p).join(", ") : ""}.`.trim(),
    path: gamePath(g),
    ogImage: g.cover || undefined,
    main,
    jsonLd: gameJsonLd(s, g)
  });
}

/** Turnstile "are you human?" page shown at /<slug>/play/ until the visitor holds a valid play cookie. */
export function renderGatePage({ settings: s, game: g, version }) {
  const main = `
<section class="wrap gate">
  <div class="gate__card" data-gate data-slug="${esc(g.id)}" data-sitekey="${esc(s.turnstileSiteKey || "")}">
    <img class="gate__mark float" src="/assets/mark.svg" alt="" width="120" height="120">
    <p class="eyebrow">Play in browser</p>
    <h1>Ready to play ${esc(g.title)}?</h1>
    <p class="gate__lead">A quick check that you're a human, then the game launches right here. It only takes a second.</p>
    <div class="gate__widget" id="turnstile-widget" aria-live="polite"></div>
    <p class="gate__status" id="gate-status" role="status" aria-live="polite">Loading the security check…</p>
    <button class="btn btn--primary gate__retry" id="gate-retry" type="button" hidden>Try again</button>
    <noscript><p class="gate__status">Playing in the browser needs JavaScript turned on for a quick security check.</p></noscript>
    <p class="gate__back"><a href="${gamePath(g)}">${icon("back")}<span>Back to ${esc(g.title)}</span></a></p>
    <p class="gate__fine">Protected by Cloudflare Turnstile — no puzzles, no tracking cookies. <a href="/privacy/">Privacy</a></p>
  </div>
</section>`;
  return renderLayout({
    settings: s, version, active: "games", noindex: true,
    title: `Play ${g.title} · ${s.studioName}`,
    description: `Play ${g.title} in your browser.`,
    path: playPath(g),
    main,
    scripts: ["/js/gate.js"],
    bodyClass: "page-gate"
  });
}

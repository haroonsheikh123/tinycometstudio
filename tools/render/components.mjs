/* Shared, pure render helpers (plain objects in → HTML strings out).
   No Node-only APIs: safe to reuse inside a Cloudflare Pages Function. */
import { escapeHtml as esc, youtubeId } from "./markdown.mjs";
export { esc };

/* ---------- small utils ---------- */
export const isRealUrl = (u) => typeof u === "string" && u.trim() !== "" && u.trim() !== "#";
export const hasUrl = (u) => typeof u === "string" && u.trim() !== "";
export const absUrl = (settings, path = "/") => String(settings.siteUrl || "").replace(/\/+$/, "") + (path.startsWith("/") ? path : "/" + path);
export const gamePath = (g) => `/${g.id}/`;
export const playPath = (g) => `/${g.id}/play/`;
export const newsPath = (p) => `/news/${p.slug}/`;
export const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2027" → "2027", "2027-03" → "March 2027", "2027-03-14" → "14 March 2027" */
export function formatDate(d) {
  if (!d) return "";
  const m = String(d).match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!m) return String(d);
  if (!m[2]) return m[1];
  const month = MONTHS[parseInt(m[2], 10) - 1] || "";
  return (m[3] ? parseInt(m[3], 10) + " " : "") + month + " " + m[1];
}
export function paragraphs(desc) {
  return asList(desc).flatMap((p) => String(p).split(/\n\s*\n/)).filter((p) => p.trim())
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>").replace(/\[PLACEHOLDER:([^\]]*)\]/g, '<mark class="ph">[PLACEHOLDER:$1]</mark>')}</p>`).join("");
}
function hash(str) { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h); }

/* ---------- icons (24×24 line icons, currentColor) ---------- */
const ICONS = {
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  gamepad: '<path d="M6 8h12a4 4 0 0 1 4 4v1.5a3.5 3.5 0 0 1-6.3 2.1L14.5 14h-5l-1.2 1.6A3.5 3.5 0 0 1 2 13.5V12a4 4 0 0 1 4-4z"/><path d="M7 11v3M5.5 12.5h3"/><circle cx="16" cy="11.5" r=".6" fill="currentColor"/><circle cx="18" cy="13.2" r=".6" fill="currentColor"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  palette: '<path d="M12 21a9 9 0 1 1 9-9c0 2.5-2 3.5-3.5 3.5H15a2 2 0 0 0-1.4 3.4A1.3 1.3 0 0 1 12 21z"/><circle cx="7.5" cy="11" r="1" fill="currentColor"/><circle cx="11" cy="7" r="1" fill="currentColor"/><circle cx="16" cy="8.5" r="1" fill="currentColor"/>',
  rocket: '<path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.1 2.1 0 0 0-2.9-.1z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"/>',
  android: '<path d="M5 16.5a7 7 0 0 1 14 0z"/><path d="M8 7.5 6.5 5"/><path d="M16 7.5 17.5 5"/><circle cx="9.5" cy="13" r=".6" fill="currentColor"/><circle cx="14.5" cy="13" r=".6" fill="currentColor"/>',
  ios: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  googleplay: '<path d="M5.5 3.8v16.4a.8.8 0 0 0 1.2.7l13.6-8.2a.8.8 0 0 0 0-1.4L6.7 3.1a.8.8 0 0 0-1.2.7z"/><path d="M5.8 3.5 15 12.4 5.8 20.6"/>',
  appstore: '<path d="M9.5 4.5 16.8 17"/><path d="M14.5 4.5 7.2 17"/><path d="M5 13.5h9.5"/><path d="M16.5 13.5H19"/>',
  steam: '<circle cx="12" cy="12" r="9.5"/><circle cx="15.2" cy="9.4" r="2.6"/><circle cx="8.6" cy="15.4" r="1.9"/><path d="M13.3 11.2 10.2 14"/><path d="M2.8 13.3 7 15"/>',
  web: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19"/><path d="M12 2.5c2.6 2.7 3.9 5.9 3.9 9.5s-1.3 6.8-3.9 9.5c-2.6-2.7-3.9-5.9-3.9-9.5S9.4 5.2 12 2.5z"/>',
  itch: '<path d="M3.5 9 5 4.5h14L20.5 9"/><path d="M3.5 9c0 1.5 1.1 2.5 2.4 2.5S8.3 10.5 8.3 9c0 1.5 1.1 2.5 2.4 2.5h2.6c1.3 0 2.4-1 2.4-2.5 0 1.5 1.1 2.5 2.4 2.5s2.4-1 2.4-2.5"/><path d="M5 11.4v6.6c0 1 .8 1.5 1.6 1.5h10.8c.8 0 1.6-.5 1.6-1.5v-6.6"/><path d="M10 15.5h4"/>',
  x: '<path d="M4 4l16 16"/><path d="M20 4l-6.6 7.1M10.6 12.9 4 20"/>',
  instagram: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r=".7" fill="currentColor"/>',
  youtube: '<rect x="2.5" y="5.5" width="19" height="13" rx="4"/><path d="m10 9.2 5 2.8-5 2.8z" fill="currentColor"/>',
  discord: '<path d="M7.5 6.5c1.4-.6 2.9-1 4.5-1s3.1.4 4.5 1c1.9 2.6 2.9 5.5 3 8.7-1.4 1.2-3 2-4.6 2.4l-1-1.7M7.5 6.5c-1.9 2.6-2.9 5.5-3 8.7 1.4 1.2 3 2 4.6 2.4l1-1.7"/><path d="M8.2 15.1c2.4 1 5.2 1 7.6 0"/><circle cx="9.5" cy="12" r="1.1" fill="currentColor"/><circle cx="14.5" cy="12" r="1.1" fill="currentColor"/>',
  github: '<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
  linkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10.5V16"/><circle cx="8" cy="7.6" r=".6" fill="currentColor"/><path d="M12 16v-5.5M12 13c0-1.7 1-2.6 2.3-2.6s2 .9 2 2.6v3"/>',
  facebook: '<path d="M14 21v-7.5h2.6l.4-3H14V8.6c0-.9.3-1.5 1.5-1.5H17V4.4a20 20 0 0 0-2.3-.1c-2.3 0-3.8 1.4-3.8 3.9v2.3H8.3v3h2.6V21"/>',
  whatsapp: '<path d="M3.5 20.5 5 16.3A8.5 8.5 0 1 1 8 19.2z"/><path d="M9 8.5c0 3.6 2.9 6.5 6.5 6.5l1-1.5-2-1-1 1a4.5 4.5 0 0 1-2.5-2.5l1-1-1-2z"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m3.8 7 8.2 6 8.2-6"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  down: '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  back: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke-linejoin="round"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 19.5h14"/>',
  news: '<rect x="3" y="4" width="15" height="16" rx="2"/><path d="M18 8h2a1 1 0 0 1 1 1v9a2 2 0 0 1-2 2H5"/><path d="M7 8h7M7 12h7M7 16h4"/>'
};
export function icon(name, cls = "") {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.link}</svg>`;
}
export const SPARKLE = '<path fill="currentColor" d="M12 0l2.6 9.4L24 12l-9.4 2.6L12 24l-2.6-9.4L0 12l9.4-2.6z"/>';

/* ---------- store badges (black, official-style, pure SVG/CSS — no hotlinked images) ---------- */
const BADGE_LOGOS = {
  android: '<svg class="sb__logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#00D7FE" d="M4.2 2.3 13.4 12l-9.2 9.7c-.4-.2-.7-.7-.7-1.3V3.6c0-.6.3-1.1.7-1.3z"/><path fill="#00F076" d="M4.2 2.3c.3-.2.8-.2 1.3.1l10.9 6.2-3 3.4z"/><path fill="#FF3A44" d="M4.2 21.7c.3.2.8.2 1.3-.1l10.9-6.2-3-3.4z"/><path fill="#FFD400" d="m16.4 8.6 3.4 1.9c1.1.6 1.1 2.4 0 3l-3.4 1.9-3-3.4z"/></svg>',
  ios: '<svg class="sb__logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#fff" d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9-.7 0-1.9-.8-3.1-.8-1.6 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.3-2.6 1.3-2.6s-2.4-1-2.4-3.8zM14.1 5.8c.6-.8 1.1-1.9 1-3-.9 0-2.1.6-2.7 1.4-.6.7-1.1 1.8-1 2.9 1 .1 2.1-.5 2.7-1.3z"/></svg>',
  steam: '<svg class="sb__logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><circle cx="15.2" cy="9.4" r="2.6"/><circle cx="8.6" cy="15.4" r="1.9"/><path d="M13.3 11.2 10.2 14M2.8 13.3 7 15"/></svg>',
  itch: '<svg class="sb__logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="#FA5C5C" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS.itch + "</svg>"
};
export const STORES = {
  android: { name: "Google Play", pre: "Get it on", platform: "Android" },
  ios: { name: "App Store", pre: "Download on the", platform: "iOS" },
  steam: { name: "Steam", pre: "Get it on", platform: "Steam" },
  itch: { name: "itch.io", pre: "Available on", platform: "itch.io" }
};
export const PLATFORM_LABELS = { android: "Android", ios: "iOS", steam: "Steam", itch: "itch.io", web: "Web" };
const PLATFORM_ICONS = { android: "googleplay", ios: "appstore", steam: "steam", itch: "itch", web: "web" };

export const STATUS = { "coming-soon": "Coming soon", "in-development": "In development", released: "Out now" };
export function statusBadge(status) {
  const key = STATUS[status] ? status : "coming-soon";
  return `<span class="badge badge--${key}"><span class="badge__dot" aria-hidden="true"></span>${STATUS[key]}</span>`;
}

/** Which store badges to show, and in what state.
 *  released → only stores with a link (live). Not released → stores listed in
 *  `platforms` (or with a link) in a "coming soon" state. */
export function storeEntries(game) {
  const links = game.links || {};
  const released = game.status === "released";
  return Object.keys(STORES).map((key) => {
    const url = links[key];
    if (released) return hasUrl(url) ? { key, url, live: true } : null;
    const listed = asList(game.platforms).includes(key) || hasUrl(url);
    return listed ? { key, url: "", live: false } : null;
  }).filter(Boolean);
}

export function storeBadges(game, { small = false } = {}) {
  return storeEntries(game).map(({ key, url, live }) => {
    const s = STORES[key];
    const cls = `sb sb--${key}${small ? " sb--sm" : ""}${live ? "" : " sb--soon"}`;
    const inner = BADGE_LOGOS[key] + `<span class="sb__text"><small>${live ? s.pre : "Coming soon to"} </small><span>${s.name}</span></span>` +
      (small && live ? `<span class="sr-only"> — ${esc(game.title)}</span>` : "");
    if (!live) return `<span class="${cls}" role="img" aria-label="${s.name}: coming soon">${inner}</span>`;
    const ext = isRealUrl(url) ? ' target="_blank" rel="noopener"' : "";
    return `<a class="${cls}" href="${esc(url)}"${ext} data-track="store_click" data-platform="${key}" data-game="${esc(game.id)}">${inner}</a>`;
  }).join("");
}

export function playButton(game, { small = false } = {}) {
  if (!game.webPlay || !game.webPlay.enabled) return "";
  return `<a class="play-btn${small ? " play-btn--sm" : ""}" href="${playPath(game)}" data-track="play_click" data-game="${esc(game.id)}"${small ? ` aria-label="Play ${esc(game.title)} in your browser"` : ""}>` +
    `<span class="play-btn__icon">${icon("play")}</span><span class="play-btn__text">${small ? "Play" : "<small>Free demo</small>Play in browser"}</span></a>`;
}

export function platformChips(game) {
  return asList(game.platforms).filter((p) => PLATFORM_LABELS[p])
    .map((p) => `<li class="chip chip--platform">${icon(PLATFORM_ICONS[p])}<span>${PLATFORM_LABELS[p]}</span></li>`).join("");
}
export function genreChips(game) {
  return asList(game.genres).map((t) => `<li class="chip">${esc(t)}</li>`).join("");
}

/* ---------- covers ---------- */
const FALLBACK_COLORS = [["#6C4BFF", "#FF5E6E"], ["#1FB8A6", "#FFE07A"], ["#FF9A3C", "#B44CFF"], ["#3A7BFF", "#FF9A3C"], ["#FF5E6E", "#FFE07A"]];
function markSvg(uid) {
  return `<svg class="cover__mark" viewBox="90 90 360 330" aria-hidden="true" focusable="false"><defs>` +
    `<linearGradient id="h-${uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFE07A"/><stop offset="1" stop-color="#FF9A3C"/></linearGradient>` +
    `<linearGradient id="t-${uid}" x1="385" y1="150" x2="110" y2="400" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FFF8EC" stop-opacity=".9"/><stop offset="1" stop-color="#FFF8EC" stop-opacity="0"/></linearGradient></defs>` +
    `<path d="M286 120 C220 190 160 290 112 404 C210 350 300 290 392 226 Z" fill="url(#t-${uid})"/><circle cx="340" cy="172" r="76" fill="url(#h-${uid})"/>` +
    `<circle cx="312" cy="168" r="10" fill="#17183F"/><circle cx="360" cy="150" r="10" fill="#17183F"/><path d="M318 200 Q342 214 366 190" stroke="#17183F" stroke-width="9" stroke-linecap="round" fill="none"/></svg>`;
}
/** Real cover image if provided, otherwise a generated gradient + comet. `label` = text drawn on placeholder. */
export function cover({ id, title, image, colors, label, eager = false, cls = "", uid }) {
  const klass = `cover ${cls}`.trim();
  if (image) {
    return `<div class="${klass}"><img src="${esc(image)}" alt="${esc(title)} cover art" width="1600" height="900"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"></div>`;
  }
  const h = hash(String(id || title || "x"));
  const c = Array.isArray(colors) && colors.length >= 2 ? colors : FALLBACK_COLORS[h % FALLBACK_COLORS.length];
  const style = `--c1:${esc(c[0])};--c2:${esc(c[1])};--angle:${110 + (h % 70)}deg`;
  return `<div class="${klass} cover--placeholder" style="${style}" role="img" aria-label="${esc(title)} — artwork coming soon">` +
    `<span class="cover__stars" aria-hidden="true"></span>${markSvg(esc(uid || id || h))}` +
    (label === false ? "" : `<span class="cover__title" aria-hidden="true">${esc(label || title)}</span>`) + `</div>`;
}
export const gameCover = (g, opts = {}) => cover({ id: g.id, title: g.title, image: g.cover, colors: g.colors, ...opts });

/* ---------- game card ---------- */
export function gameCard(g, i = 0) {
  const date = g.releaseDate ? `<span class="card__date">${g.status === "released" ? "Released" : "Planned"} ${esc(formatDate(g.releaseDate))}</span>` : "";
  const actions = (g.status === "released" ? storeBadges(g, { small: true }) : "") + playButton(g, { small: true });
  const genres = genreChips(g);
  return `<li class="card reveal" style="--delay:${(i % 3) * 80}ms">` +
    `<a class="card__link" href="${gamePath(g)}">` +
      gameCover(g, { cls: "card__cover", uid: "card-" + g.id, label: false }) +
      `<div class="card__top">${statusBadge(g.status)}${g.placeholder ? '<span class="sample-tag" title="Placeholder entry — edit content/games.json">Sample</span>' : ""}</div>` +
      `<div class="card__body">` +
        `<p class="card__kind">${esc(g.kind || "Game")}</p>` +
        `<h3 class="card__title">${esc(g.title)}</h3>` +
        `<p class="card__tagline">${esc(g.tagline || "")}</p>` +
        `<ul class="chips" aria-label="Platforms">${platformChips(g)}</ul>` +
        (genres ? `<ul class="chips chips--genre" aria-label="Genres">${genres}</ul>` : "") +
        `<div class="card__meta">${date}<span class="card__more">Details ${icon("arrow")}</span></div>` +
      `</div>` +
    `</a>` +
    (actions ? `<div class="card__actions">${actions}</div>` : "") +
  `</li>`;
}

/* ---------- socials & people ---------- */
const socialIconKey = (id = "", label = "") => {
  const s = (id + " " + label).toLowerCase();
  for (const k of ["github", "linkedin", "instagram", "youtube", "discord", "steam", "itch", "facebook", "whatsapp"]) if (s.includes(k)) return k;
  if (s.includes("google")) return "googleplay";
  if (s.includes("app store") || s.includes("appstore")) return "appstore";
  if (/\bx\b|twitter/.test(s)) return "x";
  return "link";
};
/** Social links: url "" → hidden, "#" → dimmed "soon", real URL → live link. */
export function socialList(items, { compact = false } = {}) {
  return asList(items).filter((s) => s && hasUrl(s.url)).map((s) => {
    const ic = icon(socialIconKey(s.id, s.label));
    if (!isRealUrl(s.url)) {
      return `<li><span class="social social--soon" title="${esc(s.label)} — coming soon">${ic}${compact ? `<span class="sr-only">${esc(s.label)} (coming soon)</span>` : `<span>${esc(s.label)}</span><em>soon</em>`}</span></li>`;
    }
    return `<li><a class="social" href="${esc(s.url)}" target="_blank" rel="noopener me">${ic}${compact ? `<span class="sr-only">${esc(s.label)}</span>` : `<span>${esc(s.label)}</span>`}</a></li>`;
  }).join("");
}

export function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join("");
}
export function avatar(person, cls = "") {
  if (person.photo) return `<img class="avatar ${cls}" src="${esc(person.photo)}" alt="Photo of ${esc(person.name)}" width="400" height="400" loading="lazy" decoding="async">`;
  return `<span class="avatar avatar--initial ${cls}" aria-hidden="true"><span>${esc(person.placeholder ? "?" : initials(person.name))}</span></span>`;
}

/* ---------- news ---------- */
export function newsCover(post, opts = {}) {
  return cover({ id: post.slug, title: post.title, image: post.cover, colors: post.colors, label: false, uid: "n-" + post.slug + (opts.uidSuffix || ""), ...opts });
}
export function newsCard(post, { headingLevel = 3, i = 0 } = {}) {
  const h = `h${headingLevel}`;
  return `<li class="news-card reveal" data-category="${esc(post.category)}" style="--delay:${(i % 3) * 80}ms">` +
    `<a class="news-card__link" href="${newsPath(post)}">` +
      newsCover(post, { cls: "news-card__cover" }) +
      `<div class="news-card__body">` +
        `<p class="news-meta"><span class="cat cat--${esc(String(post.category).toLowerCase())}">${esc(post.category)}</span><time datetime="${esc(post.date)}">${esc(formatDate(post.date))}</time></p>` +
        `<${h} class="news-card__title">${esc(post.title)}</${h}>` +
        `<p class="news-card__excerpt">${esc(post.excerpt)}</p>` +
      `</div>` +
    `</a></li>`;
}
export { youtubeId };

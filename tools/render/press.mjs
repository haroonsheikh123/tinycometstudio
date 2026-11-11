/* Press kit page. Pure: (data) → HTML string. */
import { renderLayout, sectionHead } from "./layout.mjs";
import { esc, icon, absUrl, gamePath, formatDate, paragraphs, STATUS, PLATFORM_LABELS, asList, avatar } from "./components.mjs";

export const BRAND_COLORS = [
  { name: "Navy", hex: "#17183F" },
  { name: "Yellow", hex: "#FFE07A" },
  { name: "Orange", hex: "#FF9A3C" },
  { name: "Coral", hex: "#FF5E6E" },
  { name: "Cream", hex: "#FFF8EC" }
];
export const BRAND_FILES = [
  { name: "App icon", preview: "/assets/press/icon.svg", files: [["SVG", "/assets/press/icon.svg"], ["PNG", "/assets/press/icon.png"]], bg: "dark" },
  { name: "Logo — light backgrounds", preview: "/assets/press/logo-light.svg", files: [["SVG", "/assets/press/logo-light.svg"], ["PNG", "/assets/press/logo-light.png"]], bg: "light" },
  { name: "Logo — dark backgrounds", preview: "/assets/press/logo-dark.svg", files: [["SVG", "/assets/press/logo-dark.svg"], ["PNG", "/assets/press/logo-dark.png"]], bg: "dark" },
  { name: "Comet mark", preview: "/assets/press/mark.svg", files: [["SVG", "/assets/press/mark.svg"], ["PNG", "/assets/press/mark.png"]], bg: "dark" }
];
export const BRAND_ZIP = "/assets/press/tiny-comet-brand-kit.zip";

export function renderPressPage({ settings: s, games, team, version }) {
  const press = s.press || {};
  const founder = team.find((m) => m.featured);
  const facts = asList(press.facts).map((f) => `<div><dt>${esc(f.label)}</dt><dd>${f.placeholder ? `<mark class="ph">${esc(f.value)}</mark>` : esc(f.value)}</dd></div>`).join("");

  const main = `
<section class="section section--first">
  <div class="wrap">
    ${sectionHead({ eyebrow: "Press kit", title: `${s.studioName} press kit`, level: 1, text: "Everything you need to write about us: facts, logos, colours and contacts. Use freely in coverage of our games and apps." })}
    <div class="press-grid">
      <section class="panel" aria-labelledby="facts-h">
        <h2 id="facts-h">Fact sheet</h2>
        <dl class="facts facts--2">${facts}</dl>
      </section>
      <section class="panel" aria-labelledby="about-h">
        <h2 id="about-h">About the studio</h2>
        <div class="prose"><p>${esc(press.boilerplate || s.description)}</p></div>
        <h3 class="panel__sub">Press contact</h3>
        <a class="email-link email-link--sm" href="mailto:${esc(s.pressEmail || s.contactEmail)}">${icon("mail")}<span>${esc(s.pressEmail || s.contactEmail)}</span></a>
      </section>
    </div>

    <section class="press-block" aria-labelledby="logos-h">
      <div class="press-block__head">
        <h2 id="logos-h">Logos &amp; artwork</h2>
        <a class="btn btn--primary btn--sm" href="${BRAND_ZIP}" download>${icon("download")} Download brand kit (.zip)</a>
      </div>
      <ul class="logo-grid">
        ${BRAND_FILES.map((b) => `<li class="logo-tile">
          <div class="logo-tile__preview logo-tile__preview--${b.bg}"><img src="${b.preview}" alt="${esc(b.name)}" width="320" height="160" loading="lazy" decoding="async"></div>
          <div class="logo-tile__body"><h3>${esc(b.name)}</h3><p>${b.files.map(([t, href]) => `<a href="${href}" download>${icon("download")}${t}</a>`).join("")}</p></div>
        </li>`).join("")}
      </ul>
      <p class="press-note">Please don't stretch, recolour or add effects to the logo. Give it some breathing room — at least the height of the comet's head on every side.</p>
    </section>

    <section class="press-block" aria-labelledby="colors-h">
      <h2 id="colors-h">Brand colours &amp; type</h2>
      <ul class="swatches">${BRAND_COLORS.map((c) => `<li class="swatch"><span class="swatch__chip" style="background:${c.hex}"></span><strong>${c.name}</strong><code>${c.hex}</code></li>`).join("")}</ul>
      <p class="press-note">Headings: <strong>Fredoka</strong> (Bold / SemiBold). Body: <strong>Nunito</strong>. Both are free under the SIL Open Font License.</p>
    </section>

    ${founder ? `<section class="press-block" aria-labelledby="founder-h">
      <h2 id="founder-h">Founder</h2>
      <div class="press-founder">${avatar(founder, "avatar--md")}<div><h3>${esc(founder.name)}</h3><p class="founder__role">${esc(founder.role || "")}</p><div class="prose">${paragraphs(founder.bio)}</div></div></div>
    </section>` : ""}

    <section class="press-block" aria-labelledby="games-h">
      <h2 id="games-h">Games &amp; apps</h2>
      <ul class="press-games">
        ${games.map((g) => `<li class="press-game" id="game-${esc(g.id)}">
          <div><h3>${esc(g.title)}${g.placeholder ? ' <span class="sample-tag">Sample</span>' : ""}</h3><p>${esc(g.tagline || "")}</p></div>
          <dl class="facts facts--inline">
            <div><dt>Status</dt><dd>${esc(STATUS[g.status] || "")}</dd></div>
            <div><dt>Platforms</dt><dd>${esc(asList(g.platforms).map((p) => PLATFORM_LABELS[p] || p).join(", ") || "TBA")}</dd></div>
            <div><dt>Release</dt><dd>${esc(formatDate(g.releaseDate) || "TBA")}</dd></div>
          </dl>
          <p class="press-game__links"><a href="${gamePath(g)}">Game page ${icon("arrow")}</a>${g.cover ? `<a href="${esc(g.cover)}" download>Cover art ${icon("download")}</a>` : ""}${g.pressKitUrl ? `<a href="${esc(g.pressKitUrl)}">Full press kit ${icon("arrow")}</a>` : ""}</p>
        </li>`).join("")}
      </ul>
    </section>
  </div>
</section>`;

  return renderLayout({
    settings: s, version, active: "press",
    title: `Press kit · ${s.studioName}`,
    description: `Press kit for ${s.studioName}: fact sheet, logos, brand colours, founder bio and contacts.`,
    path: "/press/",
    main,
    jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: `${s.studioName} press kit`, url: absUrl(s, "/press/") }
  });
}

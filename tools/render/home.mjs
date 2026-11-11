/* Home page renderer. Pure: (data) → HTML string. */
import { renderLayout, sectionHead } from "./layout.mjs";
import { esc, icon, SPARKLE, gameCard, socialList, avatar, paragraphs, newsCard, absUrl } from "./components.mjs";

function personLinks(links) {
  return socialList((links || []).map((l) => ({ id: l.label, label: l.label, url: l.url })));
}

export function renderFounder(p) {
  if (!p) return "";
  return `<article class="founder reveal" aria-labelledby="founder-name">
      <div class="founder__photo">${avatar(p, "avatar--xl")}<span class="founder__orbit" aria-hidden="true"></span></div>
      <div class="founder__text">
        <p class="eyebrow">Meet the founder</p>
        <h3 class="founder__name" id="founder-name">${esc(p.name)}</h3>
        <p class="founder__role">${esc(p.role || "")}</p>
        <div class="prose">${paragraphs(p.bio)}</div>
        <ul class="socials socials--small">${personLinks(p.links)}</ul>
      </div>
    </article>`;
}

export function renderTeamGrid(members) {
  if (!members.length) return "";
  return `<div class="team">
      <h3>The crew</h3>
      <p>The people helping our comets fly.</p>
      <ul class="team-grid">${members.map((m, i) => `<li class="member reveal" style="--delay:${(i % 3) * 80}ms">${avatar(m)}<div class="member__text">` +
        `<h4 class="member__name">${esc(m.name)}${m.placeholder ? ' <span class="sample-tag">Placeholder</span>' : ""}</h4>` +
        `<p class="member__role">${esc(m.role || "")}</p>` +
        (m.bio ? `<div class="member__bio">${paragraphs(m.bio)}</div>` : "") +
        (m.links && m.links.length ? `<ul class="socials socials--small">${personLinks(m.links)}</ul>` : "") +
        `</div></li>`).join("")}</ul>
    </div>`;
}

/**
 * @param {{settings:object, games:object[], team:object[], news:object[], version?:string}} d
 */
export function renderHomePage({ settings: s, games, team, news, version }) {
  const hero = s.hero || {};
  const about = s.about || {};
  const founder = team.find((m) => m.featured) || null;
  const members = team.filter((m) => m !== founder);
  const latest = news.slice(0, 3);

  const main = `
<section class="hero" aria-labelledby="hero-title">
  <div class="wrap hero-inner">
    <div class="hero-copy">
      <p class="eyebrow">${esc(hero.eyebrow || "")}</p>
      <h1 id="hero-title">${esc(hero.titleLine1 || "Small studio.")}<br><span class="grad-text">${esc(hero.titleLine2 || "Big little worlds.")}</span></h1>
      <p class="hero-lead">${esc(hero.lead || s.description)}</p>
      <div class="hero-ctas">
        <a class="btn btn--primary" href="#games">See our games ${icon("down")}</a>
        <a class="btn btn--ghost" href="#follow">Follow along</a>
      </div>
    </div>
    <div class="hero-art" aria-hidden="true">
      <span class="orbit"></span>
      <img class="float" src="/assets/mark.svg" alt="" width="512" height="512" fetchpriority="high">
      <svg class="sparkle sparkle--1" viewBox="0 0 24 24">${SPARKLE}</svg>
      <svg class="sparkle sparkle--2" viewBox="0 0 24 24">${SPARKLE}</svg>
      <svg class="sparkle sparkle--3" viewBox="0 0 24 24">${SPARKLE}</svg>
    </div>
  </div>
</section>

<section class="section section--tight" id="games" aria-labelledby="games-title">
  <div class="wrap">
    ${sectionHead({ eyebrow: "Games & apps", title: "Things we're making", id: "games-title", text: "A peek at what's launched, what's in the oven, and what's still a twinkle in our eye." })}
    ${games.length ? `<ul class="games-grid">${games.map(gameCard).join("")}</ul>` : `<p class="empty">Our first game is warming up on the launch pad. Check back soon!</p>`}
  </div>
</section>

<section class="section" id="expertise" aria-labelledby="expertise-title">
  <div class="wrap">
    ${sectionHead({ eyebrow: "What we do", title: "From first sketch to the store", id: "expertise-title", text: "We handle the whole journey ourselves — designing, building, shipping and looking after our games and apps." })}
    <ul class="skills">
      ${(s.expertise || []).map((x, i) => `<li class="skill reveal" style="--delay:${i * 60}ms"><span class="skill__icon">${icon(x.icon)}</span><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p></li>`).join("\n      ")}
    </ul>
  </div>
</section>

${latest.length ? `<section class="section section--tight" id="news" aria-labelledby="news-title">
  <div class="wrap">
    <div class="section-head section-head--row">
      <div><p class="eyebrow">Latest news</p><h2 id="news-title">Fresh from the launch pad</h2></div>
      <a class="btn btn--ghost btn--sm" href="/news/">All news ${icon("arrow")}</a>
    </div>
    <ul class="news-grid">${latest.map((p, i) => newsCard(p, { i })).join("")}</ul>
  </div>
</section>` : ""}

<section class="section" id="about" aria-labelledby="about-title">
  <div class="wrap">
    <div class="about-story">
      ${sectionHead({ eyebrow: "About us", title: about.title || "About", id: "about-title" })}
      <div class="prose">
        ${about.lead ? `<p class="lead-big">${esc(about.lead)}</p>` : ""}
        ${paragraphs(about.paragraphs)}
      </div>
    </div>
    ${renderFounder(founder)}
    ${renderTeamGrid(members)}
  </div>
</section>

<section class="section section--tight" id="follow" aria-labelledby="follow-title">
  <div class="wrap">
    <div class="follow-card">
      <img src="/assets/mark.svg" alt="" width="96" height="96" loading="lazy" decoding="async">
      ${sectionHead({ title: "Follow the comet", id: "follow-title", center: true, text: "Dev updates, sneak peeks and launch news — wherever you like to hang out." })}
      <ul class="socials">${socialList(s.socials)}</ul>
      <p class="follow-note">Prefer a feed? Grab our <a href="/news/feed.xml">RSS feed</a>. A newsletter is on the way.</p>
    </div>
  </div>
</section>

<section class="section" id="contact" aria-labelledby="contact-title">
  <div class="wrap contact-grid">
    <div>
      ${sectionHead({ eyebrow: "Contact", title: "Say hello", id: "contact-title", text: "Questions, feedback, press, collaborations, or just a nice word — we'd love to hear from you." })}
      <a class="email-link" href="mailto:${esc(s.contactEmail)}">${icon("mail")}<span>${esc(s.contactEmail)}</span></a>
      <p class="contact-press">Press &amp; media: see our <a href="/press/">press kit</a>.</p>
    </div>
    <form class="contact-form" id="contact-form" data-email="${esc(s.contactEmail)}" novalidate>
      <div class="field-row">
        <div class="field"><label for="cf-name">Your name</label><input id="cf-name" name="name" type="text" autocomplete="name" placeholder="Ayesha"></div>
        <div class="field"><label for="cf-topic">Topic</label>
          <select id="cf-topic" name="topic"><option>General</option><option>Game feedback</option><option>Bug report</option><option>Press</option><option>Business</option></select>
        </div>
      </div>
      <div class="field"><label for="cf-message">Message</label><textarea id="cf-message" name="message" required placeholder="Hi Tiny Comet! …"></textarea></div>
      <button class="btn btn--primary" type="submit">Send message</button>
      <p class="form-hint">This opens your own email app with the message ready to go — nothing is stored on this website.</p>
      <p class="form-status" id="form-status" role="status" aria-live="polite"></p>
    </form>
  </div>
</section>`;

  return renderLayout({
    settings: s, version,
    title: `${s.studioName} · ${s.tagline}`,
    description: s.description,
    path: "/",
    main,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: s.studioName,
      url: absUrl(s, "/"),
      logo: absUrl(s, "/assets/icon.png"),
      email: s.contactEmail,
      founder: founder ? { "@type": "Person", name: founder.name, jobTitle: founder.role } : undefined,
      address: { "@type": "PostalAddress", addressCountry: "PK" },
      sameAs: (s.socials || []).map((x) => x.url).filter((u) => /^https?:/.test(u || ""))
    }
  });
}

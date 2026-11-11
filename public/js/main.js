/* Tiny Comet Studio — site script (ES module, no dependencies).
   Pages are pre-rendered by tools/build.mjs; this only adds small enhancements. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- analytics hook: no-op unless <meta name="tc-analytics"> is set ---------- */
const endpoint = $('meta[name="tc-analytics"]')?.content;
const optedOut = navigator.doNotTrack === "1" || navigator.globalPrivacyControl === true;
export function track(event, props = {}) {
  if (!endpoint || optedOut) return;
  const body = JSON.stringify({ event, props, path: location.pathname, ref: document.referrer || undefined, ts: Date.now() });
  try { navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" })); } catch { /* ignore */ }
}
window.tcTrack = track;
track("page_view");
const news = $("[data-news]");
if (news) track("news_read", { slug: news.dataset.news });
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-track]");
  if (el) track(el.dataset.track, { game: el.dataset.game, platform: el.dataset.platform, network: el.dataset.network });
});

/* ---------- start decorative looping animations on first interaction (see css "decorative motion") ---------- */
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const events = ["pointermove", "pointerdown", "scroll", "wheel", "keydown", "touchstart"];
  const start = () => { document.documentElement.classList.add("motion"); events.forEach((e) => removeEventListener(e, start)); };
  events.forEach((e) => addEventListener(e, start, { passive: true }));
}

/* ---------- nav ---------- */
const toggle = $(".nav-toggle");
const menu = $("#site-menu");
if (toggle && menu) {
  const setOpen = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    document.body.classList.toggle("menu-open", open);
  };
  toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
  $$("a", menu).forEach((a) => a.addEventListener("click", () => setOpen(false)));
  addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("menu-open")) { setOpen(false); toggle.focus(); } });
  matchMedia("(min-width: 761px)").addEventListener("change", (m) => m.matches && setOpen(false));
}
const header = $(".site-header");
const onScroll = () => header?.classList.toggle("is-scrolled", scrollY > 8);
onScroll();
addEventListener("scroll", onScroll, { passive: true });

/* ---------- screenshot lightbox ---------- */
const dialog = $("#lightbox");
const shots = $$("[data-lightbox]");
if (dialog && shots.length && dialog.showModal) {
  const img = $("img", dialog);
  let cur = 0;
  const show = (i) => { cur = (i + shots.length) % shots.length; const im = $("img", shots[cur]); img.src = shots[cur].href; img.alt = im?.alt || ""; };
  shots.forEach((a, i) => a.addEventListener("click", (e) => { e.preventDefault(); show(i); dialog.showModal(); }));
  $(".lightbox__close", dialog).addEventListener("click", () => dialog.close());
  $(".lightbox__prev", dialog).addEventListener("click", () => show(cur - 1));
  $(".lightbox__next", dialog).addEventListener("click", () => show(cur + 1));
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") show(cur - 1); if (e.key === "ArrowRight") show(cur + 1); });
  if (shots.length < 2) $$(".lightbox__prev, .lightbox__next", dialog).forEach((b) => (b.hidden = true));
}

/* ---------- lite YouTube: swap the thumbnail for the player on click ---------- */
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-yt]");
  if (!a) return;
  e.preventDefault();
  const f = document.createElement("iframe");
  f.src = `https://www.youtube-nocookie.com/embed/${a.dataset.yt}?autoplay=1`;
  f.title = a.textContent.trim() || "YouTube video";
  f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  f.allowFullscreen = true;
  a.replaceWith(f);
});

/* ---------- share: copy link ---------- */
$$("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
  const note = b.closest(".share")?.querySelector(".share__copied");
  try { await navigator.clipboard.writeText(b.dataset.copy); if (note) note.textContent = "Link copied!"; }
  catch { if (note) note.textContent = b.dataset.copy; }
  setTimeout(() => { if (note) note.textContent = ""; }, 2500);
}));

/* ---------- news: category filter + load more ---------- */
const list = $("[data-news-list]");
if (list) {
  const size = +list.dataset.pageSize || 9;
  const cards = $$(".news-card", list);
  const more = $("[data-load-more]", list);
  const empty = $(".news-list__empty", list);
  let filter = "all", shown = size;
  const apply = () => {
    const match = cards.filter((c) => filter === "all" || c.dataset.category === filter);
    cards.forEach((c) => (c.hidden = true));
    match.slice(0, shown).forEach((c) => (c.hidden = false));
    more.hidden = match.length <= shown;
    empty.hidden = match.length > 0;
  };
  $$("[data-filter]", list).forEach((b) => b.addEventListener("click", () => {
    filter = b.dataset.filter; shown = size;
    $$("[data-filter]", list).forEach((x) => { x.classList.toggle("is-active", x === b); x.setAttribute("aria-pressed", String(x === b)); });
    apply();
  }));
  more.addEventListener("click", () => { shown += size; apply(); });
  apply();
}

/* ---------- contact form → opens the visitor's email app ---------- */
const form = $("#contact-form");
form?.addEventListener("submit", (e) => {
  e.preventDefault();
  const email = form.dataset.email;
  const name = form.elements.name.value.trim();
  const message = form.elements.message.value.trim();
  const status = $("#form-status");
  if (!message) { status.textContent = "Please write a short message first."; form.elements.message.focus(); return; }
  const subject = `[${form.elements.topic.value}] Hello from ${name || "a visitor"}`;
  location.href = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message + "\n\n— " + name)}`;
  status.textContent = `Opening your email app… If nothing happens, write to us at ${email}.`;
  track("contact_open");
});

/* ---------- footer year ---------- */
$$("[data-year]").forEach((el) => (el.textContent = new Date().getFullYear()));

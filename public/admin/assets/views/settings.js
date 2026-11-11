import { h, api, pageHead, field, input, textarea, toast, errMsg, can, formData, reasonField, tabs, busy, toggle } from "../ui.js";
import { historyPanel, lines, paras, previewChanges } from "./_shared.js";

export default async function settings({ go }) {
  const r = await api("GET", "/settings");
  const s = r.data, secrets = r.meta.secrets, etag = `"v${r.meta.version}"`;
  const ro = !can("settings:update");
  const i = (name, v, a = {}) => input(name, v ?? "", { readOnly: ro, ...a });
  const f = h("form", { class: "stack", onsubmit: (e) => e.preventDefault() },
    h("div", { class: "card" }, h("h2", null, "Studio"), h("div", { class: "form form--2" },
      field("Studio name", i("studioName", s.studioName, { required: true })), field("Short name", i("shortName", s.shortName)),
      field("Tagline", i("tagline", s.tagline)), field("Country", i("country", s.country)),
      h("div", { class: "full" }, field("Site URL", i("siteUrl", s.siteUrl, { type: "url" }), "Canonical URL used in Open Graph, sitemap and RSS — no trailing slash")),
      h("div", { class: "full" }, field("Default meta description (SEO)", textarea("description", s.description, { rows: 2, readOnly: ro }))),
      field("Default share image (SEO)", i("seo_ogImage", s.seo?.ogImage, { placeholder: "/assets/icon.png" })), field("Keywords (SEO)", i("seo_keywords", s.seo?.keywords)))),
    h("div", { class: "card" }, h("h2", null, "Contact"), h("div", { class: "form form--2" }, field("Contact email", i("contactEmail", s.contactEmail, { type: "email" })), field("Press email", i("pressEmail", s.pressEmail, { type: "email" })))),
    h("div", { class: "card" }, h("h2", null, "Social links"), field("One per line: id | label | url", textarea("socials", (s.socials || []).map((x) => `${x.id} | ${x.label} | ${x.url}`).join("\n"), { rows: 8, class: "code", readOnly: ro }), "id = itch, steam, googleplay, appstore, x, instagram, youtube, discord, github, linkedin, facebook · url \"\" hides, \"#\" = coming soon")),
    h("div", { class: "card" }, h("h2", null, "Home page copy"), h("div", { class: "form form--2" },
      field("Hero eyebrow", i("hero_eyebrow", s.hero?.eyebrow)), field("Hero line 1", i("hero_titleLine1", s.hero?.titleLine1)), field("Hero line 2", i("hero_titleLine2", s.hero?.titleLine2)),
      h("div", { class: "full" }, field("Hero lead", textarea("hero_lead", s.hero?.lead, { rows: 3, readOnly: ro }))),
      h("div", { class: "full" }, field("About title", i("about_title", s.about?.title))), h("div", { class: "full" }, field("About lead", textarea("about_lead", s.about?.lead, { rows: 2, readOnly: ro }))),
      h("div", { class: "full" }, field("About paragraphs", textarea("about_paragraphs", (s.about?.paragraphs || []).join("\n\n"), { rows: 6, readOnly: ro }), "Blank line between paragraphs")))),
    h("div", { class: "card" }, h("h2", null, "Bot protection & analytics"), h("div", { class: "form form--2" },
      field("Turnstile site key (public)", i("turnstileSiteKey", s.turnstileSiteKey), "1x00000000000000000000AA is Cloudflare's always-pass TEST key — replace before launch"),
      h("div", { class: "field" }, h("span", null, "Turnstile secret"), h("p", null, secrets.TURNSTILE_SECRET ? h("span", { class: "badge badge--ok" }, "configured") : h("span", { class: "badge badge--bad" }, "not set"), h("span", { class: "small muted" }, " — a Cloudflare secret (TURNSTILE_SECRET); never shown here."))),
      field("Analytics endpoint", i("analyticsEndpoint", s.analyticsEndpoint), "/api/v1/collect = built-in cookie-free analytics · empty = off"))),
    ro ? null : h("div", { class: "card" }, reasonField()));
  const collect = () => {
    const d = formData(f);
    return { reason: d.reason, body: {
      studioName: d.studioName, shortName: d.shortName, tagline: d.tagline, country: d.country, siteUrl: d.siteUrl.replace(/\/+$/, ""), description: d.description,
      contactEmail: d.contactEmail, pressEmail: d.pressEmail, turnstileSiteKey: d.turnstileSiteKey.trim(), analyticsEndpoint: d.analyticsEndpoint.trim(),
      socials: lines(d.socials).map((l) => { const [id, label, url] = l.split("|").map((x) => x.trim()); return { id, label: label || id, url: url ?? "" }; }),
      hero: { eyebrow: d.hero_eyebrow, titleLine1: d.hero_titleLine1, titleLine2: d.hero_titleLine2, lead: d.hero_lead },
      about: { title: d.about_title, lead: d.about_lead, paragraphs: paras(d.about_paragraphs) },
      seo: { ...(s.seo || {}), ogImage: d.seo_ogImage, keywords: d.seo_keywords }
    } };
  };
  const save = async (btn) => { const { body, reason } = collect(); busy(btn, true); try { await api("PATCH", "/settings", { body, reason, ifMatch: etag }); toast("Settings saved — the site updates instantly", "ok"); go("/admin/settings", { replace: true }); } catch (e) { toast(errMsg(e), "bad"); busy(btn, false); } };
  const saveBtn = h("button", { class: "btn btn--primary", type: "button", onclick: (e) => save(e.currentTarget) }, "Save settings");
  const panel = h("div");
  const show = (t) => panel.replaceChildren(t === "history" ? historyPanel({ base: "/settings", perm: "settings:update", onRestored: () => go("/admin/settings", { replace: true }) }) : h("div", null, f, ro ? null : h("div", { class: "sticky-actions actions" }, saveBtn, h("button", { class: "btn", type: "button", onclick: async () => { const { body, reason } = collect(); if (await previewChanges("PATCH", "/settings", body, { reason, ifMatch: etag })) save(saveBtn); } }, "Preview changes"))));
  show("edit");
  const maint = can("system:manage") ? await maintenanceCard() : null;
  return h("div", null, pageHead("Site settings", `Version ${r.meta.version} · last changed by ${r.meta.updated_by || "—"}`), maint, tabs([["edit", "Settings"], ["history", "History"]], show, "edit"), panel);
}
async function maintenanceCard() {
  const st = (await api("GET", "/system")).data;
  const msg = input("message", st.maintenance.message || "", { placeholder: "We're polishing a few things — back very soon!" });
  const sw = toggle("maint", !!st.maintenance.enabled, "Maintenance mode — visitors see a friendly “back soon” page (you still see the site while signed in)", { onchange: async (e) => {
    try { await api("PUT", "/system/maintenance", { body: { enabled: e.target.checked, message: msg.value || undefined } }); toast(`Maintenance ${e.target.checked ? "ON" : "off"}`, "ok"); } catch (x) { e.target.checked = !e.target.checked; toast(errMsg(x), "bad"); }
  } }, true);
  return h("div", { class: "card", style: { marginBottom: "16px" } }, sw, h("div", { style: { marginTop: "10px" } }, field("Message", msg)));
}

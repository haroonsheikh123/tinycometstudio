import { h, api, pageHead, table, field, input, textarea, toast, errMsg, can, formData, reasonField, tabs, debounce, busy, icon } from "../ui.js";
import { historyPanel } from "./_shared.js";

export default async function pages({ param, go }) {
  if (param) return editor(param, go);
  const { data } = await api("GET", "/pages");
  return h("div", null, pageHead("Pages", "Markdown pages such as the privacy policy, served at /<slug>/.", can("pages:create") ? h("a", { class: "btn btn--accent", href: "/admin/pages/new" }, icon("plus"), "New page") : null),
    table([{ label: "Title", render: (p) => h("span", { class: "cell-title" }, p.title) }, { label: "URL", render: (p) => h("a", { href: p.url, target: "_blank", rel: "noopener" }, p.url) }, { label: "Version", render: (p) => `v${p._meta.version}`, hideSm: true }], data, { onRow: (p) => go(`/admin/pages/${p.slug}`) }));
}
async function editor(slug, go) {
  const isNew = slug === "new";
  const p = isNew ? { slug: "", title: "", source: "---\ntitle: \"New page\"\n---\n\nWrite here…\n" } : (await api("GET", `/pages/${slug}`)).data;
  const canEdit = can(isNew ? "pages:create" : "pages:update");
  const src = textarea("source", p.source, { class: "md", readOnly: !canEdit, "aria-label": "Markdown source" });
  const prev = h("div", { class: "preview" });
  const render = debounce(async () => { try { prev.innerHTML = (await api("POST", "/news/preview", { body: { body: src.value.replace(/^---\n[\s\S]*?\n---\n?/, "") } })).data.html; } catch { /* no news:read */ } }, 350);
  src.addEventListener("input", render); render();
  const f = h("form", { class: "form", onsubmit: (e) => e.preventDefault() }, isNew ? field("Slug", input("slug", "", { required: true, pattern: "[a-z0-9-]+" }), "Served at /<slug>/") : null,
    field("Title", input("title", p.title)), h("div", { class: "editor" }, src, prev), h("p", { class: "hint" }, "Front-matter (title, updated) + Markdown. {{contactEmail}} is replaced with the contact address."), canEdit ? reasonField() : null);
  const save = async (btn) => {
    const d = formData(f); busy(btn, true);
    try {
      if (isNew) { await api("POST", "/pages", { body: { slug: d.slug, title: d.title, source: src.value }, reason: d.reason }); go(`/admin/pages/${d.slug}`, { replace: true }); }
      else { await api("PATCH", `/pages/${slug}`, { body: { title: d.title, source: src.value }, reason: d.reason, ifMatch: `"v${p._meta.version}"` }); toast("Saved", "ok"); go(`/admin/pages/${slug}`, { replace: true }); }
    } catch (e) { toast(errMsg(e), "bad"); busy(btn, false); }
  };
  const panel = h("div");
  const show = (t) => panel.replaceChildren(t === "history" ? historyPanel({ base: `/pages/${slug}`, perm: "pages:update", onRestored: () => go(`/admin/pages/${slug}`, { replace: true }) }) : h("div", { class: "card" }, f, canEdit ? h("div", { class: "sticky-actions actions" }, h("button", { class: "btn btn--primary", type: "button", onclick: (e) => save(e.currentTarget) }, "Save"), h("a", { class: "btn btn--ghost", href: "/admin/pages" }, "Cancel")) : null));
  show("edit");
  return h("div", null, pageHead(isNew ? "New page" : p.title, isNew ? null : h("a", { href: p.url, target: "_blank", rel: "noopener" }, p.url)), isNew ? null : tabs([["edit", "Edit"], ["history", "History"]], show, "edit"), panel);
}

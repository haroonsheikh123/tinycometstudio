import { h, api, pageHead, table, statusBadge, field, input, textarea, select, checkbox, tabs, toast, errMsg, can, confirmDialog, icon, formData, reasonField, fmtDate, debounce, seg, busy, dialog } from "../ui.js";
import { historyPanel, previewChanges } from "./_shared.js";

const CATS = ["Announcement", "Devlog", "Release", "Update", "Press"];

export default async function news({ param, go, query }) {
  if (param) return editor(param, go);
  const status = query.get("status") || "";
  const { data } = await api("GET", "/news", { query: { status } });
  return h("div", null,
    pageHead("Newsroom", "Announcements, devlogs and release notes. Drafts are private; scheduled posts go live automatically.", can("news:create") ? h("a", { class: "btn btn--accent", href: "/admin/news/new" }, icon("plus"), "New post") : null),
    h("div", { class: "toolbar" }, seg([["", "All"], ["published", "Published"], ["scheduled", "Scheduled"], ["draft", "Drafts"]], status, (v) => go(`/admin/news${v ? `?status=${v}` : ""}`, { replace: true }))),
    table([
      { label: "Title", render: (p) => h("div", null, h("span", { class: "cell-title" }, p.title), p.placeholder ? h("span", { class: "badge", style: { marginLeft: "6px" } }, "sample") : null, h("span", { class: "sub" }, `/news/${p.slug}/`)) },
      { label: "Status", render: (p) => h("div", null, statusBadge(p.status), p.status === "scheduled" ? h("span", { class: "sub" }, fmtDate(p.publish_at)) : null) },
      { label: "Category", key: "category", hideSm: true },
      { label: "Date", render: (p) => p.date, hideSm: true },
      { label: "Game", render: (p) => p.game || "—", hideSm: true }
    ], data, { onRow: (p) => go(`/admin/news/${p.slug}`), empty: "No posts here yet." }));
}

async function editor(slug, go) {
  const isNew = slug === "new";
  const [postR, gamesR, teamR] = await Promise.all([isNew ? null : api("GET", `/news/${slug}`), can("games:read") ? api("GET", "/games") : { data: [] }, can("team:read") ? api("GET", "/team") : { data: [] }]);
  const p = isNew ? { title: "", slug: "", date: new Date().toISOString().slice(0, 10), category: "Update", game: "", author: teamR.data.find((m) => m.featured)?.id || "", excerpt: "", cover: "", body: "", status: "draft", placeholder: false } : postR.data;
  const etag = isNew ? null : `"v${p._meta.version}"`;
  const canEdit = isNew ? can("news:create") : can("news:update");
  const canPub = can("news:publish");
  const body = textarea("body", p.body, { class: "md", "aria-label": "Markdown", readOnly: !canEdit, spellcheck: true });
  const preview = h("div", { class: "preview prose", "aria-label": "Preview" });
  const ed = h("div", { class: "editor" }, body, preview);
  const render = debounce(async () => { try { const r = await api("POST", "/news/preview", { body: { body: body.value } }); preview.innerHTML = r.data.html; words.textContent = `${r.data.words} words · ${r.data.reading_minutes} min read`; } catch { /* ignore */ } }, 350);
  const words = h("span", { class: "small muted" });
  body.addEventListener("input", render);
  render();
  const f = h("form", { class: "form form--2", onsubmit: (e) => e.preventDefault() },
    h("div", { class: "full" }, field("Title", input("title", p.title, { required: true, maxlength: 200, readOnly: !canEdit }))),
    field("Slug", input("slug", p.slug, { pattern: "[a-z0-9-]*", readOnly: !isNew, placeholder: "from the title" }), isNew ? "URL: /news/<slug>/ — leave empty to generate" : `/news/${p.slug}/`),
    field("Date shown", input("date", p.date, { type: "date", readOnly: !canEdit })),
    field("Category", select("category", CATS.concat(CATS.includes(p.category) ? [] : [p.category]), p.category, { disabled: !canEdit })),
    field("Author", select("author", [["", "—"], ...teamR.data.map((m) => [m.id, m.name])], p.author, { disabled: !canEdit })),
    field("Related game", select("game", [["", "—"], ...gamesR.data.map((g) => [g.id, g.title])], p.game, { disabled: !canEdit }), "The post also appears on that game's page"),
    field("Cover image", input("cover", p.cover, { placeholder: "/media/… (2:1 works best)", readOnly: !canEdit })),
    h("div", { class: "full" }, field("Excerpt", textarea("excerpt", p.excerpt, { rows: 2, maxlength: 400, readOnly: !canEdit }), "Cards, search results and RSS. Empty = first sentences.")),
    h("div", { class: "full" }, h("div", { class: "row row--between" }, h("span", { class: "label" }, "Body (Markdown)"), words),
      h("div", { class: "editor-tabs seg", style: { margin: "6px 0" } }, h("button", { type: "button", "aria-pressed": "true", onclick: (e) => { ed.classList.remove("show-preview"); e.currentTarget.setAttribute("aria-pressed", "true"); e.currentTarget.nextSibling.setAttribute("aria-pressed", "false"); } }, "Write"), h("button", { type: "button", "aria-pressed": "false", onclick: (e) => { ed.classList.add("show-preview"); e.currentTarget.setAttribute("aria-pressed", "true"); e.currentTarget.previousSibling.setAttribute("aria-pressed", "false"); } }, "Preview")),
      ed, h("p", { class: "hint" }, "**bold**, *italic*, ## headings, - lists, > quotes, [links](https://…), ![alt](/media/… =1600x900 \"caption\"), ==highlight==, and {{youtube https://youtu.be/ID}} on its own line.")),
    h("div", { class: "full" }, checkbox("placeholder", p.placeholder, "Sample post (shows a 'Sample' tag)", { disabled: !canEdit })),
    canEdit ? h("div", { class: "full" }, reasonField()) : null);
  const collect = () => {
    const d = formData(f);
    const out = { title: d.title.trim(), date: d.date, category: d.category, author: d.author, game: d.game, cover: d.cover.trim(), excerpt: d.excerpt.trim(), body: body.value, placeholder: d.placeholder };
    if (isNew && d.slug.trim()) out.slug = d.slug.trim();
    return { body: out, reason: d.reason };
  };
  const saveDraft = async (btn) => {
    const { body: b, reason } = collect();
    busy(btn, true);
    try {
      if (isNew) { const r = await api("POST", "/news", { body: b, reason }); toast("Draft saved", "ok"); go(`/admin/news/${r.data.slug}`, { replace: true }); return r.data; }
      await api("PATCH", `/news/${slug}`, { body: b, reason, ifMatch: etag }); toast("Saved", "ok"); go(`/admin/news/${slug}`, { replace: true });
    } catch (e) { toast(e.status === 412 ? "Someone else edited this post — reload to see their version." : errMsg(e), "bad"); busy(btn, false); }
  };
  const publish = async (at) => {
    const { body: b, reason } = collect();
    try {
      let s = slug;
      if (isNew) s = (await api("POST", "/news", { body: b, reason })).data.slug;
      else await api("PATCH", `/news/${slug}`, { body: b, reason, ifMatch: etag });
      const r = await api("POST", `/news/${s}/publish`, { body: at ? { publish_at: at } : { keep_date: true }, reason });
      toast(r.data.status === "scheduled" ? `Scheduled for ${fmtDate(r.data.publish_at)}` : "Published — it's live!", "ok");
      go(`/admin/news/${s}`, { replace: true });
    } catch (e) { toast(errMsg(e), "bad"); }
  };
  const schedule = () => dialog((close) => {
    const dt = input("at", "", { type: "datetime-local", required: true });
    return h("form", { class: "stack", onsubmit: (e) => { e.preventDefault(); close(); publish(new Date(dt.value).toISOString()); } }, h("h2", null, "Schedule post"), field("Publish at (your local time)", dt), h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary" }, "Schedule")));
  });
  const draftBtn = h("button", { class: "btn", type: "button", onclick: (e) => saveDraft(e.currentTarget) }, isNew ? "Save draft" : "Save");
  const actions = canEdit ? h("div", { class: "sticky-actions actions" },
    canPub ? h("button", { class: "btn btn--primary", type: "button", onclick: () => publish(null) }, p.status === "published" ? "Save & keep live" : "Publish now") : null,
    draftBtn,
    canPub && p.status !== "published" ? h("button", { class: "btn", type: "button", onclick: schedule }, "Schedule…") : null,
    !isNew ? h("button", { class: "btn btn--ghost", type: "button", onclick: async () => { const { body: b, reason } = collect(); if (await previewChanges("PATCH", `/news/${slug}`, b, { reason, ifMatch: etag })) saveDraft(draftBtn); } }, icon("eye"), "Preview changes") : null,
    !isNew && canPub && p.status !== "draft" ? h("button", { class: "btn btn--ghost", type: "button", onclick: async () => { try { await api("POST", `/news/${slug}/unpublish`); toast("Back to draft", "ok"); go(`/admin/news/${slug}`, { replace: true }); } catch (e) { toast(errMsg(e), "bad"); } } }, "Unpublish") : null,
    !isNew && can("news:delete") ? h("button", { class: "btn btn--danger", type: "button", style: { marginLeft: "auto" }, onclick: async () => {
      const ok = await confirmDialog({ title: "Move this post to the trash?", danger: true, ok: "Move to trash", reason: true });
      if (ok) try { await api("DELETE", `/news/${slug}`, { reason: ok.reason }); toast("Moved to trash", "ok"); go("/admin/news"); } catch (e) { toast(errMsg(e), "bad"); }
    } }, icon("trash"), "Delete") : null) : null;
  const panel = h("div");
  const show = (t) => panel.replaceChildren(t === "history" ? historyPanel({ base: `/news/${slug}`, perm: "news:update", onRestored: () => go(`/admin/news/${slug}`, { replace: true }) }) : h("div", { class: "card" }, f, actions));
  show("edit");
  return h("div", null,
    pageHead(isNew ? "New post" : p.title, isNew ? "Write in Markdown; the preview uses the site's own renderer." : h("span", null, statusBadge(p.status), p.status === "scheduled" ? ` for ${fmtDate(p.publish_at)} · ` : " · ", p.status === "published" ? h("a", { href: p.url, target: "_blank", rel: "noopener" }, p.url) : "not public", ` · v${p._meta.version}`)),
    isNew ? null : tabs([["edit", "Edit"], ["history", "History & revisions"]], show, "edit"), panel);
}

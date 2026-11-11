import { h, api, pageHead, table, field, input, textarea, checkbox, toast, errMsg, can, confirmDialog, icon, formData, reasonField, tabs, busy } from "../ui.js";
import { historyPanel, lines, paras } from "./_shared.js";

export default async function team({ param, go }) {
  if (param) return editor(param, go);
  const { data } = await api("GET", "/team");
  return h("div", null, pageHead("Team", "The founder card and “The crew” on the home page.", can("team:create") ? h("a", { class: "btn btn--accent", href: "/admin/team/new" }, icon("plus"), "Add member") : null),
    table([{ label: "Name", render: (m) => h("div", null, h("span", { class: "cell-title" }, m.name), m.featured ? h("span", { class: "badge badge--brand", style: { marginLeft: "6px" } }, "founder card") : null, m.placeholder ? h("span", { class: "badge", style: { marginLeft: "6px" } }, "sample") : null) },
      { label: "Role", key: "role" }, { label: "Links", render: (m) => (m.links || []).length, hideSm: true }], data, { onRow: (m) => go(`/admin/team/${m.id}`) }));
}
async function editor(id, go) {
  const isNew = id === "new";
  const m = isNew ? { id: "", name: "", role: "", featured: false, placeholder: false, photo: "", bio: [], links: [] } : (await api("GET", `/team/${id}`)).data;
  const canEdit = can(isNew ? "team:create" : "team:update");
  const f = h("form", { class: "form form--2", onsubmit: (e) => e.preventDefault() },
    field("Name", input("name", m.name, { required: true, readOnly: !canEdit })), field("ID", input("id", m.id, { readOnly: !isNew, pattern: "[a-z0-9-]+" }), "Used as the news author id"),
    field("Role", input("role", m.role, { readOnly: !canEdit })), field("Photo", input("photo", m.photo, { placeholder: "/media/… square ≥ 400×400", readOnly: !canEdit })),
    h("div", { class: "full" }, field("Bio", textarea("bio", [].concat(m.bio || []).join("\n\n"), { rows: 5, readOnly: !canEdit }), "Blank line between paragraphs")),
    h("div", { class: "full" }, field("Links", textarea("links", (m.links || []).map((l) => `${l.label} | ${l.url}`).join("\n"), { rows: 3, class: "code", readOnly: !canEdit }), "One per line: GitHub | https://github.com/…")),
    checkbox("featured", m.featured, "Featured (the big founder card — only one)", { disabled: !canEdit }), checkbox("placeholder", m.placeholder, "Placeholder member", { disabled: !canEdit }),
    canEdit ? h("div", { class: "full" }, reasonField()) : null);
  const save = async (btn) => {
    const d = formData(f);
    const body = { name: d.name.trim(), role: d.role, photo: d.photo.trim(), bio: paras(d.bio), links: lines(d.links).map((l) => { const [label, url] = l.split("|").map((s) => s.trim()); return { label, url: url || "" }; }), featured: d.featured, placeholder: d.placeholder };
    busy(btn, true);
    try {
      if (isNew) { body.id = d.id.trim(); await api("POST", "/team", { body, reason: d.reason }); toast("Added", "ok"); go(`/admin/team/${body.id}`, { replace: true }); }
      else { await api("PATCH", `/team/${id}`, { body, reason: d.reason, ifMatch: `"v${m._meta.version}"` }); toast("Saved", "ok"); go(`/admin/team/${id}`, { replace: true }); }
    } catch (e) { toast(errMsg(e), "bad"); busy(btn, false); }
  };
  const actions = canEdit ? h("div", { class: "sticky-actions actions" }, h("button", { class: "btn btn--primary", type: "button", onclick: (e) => save(e.currentTarget) }, isNew ? "Add member" : "Save"), h("a", { class: "btn btn--ghost", href: "/admin/team" }, "Cancel"),
    !isNew && can("team:delete") ? h("button", { class: "btn btn--danger", type: "button", style: { marginLeft: "auto" }, onclick: async () => { if (!(await confirmDialog({ title: `Remove ${m.name}?`, danger: true, ok: "Remove" }))) return; try { await api("DELETE", `/team/${id}`); go("/admin/team"); } catch (e) { toast(errMsg(e), "bad"); } } }, icon("trash"), "Remove") : null) : null;
  const panel = h("div");
  const show = (t) => panel.replaceChildren(t === "history" ? historyPanel({ base: `/team/${id}`, perm: "team:update", onRestored: () => go(`/admin/team/${id}`, { replace: true }) }) : h("div", { class: "card" }, f, actions));
  show("edit");
  return h("div", null, pageHead(isNew ? "Add team member" : m.name, isNew ? null : m.role), isNew ? null : tabs([["edit", "Edit"], ["history", "History"]], show, "edit"), panel);
}

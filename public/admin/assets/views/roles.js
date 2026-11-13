import { h, api, pageHead, field, input, textarea, toast, errMsg, can, confirmDialog, icon, select } from "../ui.js";
import { matrix } from "./_matrix.js";

export default async function roles({ param, go }) {
  if (param) return editor(param, go);
  const { data } = await api("GET", "/roles");
  return h("div", null, pageHead("Roles", "Built-in roles are fixed. Create custom roles with exactly the permissions someone needs — optionally limited to certain games.", can("roles:manage") ? h("a", { class: "btn btn--accent", href: "/admin/roles/new" }, icon("plus"), "New role") : null),
    h("div", { class: "grid g3" }, data.map((r) => h("a", { class: "card", href: `/admin/roles/${r.id}`, style: { textDecoration: "none" } },
      h("div", { class: "row row--between" }, h("h2", { style: { margin: 0 } }, r.name), r.builtin ? h("span", { class: "badge" }, "built-in") : h("span", { class: "badge badge--brand" }, "custom")),
      h("p", { class: "muted small" }, r.description || "—"), h("p", { class: "small" }, h("b", null, r.permissions.includes("*") ? "Everything" : `${r.permissions.length} permissions`), ` · ${r.users} user(s)`, r.game_scope ? ` · games: ${r.game_scope.join(", ")}` : "")))));
}
async function editor(id, go) {
  const isNew = id === "new";
  const r = isNew ? { name: "", description: "", permissions: [], game_scope: null, builtin: false } : (await api("GET", `/roles/${id}`)).data;
  const ro = r.builtin || !can("roles:manage");
  const games = can("games:read") ? (await api("GET", "/games")).data : [];
  const m = await matrix(r.permissions, { readOnly: ro });
  const name = input("name", r.name, { required: true, readOnly: ro }), desc = textarea("description", r.description, { rows: 2, readOnly: ro });
  const scope = select("game_scope", games.map((g) => [g.id, g.title]), null, { multiple: true, disabled: ro, size: Math.min(6, Math.max(2, games.length)) });
  [...scope.options].forEach((o) => (o.selected = (r.game_scope || []).includes(o.value)));
  const save = async () => {
    const body = { name: name.value.trim(), description: desc.value, permissions: m.value(), game_scope: [...scope.selectedOptions].map((o) => o.value) };
    if (!body.game_scope.length) body.game_scope = null;
    try {
      if (isNew) { const res = await api("POST", "/roles", { body }); toast("Role created", "ok"); go(`/admin/roles/${res.data.id}`, { replace: true }); }
      else { await api("PATCH", `/roles/${id}`, { body, ifMatch: `"v${r.version}"` }); toast("Role saved", "ok"); go(`/admin/roles/${id}`, { replace: true }); }
    } catch (e) { toast(errMsg(e), "bad"); }
  };
  return h("div", { class: "stack" }, pageHead(isNew ? "New role" : r.name, r.builtin ? "Built-in role (read-only). Copy it into a custom role to change it." : `${r.users ?? 0} user(s) have this role`,
    null),
    h("div", { class: "card" }, h("div", { class: "form form--2" }, field("Name", name), field("Description", desc), h("div", { class: "full" }, field("Limit game permissions to these games (optional)", scope, "Ctrl/⌘-click to pick several. Empty = all games.")))),
    h("div", { class: "card" }, h("h2", null, "Permissions"), h("p", { class: "small muted" }, "Greyed-out boxes are permissions you don't have yourself — nobody can grant more access than they hold."), m),
    ro ? null : h("div", { class: "sticky-actions actions" }, h("button", { class: "btn btn--primary", type: "button", onclick: save }, isNew ? "Create role" : "Save role"), h("a", { class: "btn btn--ghost", href: "/admin/roles" }, "Cancel"),
      !isNew ? h("button", { class: "btn btn--danger", type: "button", style: { marginLeft: "auto" }, onclick: async () => { if (!(await confirmDialog({ title: `Delete role ${r.name}?`, danger: true, ok: "Delete" }))) return; try { await api("DELETE", `/roles/${id}`); go("/admin/roles"); } catch (e) { toast(errMsg(e), "bad"); } } }, icon("trash"), "Delete") : null));
}

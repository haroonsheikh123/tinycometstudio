import { h, api, pageHead, table, statusBadge, field, input, select, toast, errMsg, can, confirmDialog, dialog, ago, icon, copyBtn, state, secretDialog } from "../ui.js";

export default async function users({ param, go }) {
  const [u, r] = await Promise.all([api("GET", "/users"), can("roles:read") ? api("GET", "/roles") : { data: [] }]);
  const roles = r.data;
  const roleName = (id) => roles.find((x) => x.id === id)?.name || id;
  const act = async (fn, okMsg) => { try { const res = await fn(); if (okMsg) toast(okMsg, "ok"); go("/admin/users", { replace: true }); return res; } catch (e) { toast(errMsg(e), "bad"); } };
  const linkDialog = (title, url, intro) => dialog((close) => h("div", { class: "stack" }, h("h2", null, title), h("p", { class: "muted" }, intro), h("div", { class: "secret-box" }, h("code", { "data-link": "" }, url), copyBtn(url)), h("div", { class: "banner banner--warn" }, "One use only. Share it privately (e.g. in a direct message)."), h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary", type: "button", onclick: () => close() }, "Done"))));
  const invite = () => dialog((close) => {
    const email = input("email", "", { type: "email", required: true }), name = input("name", "", { required: true });
    const role = select("role_id", roles.filter((x) => x.id !== "owner").map((x) => [x.id, x.name]), "editor");
    const err = h("p", { class: "form-error" });
    return h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      try { const res = await api("POST", "/users", { body: { email: email.value.trim(), name: name.value.trim(), role_id: role.value } }); close(); await linkDialog("Invite created", res.data.invite_url, `Send this link to ${res.data.user.email}. They set a password and connect an authenticator app. Valid 7 days.${res.data.email_sent ? " (Also emailed.)" : ""}`); go("/admin/users", { replace: true }); }
      catch (x) { err.textContent = errMsg(x); }
    } }, h("h2", null, "Invite a team member"), field("Email", email), field("Name", name), field("Role", role, "You can only give roles that don't exceed your own access."), err,
      h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary" }, "Create invite")));
  });
  const menu = (x) => {
    if (x.id === state.me.user.id) return h("span", { class: "badge badge--brand" }, "you");
    const b = [];
    if (can("users:update") && x.role_id !== "owner") b.push(h("button", { class: "btn btn--sm", type: "button", onclick: () => roleDialog(x) }, "Role"));
    if (can("users:manage") && x.status === "active") b.push(h("button", { class: "btn btn--sm", type: "button", onclick: async () => { if (await confirmDialog({ title: `Suspend ${x.name}?`, body: "They're signed out everywhere and can't sign in until reactivated.", ok: "Suspend", danger: true })) act(() => api("PATCH", `/users/${x.id}`, { body: { status: "suspended" } }), "Suspended"); } }, "Suspend"));
    if (can("users:manage") && x.status === "suspended") b.push(h("button", { class: "btn btn--sm", type: "button", onclick: () => act(() => api("PATCH", `/users/${x.id}`, { body: { status: "active" } }), "Reactivated") }, "Reactivate"));
    if (can("users:manage") && x.status === "active") b.push(h("button", { class: "btn btn--sm", type: "button", onclick: async () => { if (!(await confirmDialog({ title: `Reset ${x.name}'s authenticator?`, body: "They're signed out and must set up 2FA again with a one-time link (plus their password).", ok: "Reset 2FA", danger: true }))) return; const res = await act(() => api("POST", `/users/${x.id}/reset-2fa`)); if (res) linkDialog("Enrollment link", res.data.enroll_url, "Send this to the user. Valid 72 hours."); } }, "Reset 2FA"));
    if (can("users:manage") && x.status === "active") b.push(h("button", { class: "btn btn--sm", type: "button", onclick: async () => { const res = await act(() => api("POST", `/users/${x.id}/reset-password`)); if (res) linkDialog("Password reset link", res.data.reset_url, "Valid 24 hours."); } }, "Reset password"));
    if (can("users:create") && x.status === "invited") b.push(h("button", { class: "btn btn--sm", type: "button", onclick: async () => { const res = await act(() => api("POST", `/users/${x.id}/resend-invite`)); if (res) linkDialog("New invite link", res.data.invite_url, "The previous link no longer works."); } }, "New invite link"));
    if (state.me.is_owner && x.status === "active") b.push(h("button", { class: "btn btn--sm", type: "button", onclick: () => transfer(x) }, "Make owner"));
    if (can("users:delete") && x.role_id !== "owner") b.push(h("button", { class: "btn btn--sm btn--danger", type: "button", "aria-label": `Remove ${x.name}`, onclick: async () => { if (await confirmDialog({ title: `Remove ${x.name}?`, body: "Their sessions end and their API keys are revoked. Their history stays in the audit log.", ok: "Remove", danger: true })) act(() => api("DELETE", `/users/${x.id}`), "Removed"); } }, icon("trash")));
    if (can("audit:read")) b.push(h("a", { class: "btn btn--sm btn--ghost", href: `/admin/audit?actor_id=${x.id}` }, "Activity"));
    return h("div", { class: "row" }, b);
  };
  const roleDialog = (x) => dialog((close) => {
    const role = select("role_id", roles.filter((r) => r.id !== "owner").map((r) => [r.id, r.name]), x.role_id);
    return h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault(); close(); act(() => api("PATCH", `/users/${x.id}`, { body: { role_id: role.value } }), "Role changed"); } }, h("h2", null, `Role for ${x.name}`), field("Role", role), h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary" }, "Save")));
  });
  const transfer = (x) => dialog((close) => {
    const c = input("confirm", "", { type: "email", placeholder: x.email });
    return h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault(); close(); try { await api("POST", `/users/${x.id}/transfer-ownership`, { body: { confirm_email: c.value } }); toast("Ownership transferred — you're now an admin", "ok"); location.reload(); } catch (y) { toast(errMsg(y), "bad"); } } },
      h("h2", null, `Make ${x.name} the owner?`), h("p", { class: "muted" }, "You become an admin. Only the new owner can undo this."), field(`Type ${x.email} to confirm`, c), h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--danger btn--solid" }, "Transfer ownership")));
  });
  void param;
  return h("div", null, pageHead("Users", "Team members who can sign in. Everyone uses email + password + an authenticator app.", can("users:create") ? h("button", { class: "btn btn--accent", type: "button", onclick: invite }, icon("plus"), "Invite user") : null),
    table([
      { label: "Name", render: (x) => h("div", null, h("span", { class: "cell-title" }, x.name), h("span", { class: "sub" }, x.email)) },
      { label: "Role", render: (x) => h("span", { class: "badge badge--brand" }, roleName(x.role_id)) },
      { label: "Status", render: (x) => statusBadge(x.status) },
      { label: "2FA", render: (x) => (x.mfa_enabled ? h("span", { class: "badge badge--ok" }, "on") : h("span", { class: "badge badge--warn" }, "pending")), hideSm: true },
      { label: "Last sign-in", render: (x) => h("span", { class: "small" }, ago(x.last_login_at), x.last_login_ip ? h("span", { class: "sub" }, x.last_login_ip) : null), hideSm: true },
      { label: "", render: menu }
    ], u.data));
}

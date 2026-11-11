import { h, api, pageHead, toast, errMsg, field, input, ago, confirmDialog, state, dialog, copyBtn, kv, fmtDate } from "../ui.js";

export default async function account({ go }) {
  const me = state.me;
  const sessions = (await api("GET", "/auth/sessions")).data;
  const cur = input("cur", "", { type: "password", autocomplete: "current-password", required: true }), nw = input("new", "", { type: "password", autocomplete: "new-password", required: true, minlength: 12 });
  const pwForm = h("form", { class: "form", onsubmit: async (e) => { e.preventDefault(); try { await api("POST", "/auth/password", { body: { current_password: cur.value, new_password: nw.value } }); toast("Password changed — other devices were signed out", "ok"); cur.value = nw.value = ""; } catch (x) { toast(errMsg(x), "bad"); } } },
    field("Current password", cur), field("New password", nw, "At least 12 characters"), h("div", null, h("button", { class: "btn btn--primary" }, "Change password")));
  const codes = async () => {
    try {
      const r = await api("POST", "/auth/recovery-codes");
      dialog((close) => h("div", { class: "stack" }, h("h2", null, "New recovery codes"), h("p", { class: "muted" }, "The old codes no longer work. Save these now."), h("div", { class: "codes" }, r.data.recovery_codes.map((c) => h("span", null, c))), h("div", { class: "row" }, copyBtn(r.data.recovery_codes.join("\n"), "Copy all")), h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary", type: "button", onclick: () => close() }, "Done"))));
    } catch (e) { toast(errMsg(e), "bad"); }
  };
  const reenroll = async () => {
    try {
      const s = (await api("POST", "/auth/totp/setup", { body: {} })).data;
      dialog((close) => {
        const c = input("code", "", { inputmode: "numeric", class: "otp", maxlength: 7, "aria-label": "Code from the new app" });
        return h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault(); try { const r = await api("POST", "/auth/totp/confirm", { body: { code: c.value.replace(/\s/g, "") } }); close(); toast("New authenticator connected", "ok"); dialog((x) => h("div", { class: "stack" }, h("h2", null, "New recovery codes"), h("div", { class: "codes" }, r.data.recovery_codes.map((k) => h("span", null, k))), h("button", { class: "btn btn--primary", type: "button", onclick: () => x() }, "Saved"))); } catch (x) { toast(errMsg(x), "bad"); } } },
          h("h2", null, "Connect a new authenticator"), h("div", { class: "qr" }, h("img", { src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s.qr_svg), alt: "QR code", width: 168, height: 168 }), h("div", { class: "secret" }, s.secret_grouped)), field("Code from the new app", c), h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary" }, "Connect")));
      }, { wide: true });
    } catch (e) { toast(errMsg(e), "bad"); }
  };
  return h("div", { class: "stack" }, pageHead("My account", `${me.user.email} · ${me.role?.name || me.user.role_id}`),
    h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("h2", null, "Profile"), kv([["Name", me.user.name], ["Email", me.user.email], ["Role", me.role?.name], ["Two-factor", "Authenticator app ✓"], ["Recovery codes left", String(me.user.recovery_codes_left)], ["Session expires", fmtDate(me.session?.expires_at)]]),
        h("div", { class: "row", style: { marginTop: "12px" } }, h("button", { class: "btn", type: "button", onclick: codes }, "New recovery codes"), h("button", { class: "btn", type: "button", onclick: reenroll }, "Change authenticator app"), h("a", { class: "btn btn--ghost", href: `/admin/audit?actor_id=${me.user.id}` }, "My activity"))),
      h("div", { class: "card" }, h("h2", null, "Password"), pwForm)),
    h("div", { class: "card" }, h("div", { class: "card__head" }, h("h2", null, "Where you're signed in"), h("button", { class: "btn btn--danger btn--sm", type: "button", onclick: async () => { if (!(await confirmDialog({ title: "Sign out all other devices?", ok: "Sign out others" }))) return; await api("POST", "/auth/sessions/revoke-all", { body: { keep_current: true } }); toast("Other devices signed out", "ok"); go("/admin/account", { replace: true }); } }, "Sign out everywhere else")),
      h("ul", { class: "list" }, sessions.map((s) => h("li", null, h("span", { class: ["dot", s.current && "dot--ok"] }), h("span", { class: "grow" }, h("b", null, s.user_agent ? s.user_agent.replace(/^Mozilla\/5\.0 \(([^)]*)\).*$/, "$1").slice(0, 70) : "Unknown device"), h("span", { class: "sub muted small", style: { display: "block" } }, `${s.ip || ""} ${s.country || ""} · started ${ago(s.created_at)} · active ${ago(s.last_seen_at)}`)),
        s.current ? h("span", { class: "badge badge--ok" }, "this device") : h("button", { class: "btn btn--sm", type: "button", onclick: async () => { await api("DELETE", `/auth/sessions/${s.id}`); go("/admin/account", { replace: true }); } }, "Sign out"))))));
}

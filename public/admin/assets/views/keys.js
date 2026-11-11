import { h, api, pageHead, table, statusBadge, field, input, textarea, select, checkbox, toggle, toast, errMsg, can, confirmDialog, dialog, ago, icon, secretDialog, state, fmtNum, fmtDate } from "../ui.js";
import { matrix } from "./_matrix.js";

export default async function keys({ go }) {
  const r = await api("GET", "/api-keys", { query: { status: "all" } });
  const sys = can("system:read") ? (await api("GET", "/system")).data : null;
  const kill = sys ? h("div", { class: ["banner", sys.kill_switch.enabled ? "banner--bad" : "banner--ok"] },
    sys.kill_switch.enabled ? `Kill switch ON — every API key is blocked${sys.kill_switch.reason ? ` (${sys.kill_switch.reason})` : ""}.` : "API-key access is ON.",
    can("system:manage") ? h("button", { class: ["btn btn--sm", !sys.kill_switch.enabled && "btn--danger btn--solid"], type: "button", onclick: async () => {
      const on = !sys.kill_switch.enabled;
      const ok = await confirmDialog({ title: on ? "Block ALL API keys now?" : "Re-enable API keys?", body: on ? "Every app and agent loses access instantly. Admin sessions keep working." : "Keys go back to their normal permissions.", ok: on ? "Activate kill switch" : "Turn API access back on", danger: on, reason: true });
      if (!ok) return;
      try { await api("PUT", "/system/kill-switch", { body: { enabled: on, reason: ok.reason || undefined } }); toast(on ? "Kill switch activated" : "API access restored", "ok"); go("/admin/api-keys", { replace: true }); } catch (e) { toast(errMsg(e), "bad"); }
    } }, sys.kill_switch.enabled ? "Turn API access back on" : "Kill switch") : null) : null;
  const act = (fn, msg) => async () => { try { await fn(); toast(msg, "ok"); go("/admin/api-keys", { replace: true }); } catch (e) { toast(errMsg(e), "bad"); } };
  return h("div", null, pageHead("API keys", "Keys for apps and cloud agents. A key can never do more than the person who created it.", can("api_keys:create") ? h("button", { class: "btn btn--accent", type: "button", onclick: () => keyDialog(null, go) }, icon("plus"), "New API key") : null, h("a", { class: "btn", href: "/admin/api-docs" }, icon("code"), "API docs")),
    kill,
    table([
      { label: "Key", render: (k) => h("div", null, h("span", { class: "cell-title" }, k.name), h("span", { class: "sub mono" }, `${k.prefix}_…`)) },
      { label: "Access", render: (k) => h("div", { class: "row" }, (k.scopes.includes("*") ? ["*"] : k.scopes.slice(0, 3)).map((s) => h("span", { class: "chip" }, s)), k.scopes.length > 3 ? h("span", { class: "tiny muted" }, `+${k.scopes.length - 3}`) : null, k.role_id ? h("span", { class: "chip" }, `role:${k.role_id}`) : null) },
      { label: "Status", render: (k) => h("div", { class: "row" }, statusBadge(k.status), k.require_approval ? h("span", { class: "badge badge--info" }, "approval") : null, k.force_dry_run ? h("span", { class: "badge badge--info" }, "dry-run") : null) },
      { label: "Last used", render: (k) => h("span", { class: "small" }, ago(k.last_used_at), h("span", { class: "sub" }, `${fmtNum(k.usage_count)} calls${k.last_used_ip ? ` · ${k.last_used_ip}` : ""}`)), hideSm: true },
      { label: "Owner", render: (k) => k.owner_name || "—", hideSm: true },
      { label: "", render: (k) => k.status === "revoked" ? null : h("div", { class: "row" },
        can("api_keys:update") ? h("button", { class: "btn btn--sm", type: "button", onclick: () => keyDialog(k, go) }, "Edit") : null,
        can("api_keys:update") ? h("button", { class: "btn btn--sm", type: "button", onclick: act(() => api("PATCH", `/api-keys/${k.id}`, { body: { enabled: !k.enabled } }), k.enabled ? "Disabled" : "Enabled") }, k.enabled ? "Disable" : "Enable") : null,
        can("api_keys:update") ? h("button", { class: "btn btn--sm", type: "button", onclick: async () => { const ok = await confirmDialog({ title: `Rotate “${k.name}”?`, body: "You get a new secret. The old one keeps working for 24 hours so you can switch over.", ok: "Rotate" }); if (!ok) return; try { const res = await api("POST", `/api-keys/${k.id}/rotate`, { body: { grace_hours: 24 } }); await secretDialog({ title: "New secret", intro: `Old secret works until ${fmtDate(res.data.old_secret_valid_until)}.`, secret: res.data.secret }); go("/admin/api-keys", { replace: true }); } catch (e) { toast(errMsg(e), "bad"); } } }, "Rotate") : null,
        can("api_keys:delete") ? h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: async () => { if (await confirmDialog({ title: `Revoke “${k.name}”?`, body: "Immediate and permanent.", ok: "Revoke", danger: true })) act(() => api("POST", `/api-keys/${k.id}/revoke`), "Revoked")(); } }, "Revoke") : null,
        can("audit:read") ? h("a", { class: "btn btn--sm btn--ghost", href: `/admin/audit?api_key_id=${k.id}` }, "Activity") : null) }
    ], r.data, { empty: "No API keys yet." }));
}

async function keyDialog(k, go) {
  const isNew = !k;
  k ||= { name: "", description: "", scopes: [], role_id: null, expires_at: null, ip_allowlist: [], rate_limit: 60, environments: ["production", "preview", "development"], require_approval: false, force_dry_run: false };
  const roles = can("roles:read") ? (await api("GET", "/roles")).data.filter((r) => r.id !== "owner") : [];
  const m = await matrix(k.scopes);
  const star = state.me.is_owner ? checkbox("star", k.scopes.includes("*"), "Everything (*) — owner only, use sparingly") : null;
  dialog((close) => {
    const name = input("name", k.name, { required: true, maxlength: 80, placeholder: "e.g. Release bot, Analytics dashboard" });
    const desc = input("description", k.description, { maxlength: 500 });
    const role = select("role_id", [["", "— none —"], ...roles.map((r) => [r.id, r.name])], k.role_id || "");
    const exp = input("expires", k.expires_at ? k.expires_at.slice(0, 10) : "", { type: "date" });
    const ips = textarea("ips", k.ip_allowlist.join("\n"), { rows: 2, class: "code", placeholder: "203.0.113.4\n2001:db8::/32" });
    const rate = input("rate", String(k.rate_limit), { type: "number", min: 1, max: 10000 });
    const envs = ["production", "preview", "development"].map((e) => checkbox(`env_${e}`, k.environments.includes(e), e));
    const appr = toggle("approval", k.require_approval, "Require human approval for destructive actions (delete / publish / manage)");
    const dry = toggle("dry", k.force_dry_run, "Dry-run only (writes are previewed, never applied)");
    const err = h("p", { class: "form-error" });
    return h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault(); err.textContent = "";
      const body = {
        name: name.value.trim(), description: desc.value, scopes: star?.querySelector("input").checked ? ["*"] : m.value(), role_id: role.value || null,
        expires_at: exp.value ? new Date(exp.value + "T23:59:59Z").toISOString() : null, ip_allowlist: ips.value.split(/[\s,]+/).filter(Boolean), rate_limit: Number(rate.value),
        environments: envs.filter((c) => c.querySelector("input").checked).map((c) => c.querySelector("input").name.slice(4)), require_approval: appr.querySelector("input").checked, force_dry_run: dry.querySelector("input").checked
      };
      try {
        if (isNew) {
          const res = await api("POST", "/api-keys", { body });
          close();
          const curl = `curl -H "Authorization: Bearer ${res.data.secret}" ${location.origin}/api/v1/auth/session`;
          await secretDialog({ title: "Your new API key", intro: `“${res.data.api_key.name}” · send it as a Bearer token.`, secret: res.data.secret, extra: h("div", null, h("div", { class: "label" }, "Try it"), h("pre", { class: "json" }, curl)) });
        } else { await api("PATCH", `/api-keys/${k.id}`, { body }); close(); toast("Key updated", "ok"); }
        go("/admin/api-keys", { replace: true });
      } catch (x) { err.textContent = errMsg(x); }
    } }, h("h2", null, isNew ? "New API key" : `Edit “${k.name}”`),
      h("div", { class: "form form--2" }, field("Name", name), field("Description", desc), field("Also give it a role (optional)", role), field("Expires (optional)", exp), field("Rate limit (requests / minute)", rate), h("fieldset", null, h("legend", null, "Environments"), h("div", { class: "row" }, envs)),
        h("div", { class: "full" }, field("IP allowlist (optional)", ips, "IPs or CIDR ranges, one per line. Empty = any IP."))),
      h("div", null, h("div", { class: "label" }, "Scopes"), h("p", { class: "tiny muted" }, "Pick exactly what the app/agent needs. Greyed boxes exceed your own access."), star, m),
      appr, dry, err, h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary" }, isNew ? "Create key" : "Save")));
  }, { wide: true, label: "API key" });
}

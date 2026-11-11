import { h, api, pageHead, toast, errMsg, can, confirmDialog, toggle, field, input, kv, fmtDate, download, state, dialog } from "../ui.js";

export default async function system({ go }) {
  const s = (await api("GET", "/system")).data;
  const m = can("system:manage");
  const yes = (b) => h("span", { class: ["badge", b ? "badge--ok" : "badge--bad"] }, b ? "yes" : "no");
  const kill = toggle("kill", s.kill_switch.enabled, "API kill switch — block every API key instantly", { disabled: !m, onchange: async (e) => {
    const on = e.target.checked;
    const ok = await confirmDialog({ title: on ? "Block ALL API keys?" : "Turn API-key access back on?", ok: on ? "Block all keys" : "Re-enable", danger: on, reason: true });
    if (!ok) { e.target.checked = !on; return; }
    try { await api("PUT", "/system/kill-switch", { body: { enabled: on, reason: ok.reason || undefined } }); toast(on ? "Kill switch ON" : "API keys re-enabled", "ok"); go("/admin/system", { replace: true }); } catch (x) { e.target.checked = !on; toast(errMsg(x), "bad"); }
  } }, true);
  const maint = toggle("maint", s.maintenance.enabled, "Maintenance mode — public pages show “back soon” (503)", { disabled: !m, onchange: async (e) => { try { await api("PUT", "/system/maintenance", { body: { enabled: e.target.checked } }); toast("Saved", "ok"); } catch (x) { e.target.checked = !e.target.checked; toast(errMsg(x), "bad"); } } }, true);
  const btn = (label, fn, ok) => h("button", { class: "btn", type: "button", onclick: async () => { try { const r = await fn(); toast(ok(r), "ok"); } catch (e) { toast(errMsg(e), "bad"); } } }, label);
  const auditRet = state.me.is_owner ? h("div", { class: "card" }, h("h2", null, "Audit retention (owner only)"), h("p", { class: "small muted" }, `Currently: ${s.retention.audit_days ? `${s.retention.audit_days} days, older entries archived to R2 as JSONL` : "keep forever (recommended)"}.`),
    h("div", { class: "row" }, btn("Change retention…", () => new Promise((res, rej) => dialog((close) => { const d = input("days", String(s.retention.audit_days), { type: "number", min: 0 }); return h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault(); try { res(await api("PUT", "/audit/retention", { body: { days: Number(d.value) } })); } catch (x) { rej(x); } close(); } }, h("h2", null, "Audit retention"), field("Days (0 = forever)", d), h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary" }, "Save"))); })), () => "Retention saved"),
      s.retention.audit_days ? btn("Archive old entries now", () => api("POST", "/audit/archive"), (r) => `Archived ${r.data.archived} entries`) : null)) : null;
  return h("div", { class: "stack" }, pageHead("System", `Environment: ${s.environment} · API v${s.api_version}`),
    h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("h2", null, "Emergency controls"), h("div", { class: "stack" }, kill, s.kill_switch.enabled ? h("p", { class: "small muted" }, `Since ${fmtDate(s.kill_switch.at)} by ${s.kill_switch.by?.name}${s.kill_switch.reason ? ` — ${s.kill_switch.reason}` : ""}`) : null, maint)),
      h("div", { class: "card" }, h("h2", null, "Cache & housekeeping"), h("p", { class: "small muted" }, `Pages are rendered from D1 and cached at the edge. Content version ${s.content_version} — every save bumps it, so caches refresh instantly.${s.next_scheduled_publish ? ` Next scheduled post: ${fmtDate(s.next_scheduled_publish)}.` : ""}`),
        h("div", { class: "row" }, can("cache:manage") ? btn("Purge cache", () => api("POST", "/cache/purge", { body: {} }), (r) => `Purged (v${r.data.content_version})`) : null, m ? btn("Run housekeeping", () => api("POST", "/system/tick"), (r) => `Done: ${r.data.published.length} published, ${r.data.webhook_retries} webhook retries`) : null,
          can("system:read") ? h("button", { class: "btn", type: "button", onclick: async () => { try { const r = await api("GET", "/export/content"); const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" })), download: "tinycomet-content-export.json" }); document.body.append(a); a.click(); a.remove(); toast("Exported — run tools/content-sync.mjs pull to write the files into the repo", "ok"); } catch (e) { toast(errMsg(e), "bad"); } } }, "Export content") : null))),
    h("div", { class: "grid g2" },
      h("div", { class: "card" }, h("h2", null, "Bindings & secrets"), h("p", { class: "small muted" }, "Only whether each is set — values are never shown."), kv([["D1 database (DB)", yes(s.bindings.DB)], ["R2 media (MEDIA)", yes(s.bindings.MEDIA)], ...Object.entries(s.secrets).map(([k, v]) => [k, yes(v)])])),
      h("div", { class: "card" }, h("h2", null, "Numbers"), kv([["Users", s.counts.users], ["Active API keys", s.counts.api_keys], ["Audit entries", s.counts.audit_entries], ["Pending approvals", s.counts.pending_approvals], ["Pending webhook deliveries", s.counts.pending_deliveries], ["Analytics retention", `${s.retention.analytics_days || "∞"} days`]]))),
    auditRet);
}

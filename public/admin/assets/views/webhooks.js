import { h, api, pageHead, table, statusBadge, field, input, checkbox, toggle, toast, errMsg, can, confirmDialog, dialog, ago, icon, secretDialog, fmtDate, jsonBlock } from "../ui.js";

export default async function webhooks({ param, go }) {
  if (param) return detail(param, go);
  const { data } = await api("GET", "/webhooks");
  return h("div", null, pageHead("Webhooks", "Get a signed HTTPS POST when things happen (news published, game updated, message received…). Failed deliveries retry with backoff.", can("webhooks:manage") ? h("button", { class: "btn btn--accent", type: "button", onclick: () => hookDialog(null, go) }, icon("plus"), "Add webhook") : null),
    table([{ label: "URL", render: (w) => h("div", null, h("span", { class: "cell-title mono" }, w.url), h("span", { class: "sub" }, w.description)) }, { label: "Events", render: (w) => w.events.join(", ") }, { label: "Status", render: (w) => h("div", { class: "row" }, statusBadge(w.enabled ? "active" : "disabled"), w.failure_count ? h("span", { class: "badge badge--bad" }, `${w.failure_count} failures`) : null) }],
      data, { onRow: (w) => go(`/admin/webhooks/${w.id}`), empty: "No webhooks yet." }));
}
async function hookDialog(w, go) {
  const events = (await api("GET", "/webhooks/events")).data;
  const isNew = !w;
  w ||= { url: "https://", description: "", events: ["news.published"], enabled: true };
  dialog((close) => {
    const url = input("url", w.url, { type: "url", required: true }), desc = input("description", w.description);
    const all = checkbox("all", w.events.includes("*"), "All events (*)");
    const boxes = events.map((e) => checkbox(e, w.events.includes(e), e));
    const err = h("p", { class: "form-error" });
    return h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      const ev = all.querySelector("input").checked ? ["*"] : boxes.filter((b) => b.querySelector("input").checked).map((b) => b.querySelector("input").name);
      try {
        if (isNew) { const r = await api("POST", "/webhooks", { body: { url: url.value, description: desc.value, events: ev } }); close(); await secretDialog({ title: "Signing secret", intro: "Verify X-TinyComet-Signature: t=<unix>,v1=hex(HMAC-SHA256(secret, `${t}.${rawBody}`)). See docs/API.md.", secret: r.data.secret }); }
        else { await api("PATCH", `/webhooks/${w.id}`, { body: { url: url.value, description: desc.value, events: ev } }); close(); }
        go(isNew ? "/admin/webhooks" : `/admin/webhooks/${w.id}`, { replace: true });
      } catch (x) { err.textContent = errMsg(x); }
    } }, h("h2", null, isNew ? "Add webhook" : "Edit webhook"), field("Endpoint URL (https)", url), field("Description", desc), all, h("div", { class: "grid g3" }, boxes), err, h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary" }, "Save")));
  }, { wide: true });
}
async function detail(id, go) {
  const [w, d] = await Promise.all([api("GET", `/webhooks/${id}`), api("GET", `/webhooks/${id}/deliveries`)]);
  const hk = w.data;
  const m = can("webhooks:manage");
  const run = (fn, msg) => async () => { try { await fn(); toast(msg, "ok"); go(`/admin/webhooks/${id}`, { replace: true }); } catch (e) { toast(errMsg(e), "bad"); } };
  return h("div", { class: "stack" }, pageHead(hk.url, hk.description || hk.events.join(", "),
    m ? h("button", { class: "btn", type: "button", onclick: run(async () => { const r = await api("POST", `/webhooks/${id}/test`); if (r.data.status !== "success") throw new Error(`Test failed: ${r.data.response_status || ""} ${r.data.response_excerpt || ""}`); }, "Test delivered") }, "Send test") : null,
    m ? h("button", { class: "btn", type: "button", onclick: () => hookDialog(hk, go) }, "Edit") : null,
    m ? h("button", { class: "btn", type: "button", onclick: async () => { try { const r = await api("POST", `/webhooks/${id}/rotate-secret`); await secretDialog({ title: "New signing secret", intro: "The old secret stopped working.", secret: r.data.secret }); } catch (e) { toast(errMsg(e), "bad"); } } }, "Rotate secret") : null,
    m ? h("button", { class: "btn btn--danger", type: "button", onclick: async () => { if (await confirmDialog({ title: "Delete this webhook?", danger: true, ok: "Delete" })) { await api("DELETE", `/webhooks/${id}`); go("/admin/webhooks"); } } }, icon("trash")) : null),
    m ? h("div", { class: "card" }, toggle("enabled", hk.enabled, "Enabled", { onchange: run(() => api("PATCH", `/webhooks/${id}`, { body: { enabled: !hk.enabled } }), "Saved") })) : null,
    h("h2", null, "Deliveries"),
    table([{ label: "Event", render: (x) => h("span", { class: "chip" }, x.event) }, { label: "Status", render: (x) => statusBadge(x.status) }, { label: "HTTP", render: (x) => x.response_status || "—" }, { label: "Attempts", key: "attempts", num: true }, { label: "When", render: (x) => ago(x.created_at) },
      { label: "", render: (x) => h("div", { class: "row" }, h("button", { class: "btn btn--sm", type: "button", onclick: () => dialog(() => h("div", { class: "stack" }, h("h2", null, x.event), h("p", { class: "small muted" }, `${x.status} · next attempt ${fmtDate(x.next_attempt_at)} · ${x.response_excerpt || ""}`), jsonBlock(x.payload)), { wide: true }) }, "Payload"), m && x.status !== "success" ? h("button", { class: "btn btn--sm", type: "button", onclick: run(() => api("POST", `/webhook-deliveries/${x.id}/redeliver`), "Redelivered") }, "Retry") : null) }],
      d.data, { empty: "No deliveries yet." }));
}

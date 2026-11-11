import { h, api, pageHead, toast, errMsg, can, seg, fmtDate, ago, statusBadge, confirmDialog, $$, icon } from "../ui.js";

export default async function messages({ go, query }) {
  const status = query.get("status") || "inbox";
  const r = await api("GET", "/messages", { query: { status, limit: 200 } });
  const c = r.meta.counts || {};
  const detail = h("div", { class: "card" }, h("p", { class: "muted" }, "Select a message to read it."));
  const selected = () => $$("input[data-id]:checked", list).map((i) => i.dataset.id);
  const bulk = async (action) => {
    const ids = selected();
    if (!ids.length) return toast("Select messages first");
    if (action === "delete" && !(await confirmDialog({ title: `Delete ${ids.length} message(s)?`, danger: true, ok: "Delete" }))) return;
    try { await api("POST", "/messages/bulk", { body: { ids, action } }); toast("Done", "ok"); go(location.pathname + location.search, { replace: true }); } catch (e) { toast(errMsg(e), "bad"); }
  };
  const open = async (m) => {
    const full = (await api("GET", `/messages/${m.id}`)).data;
    if (full.status === "new" && can("messages:update")) api("PATCH", `/messages/${m.id}`, { body: { status: "read" } }).catch(() => {});
    const act = (s, l) => h("button", { class: "btn btn--sm", type: "button", onclick: async () => { try { await api("PATCH", `/messages/${m.id}`, { body: { status: s } }); toast(l, "ok"); go(location.pathname + location.search, { replace: true }); } catch (e) { toast(errMsg(e), "bad"); } } }, l);
    detail.replaceChildren(h("div", { class: "card__head" }, h("h2", null, full.topic || "Message"), statusBadge(full.status)),
      h("p", null, h("b", null, full.name || "—"), " · ", h("a", { href: `mailto:${full.email}?subject=${encodeURIComponent("Re: " + (full.topic || "your message"))}` }, full.email), h("span", { class: "muted" }, ` · ${fmtDate(full.created_at)}${full.country ? ` · ${full.country}` : ""}`)),
      h("pre", { class: "json", style: { fontFamily: "var(--font-body)", fontSize: ".95rem" } }, full.body),
      can("messages:update") ? h("div", { class: "row", style: { marginTop: "12px" } }, h("a", { class: "btn btn--primary btn--sm", href: `mailto:${full.email}` }, "Reply by email"), act("archived", "Archive"), act("spam", "Spam"), act("new", "Mark unread")) : null);
  };
  const list = h("ul", { class: "list card", style: { padding: "4px 16px" } }, r.data.length ? r.data.map((m) => h("li", null,
    can("messages:update") ? h("input", { type: "checkbox", dataset: { id: m.id }, "aria-label": `Select message from ${m.email}` }) : null,
    h("button", { class: "btn btn--ghost", type: "button", style: { flex: 1, justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal", minWidth: 0 }, onclick: () => open(m) },
      h("span", { class: ["dot", m.status === "new" && "dot--warn"] }), h("span", { class: "grow" }, h("b", null, m.name || m.email), ` — ${m.topic || ""}`, h("span", { class: "sub muted small", style: { display: "block" } }, m.preview))),
    h("span", { class: "tiny muted" }, ago(m.created_at)))) : h("li", null, h("span", { class: "muted" }, "Nothing here.")));
  return h("div", null, pageHead("Messages", "From the contact form on the website (rate-limited and bot-filtered)."),
    h("div", { class: "toolbar" }, seg([["inbox", `Inbox (${(c.new || 0) + (c.read || 0)})`], ["new", `Unread (${c.new || 0})`], ["archived", `Archived (${c.archived || 0})`], ["spam", `Spam (${c.spam || 0})`], ["all", "All"]], status, (v) => go(`/admin/messages?status=${v}`, { replace: true })),
      can("messages:update") ? h("span", { class: "row" }, h("button", { class: "btn btn--sm", type: "button", onclick: () => bulk("mark_read") }, "Mark read"), h("button", { class: "btn btn--sm", type: "button", onclick: () => bulk("archive") }, "Archive"), h("button", { class: "btn btn--sm", type: "button", onclick: () => bulk("spam") }, "Spam"),
        can("messages:delete") ? h("button", { class: "btn btn--sm btn--danger", type: "button", onclick: () => bulk("delete") }, icon("trash"), "Delete") : null) : null),
    h("div", { class: "grid g2" }, list, detail));
}

import { h, api, pageHead, statusBadge, toast, errMsg, can, diffView, fmtDate, seg, confirmDialog, actionLabel, jsonBlock } from "../ui.js";

export default async function approvals({ go, query }) {
  const status = query.get("status") || "pending";
  const { data } = await api("GET", "/approvals", { query: { status } });
  const decide = async (a, approve) => {
    const ok = await confirmDialog({ title: approve ? "Approve and run this request?" : "Reject this request?", body: approve ? `It runs now as API key ${a.requested_by.apiKeyName || a.api_key_id} and is recorded with you as approver.` : "The agent is told it was rejected.", ok: approve ? "Approve & run" : "Reject", danger: !approve, reason: true });
    if (!ok) return;
    try { const r = await api("POST", `/approvals/${a.id}/${approve ? "approve" : "reject"}`, { body: { note: ok.reason || undefined } }); toast(r.data.status === "failed" ? `Ran but failed: ${r.data.result?.error?.message}` : `Request ${r.data.status}`, r.data.status === "failed" ? "bad" : "ok"); go(location.pathname + location.search, { replace: true }); } catch (e) { toast(errMsg(e), "bad"); }
  };
  return h("div", null, pageHead("Approvals", "API keys marked “require approval” can't delete, publish or change access on their own — their requests wait here for a human."),
    h("div", { class: "toolbar" }, seg([["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"], ["failed", "Failed"], ["all", "All"]], status, (v) => go(`/admin/approvals?status=${v}`, { replace: true }))),
    data.length ? h("div", { class: "stack" }, data.map((a) => h("div", { class: "card" },
      h("div", { class: "card__head" }, h("div", null, h("h2", null, actionLabel(a.operation)), h("p", { class: "small muted" }, h("span", { class: `method method--${a.method}` }, a.method), " ", h("code", null, a.path), ` · requested by ${a.requested_by.name || "?"} via key “${a.requested_by.apiKeyName}” ${a.requested_by.apiKeyId ? "" : ""}· ${fmtDate(a.created_at)}`)), statusBadge(a.status)),
      a.reason ? h("div", { class: "banner banner--info" }, `Reason given: ${a.reason}`) : null,
      h("h3", null, "What would change"), (a.preview || []).length ? a.preview.map((p) => h("div", { class: "stack" }, h("p", { class: "small" }, h("b", null, actionLabel(p.action)), ` ${p.label || p.resource_id || ""}`), diffView(p.changes))) : h("p", { class: "muted" }, "No preview."),
      a.body && Object.keys(a.body).length ? h("details", null, h("summary", null, "Request body"), jsonBlock(a.body)) : null,
      a.decided_by ? h("p", { class: "small muted" }, `${a.status} by ${a.decided_by.name} · ${fmtDate(a.decided_at)}${a.decision_note ? ` · “${a.decision_note}”` : ""}`) : null,
      a.status === "pending" && can("approvals:manage") ? h("div", { class: "actions" }, h("button", { class: "btn btn--primary", type: "button", onclick: () => decide(a, true) }, "Approve & run"), h("button", { class: "btn btn--danger", type: "button", onclick: () => decide(a, false) }, "Reject")) : null))) : h("div", { class: "card empty" }, h("img", { src: "/assets/mark.svg", alt: "" }), status === "pending" ? "Nothing waiting for approval." : "Nothing here."));
}

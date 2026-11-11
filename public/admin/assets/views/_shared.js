/* Shared view pieces: per-resource history (audit + revisions with restore), dry-run preview, save helpers. */
import { h, api, diffView, fmtDate, ago, statusBadge, actionLabel, confirmDialog, toast, errMsg, can, dialog } from "../ui.js";

/** "Who changed this and when" tab: audit entries with field diffs + one-click restore of any saved version. */
export function historyPanel({ base, perm, onRestored }) {
  const box = h("div", { class: "stack" }, h("p", { class: "muted" }, "Loading history…"));
  (async () => {
    try {
      const [hist, revs] = await Promise.all([api("GET", `${base}/history`), api("GET", `${base}/revisions`)]);
      const list = h("ul", { class: "timeline card", style: { padding: 0 } }, hist.data.length ? hist.data.map((e) => h("li", { onclick: () => entryDialog(e) },
        h("time", null, fmtDate(e.ts)), h("div", { class: "what" }, h("b", null, e.api_key_name ? `${e.actor_name} via key “${e.api_key_name}”` : e.actor_name || e.actor_type), " ", actionLabel(e.action),
          h("div", { class: "meta" }, h("span", null, `${(e.changes || []).length} field(s)`), e.source ? h("span", null, e.source) : null, e.reason ? h("span", null, `“${e.reason}”`) : null)), statusBadge(e.result))) : h("li", null, h("span", { class: "muted" }, "No changes recorded yet.")));
      const rv = h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, h("th", null, "Version"), h("th", null, "Saved"), h("th", null, "By"), h("th", null, ""))),
        h("tbody", null, revs.data.map((r, i) => h("tr", null, h("td", null, `v${r.version}`, r.deleted ? " (trashed)" : "", i === 0 ? h("span", { class: "badge badge--ok", style: { marginLeft: "6px" } }, "current") : null), h("td", null, ago(r.created_at)), h("td", null, r.actor),
          h("td", { class: "num" }, i > 0 && can(perm) ? h("button", { class: "btn btn--sm", type: "button", onclick: async () => {
            const ok = await confirmDialog({ title: `Restore version ${r.version}?`, body: "A new version is saved with the old content. This is audited, and you can undo it the same way.", ok: "Restore", reason: true });
            if (!ok) return;
            try { await api("POST", `${base}/revisions/${r.version}/restore`, { reason: ok.reason }); toast(`Restored v${r.version}`, "ok"); onRestored?.(); } catch (x) { toast(errMsg(x), "bad"); }
          } }, "Restore") : null))))));
      box.replaceChildren(h("h3", null, "Change history"), list, h("h3", null, "Saved versions"), rv);
    } catch (e) { box.replaceChildren(h("div", { class: "banner banner--bad" }, errMsg(e))); }
  })();
  return box;
}

export function entryDialog(e) {
  return dialog(() => h("div", { class: "stack" }, h("h2", null, actionLabel(e.action)),
    h("p", { class: "muted" }, `${fmtDate(e.ts)} · ${e.api_key_name ? `${e.actor_name} via API key “${e.api_key_name}”` : e.actor_name || e.actor_type} · ${e.source || ""} · ${e.ip || ""} ${e.country || ""}`),
    e.reason ? h("div", { class: "banner banner--info" }, `Reason: ${e.reason}`) : null, diffView(e.changes)), { wide: true, label: "Change details" });
}

/** Show what a save would change (X-Dry-Run) before doing it. */
export async function previewChanges(method, path, body, opts = {}) {
  try {
    const r = await api(method, path, { body, dryRun: true, ...opts });
    const changes = (r.meta?.would_change || []).flatMap((c) => c.changes || []);
    return dialog((close) => h("div", { class: "stack" }, h("h2", null, "Preview changes"), h("p", { class: "muted" }, "Dry run — nothing was saved. This is exactly what the audit log will record."),
      diffView(changes), r.meta?.would_emit?.length ? h("p", { class: "small muted" }, `Webhooks: ${r.meta.would_emit.join(", ")}`) : null,
      h("div", { class: "actions actions--end" }, h("button", { class: "btn", type: "button", onclick: () => close(false) }, "Keep editing"), h("button", { class: "btn btn--primary", type: "button", onclick: () => close(true) }, "Save now"))), { wide: true, label: "Preview" });
  } catch (x) { toast(errMsg(x), "bad"); return false; }
}

/** Parse "one per line" textareas. */
export const lines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
export const paras = (s) => String(s || "").split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);

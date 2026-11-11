import { h, api, pageHead, statusBadge, field, input, select, toast, errMsg, diffView, fmtDate, kv, jsonBlock, download, actionLabel, debounce, toggle, can, $ } from "../ui.js";

const FILTERS = ["q", "actor_id", "actor_type", "api_key_id", "agent", "action", "resource_type", "resource_id", "result", "ip", "from", "to"];

export default async function audit({ query, go }) {
  const f = Object.fromEntries(FILTERS.map((k) => [k, query.get(k) || ""]));
  const list = h("ul", { class: "timeline" });
  const wrap = h("div", { class: "card", style: { padding: 0 } }, list);
  const more = h("button", { class: "btn", type: "button", hidden: true }, "Load older");
  const verifyBox = h("div");
  let cursor = null, latest = 0, live = null;
  const params = () => Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  const row = (e) => h("li", { class: e.parent_id ? "child" : "", onclick: () => openEntry(e.id), tabindex: 0, onkeydown: (ev) => ev.key === "Enter" && openEntry(e.id) },
    h("time", { datetime: e.ts }, fmtDate(e.ts)),
    h("div", { class: "what" }, h("div", null, h("b", null, e.actor_type === "api_key" ? `${e.actor_name || "?"} · key “${e.api_key_name}”` : e.actor_name || e.actor_email || e.actor_type), " ", h("span", { class: "chip" }, e.action), e.resource_label ? ` ${e.resource_label}` : ""),
      h("div", { class: "meta" }, e.changes?.length ? h("span", null, `${e.changes.length} field change(s): ${e.changes.slice(0, 3).map((c) => c.path).join(", ")}${e.changes.length > 3 ? "…" : ""}`) : null,
        h("span", null, e.source), e.ip ? h("span", null, `${e.ip}${e.country ? ` · ${e.country}` : ""}`) : null, e.device ? h("span", { class: "hide-sm" }, e.device) : null,
        e.result_reason ? h("span", null, `— ${e.result_reason}`) : null, e.reason ? h("span", null, `“${e.reason}”`) : null)),
    statusBadge(e.result));
  async function load(reset = true) {
    try {
      const r = await api("GET", "/audit", { query: { ...params(), limit: 60, cursor: reset ? undefined : cursor } });
      if (reset) list.replaceChildren();
      r.data.forEach((e) => list.append(row(e)));
      if (reset && !r.data.length) list.append(h("li", null, h("span", { class: "muted" }, "No matching entries.")));
      cursor = r.meta.next_cursor; more.hidden = !cursor; latest = Math.max(latest, r.meta.latest_seq || 0);
    } catch (e) { list.replaceChildren(h("li", null, h("span", { class: "form-error" }, errMsg(e)))); }
  }
  async function poll() {
    if (!document.body.contains(list)) { clearInterval(live); return; }
    const r = await api("GET", "/audit", { query: { ...params(), after_seq: latest, limit: 100 } }).catch(() => null);
    if (!r?.data.length) return;
    latest = r.meta.latest_seq;
    r.data.reverse().forEach((e) => { const li = row(e); li.style.background = "var(--warn-bg)"; list.prepend(li); });
  }
  more.addEventListener("click", () => load(false));
  const apply = () => go(`/admin/audit?${new URLSearchParams(params())}`, { replace: true });
  const set = (k) => (e) => { f[k] = e.target.value.trim(); };
  const bar = h("form", { class: "toolbar", onsubmit: (e) => { e.preventDefault(); apply(); } },
    input("q", f.q, { type: "search", placeholder: "Search action, resource, person, key, reason…", "aria-label": "Search", oninput: set("q") }),
    select("actor_type", [["", "Any actor"], ["user", "People"], ["api_key", "API keys"], ["system", "System"], ["anonymous", "Anonymous"]], f.actor_type, { "aria-label": "Actor type", onchange: (e) => { set("actor_type")(e); apply(); } }),
    select("result", [["", "Any result"], ["success", "Success"], ["denied", "Denied"], ["error", "Error"], ["dry_run", "Dry run"], ["pending_approval", "Pending approval"]], f.result, { "aria-label": "Result", onchange: (e) => { set("result")(e); apply(); } }),
    select("resource_type", [["", "Any resource"], ...["game", "news", "team_member", "page", "settings", "media", "message", "user", "role", "api_key", "approval", "webhook", "system", "audit", "analytics", "content", "session"].map((x) => [x, x])], f.resource_type, { "aria-label": "Resource", onchange: (e) => { set("resource_type")(e); apply(); } }),
    input("action", f.action, { placeholder: "action e.g. game.*", "aria-label": "Action", oninput: set("action"), style: { maxWidth: "160px" } }),
    input("ip", f.ip, { placeholder: "IP", "aria-label": "IP address", oninput: set("ip"), style: { maxWidth: "130px" } }),
    input("from", f.from, { type: "date", "aria-label": "From", onchange: (e) => { set("from")(e); apply(); } }), input("to", f.to, { type: "date", "aria-label": "To", onchange: (e) => { set("to")(e); apply(); } }),
    h("button", { class: "btn btn--primary btn--sm" }, "Filter"),
    Object.values(params()).length ? h("a", { class: "btn btn--ghost btn--sm", href: "/admin/audit" }, "Clear") : null);
  const scoped = ["actor_id", "api_key_id", "agent", "resource_id"].filter((k) => f[k]).map((k) => h("span", { class: "chip" }, `${k} = ${f[k]}`));
  const verify = async () => {
    verifyBox.replaceChildren(h("div", { class: "banner banner--info" }, "Verifying the hash chain…"));
    try { const r = (await api("GET", "/audit/verify")).data; verifyBox.replaceChildren(h("div", { class: ["banner", r.ok ? "banner--ok" : "banner--bad"], "data-verify": r.ok ? "ok" : "broken" }, r.ok ? `Chain verified ✓ — ${r.checked} entries, every HMAC and link intact. Head ${r.head_hash.slice(0, 16)}…` : `Chain BROKEN at #${r.broken_at.seq}: ${r.broken_at.reason}`)); }
    catch (e) { verifyBox.replaceChildren(h("div", { class: "banner banner--bad" }, errMsg(e))); }
  };
  const exp = (format) => download("/audit/export", { ...params(), format }, `audit.${format}`).then(() => toast("Exported (the export is itself logged)", "ok")).catch((e) => toast(errMsg(e), "bad"));
  const liveT = toggle("live", false, "Live", { onchange: (e) => { clearInterval(live); if (e.target.checked) live = setInterval(poll, 4000); } });
  await load();
  return h("div", null, pageHead("Audit log", "Every change, sign-in, denied attempt and API call that writes — who, what (field by field), from where and why. Append-only and hash-chained.",
    h("button", { class: "btn", type: "button", onclick: verify }, "Verify integrity"), h("button", { class: "btn", type: "button", onclick: () => exp("csv") }, "Export CSV"), h("button", { class: "btn", type: "button", onclick: () => exp("json") }, "Export JSON"), liveT),
    verifyBox, bar, scoped.length ? h("div", { class: "row", style: { marginBottom: "10px" } }, h("span", { class: "small muted" }, "Showing only:"), scoped) : null, wrap, h("div", { class: "row", style: { marginTop: "12px" } }, more));
}

async function openEntry(id) {
  const e = (await api("GET", `/audit/${id}`)).data;
  const scrim = h("div", { class: "scrim", onclick: () => close() });
  const close = () => { drawer.classList.remove("open"); scrim.remove(); setTimeout(() => drawer.remove(), 250); };
  const drawer = h("aside", { class: "drawer", role: "dialog", "aria-label": "Audit entry", tabindex: -1, onkeydown: (ev) => ev.key === "Escape" && close() },
    h("div", { class: "row row--between" }, h("h2", { style: { margin: 0 } }, actionLabel(e.action)), h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: close, "aria-label": "Close" }, "✕")),
    h("p", { class: "muted" }, fmtDate(e.ts), " · ", statusBadge(e.result), e.result_reason ? ` ${e.result_reason}` : ""),
    e.reason ? h("div", { class: "banner banner--info" }, `Reason: ${e.reason}`) : null,
    h("h3", null, "Field changes"), diffView(e.changes),
    h("h3", { style: { marginTop: "18px" } }, "Who · from where"),
    kv([["Actor", `${e.actor_name || "—"} (${e.actor_type})`], ["Email", e.actor_email], ["Role at the time", e.actor_role], ["API key", e.api_key_name ? `${e.api_key_name} (${e.api_key_id})` : null], ["Session", e.session_id],
      ["Source", e.source], ["IP", e.ip], ["Location", [e.city, e.country].filter(Boolean).join(", ")], ["Device", e.device], ["User agent", e.user_agent], ["Request", e.method ? `${e.method} ${e.route}` : null], ["Request id", e.request_id],
      ["Resource", e.resource_type ? `${e.resource_type} · ${e.resource_id || ""} ${e.resource_label ? `· ${e.resource_label}` : ""}` : null], ["Parent entry", e.parent_id]]),
    e.children?.length ? [h("h3", { style: { marginTop: "18px" } }, `${e.children.length} child entries (bulk)`), h("ul", { class: "list" }, e.children.map((c) => h("li", null, h("span", { class: "chip" }, c.action), h("span", { class: "grow" }, c.resource_label || c.resource_id), statusBadge(c.result))))] : null,
    e.before ? [h("h3", { style: { marginTop: "18px" } }, "Before"), jsonBlock(e.before)] : null, e.after ? [h("h3", null, "After"), jsonBlock(e.after)] : null,
    e.meta ? [h("h3", null, "Details"), jsonBlock(e.meta)] : null,
    h("h3", { style: { marginTop: "18px" } }, "Tamper evidence"), kv([["Sequence", `#${e.seq}`], ["Previous hash", h("span", { class: "hash" }, e.prev_hash)], ["Entry hash", h("span", { class: "hash" }, e.hash)]]));
  document.body.append(scrim, drawer);
  requestAnimationFrame(() => { drawer.classList.add("open"); drawer.focus(); });
}

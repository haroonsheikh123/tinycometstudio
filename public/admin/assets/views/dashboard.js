import { h, api, pageHead, lineChart, barList, fmtNum, ago, statusBadge, can, actionLabel, icon, state } from "../ui.js";

function kpi(label, cur, prev, accent) {
  const d = prev ? (cur - prev) / prev : null;
  return h("div", { class: "card kpi", style: { "--accent": accent } }, h("div", { class: "kpi__label" }, label), h("div", { class: "kpi__value" }, fmtNum(cur || 0)),
    h("div", { class: ["kpi__delta", d > 0 ? "up" : d < 0 ? "down" : ""] }, d == null ? (cur ? "new this week" : "no data yet") : `${d >= 0 ? "▲" : "▼"} ${Math.abs(d * 100).toFixed(0)}% vs previous 7 days`));
}

export default async function dashboard() {
  const { data: d } = await api("GET", "/dashboard");
  const hello = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening";
  const out = [pageHead(`${hello}, ${state.me.user.name.split(" ")[0]}`, "Here's what's happening across Tiny Comet Studio.",
    can("news:create") ? h("a", { class: "btn btn--accent", href: "/admin/news/new" }, icon("plus"), "New post") : null,
    h("a", { class: "btn", href: "/", target: "_blank", rel: "noopener" }, icon("external"), "View site"))];
  if (d.system?.kill_switch) out.push(h("div", { class: "banner banner--bad" }, "API kill switch is ON — every API key is blocked.", h("a", { class: "btn btn--sm", href: "/admin/system" }, "Manage")));
  if (d.system?.maintenance) out.push(h("div", { class: "banner banner--warn" }, "Maintenance mode is ON — visitors see the 'back soon' page.", h("a", { class: "btn btn--sm", href: "/admin/system" }, "Manage")));
  if (d.pending_approvals) out.push(h("div", { class: "banner banner--info" }, `${d.pending_approvals} API request(s) are waiting for your approval.`, h("a", { class: "btn btn--sm", href: "/admin/approvals" }, "Review")));
  if (d.analytics) {
    const a = d.analytics;
    out.push(h("div", { class: "grid g4" },
      kpi("Visitors · 7 days", a.last7.visitors, a.prev7.visitors, "#FFE07A"), kpi("Page views · 7 days", a.last7.page_view, a.prev7.page_view, "#FF9A3C"),
      kpi("Store clicks", a.last7.store_click, a.prev7.store_click, "#FF5E6E"), kpi("Play starts / unlocks", (a.last7.play_click || 0), a.prev7.play_click, "#8B5CF6")));
    out.push(h("div", { class: "grid g-main", style: { marginTop: "16px" } },
      h("div", { class: "card" }, h("div", { class: "card__head" }, h("h2", null, "Traffic · last 30 days"), h("div", { class: "chart-legend" }, h("span", null, h("i"), "Page views"), h("span", null, h("i", { class: "l2" }), "Visitors"))),
        lineChart(a.series, { key: "page_views", key2: "visitors", label: "Page views and visitors over 30 days" }),
        h("p", { class: "small muted", style: { marginTop: "8px" } }, h("span", { class: "dot dot--ok" }), ` ${a.realtime} visitor(s) on the site right now · today: ${fmtNum(a.today.page_view || 0)} views, ${fmtNum(a.today.play_unlocked || 0)} captcha passes`)),
      h("div", { class: "stack" }, h("div", { class: "card" }, h("h2", null, "Top pages"), barList(a.top_pages)), h("div", { class: "card" }, h("h2", null, "Top games"), barList(a.top_games)))));
  }
  const row = [];
  if (d.messages) row.push(h("div", { class: "card" }, h("div", { class: "card__head" }, h("h2", null, "Latest messages ", d.messages.unread ? h("span", { class: "badge badge--info" }, `${d.messages.unread} new`) : null), h("a", { class: "btn btn--sm", href: "/admin/messages" }, "Inbox")),
    d.messages.latest.length ? h("ul", { class: "list" }, d.messages.latest.map((m) => h("li", null, h("span", { class: ["dot", m.status === "new" && "dot--warn"] }), h("span", { class: "grow" }, h("b", null, m.name || m.email), " — ", m.preview), h("span", { class: "tiny muted" }, ago(m.created_at))))) : h("p", { class: "muted" }, "No messages yet.")));
  if (d.activity) row.push(h("div", { class: "card" }, h("div", { class: "card__head" }, h("h2", null, "Recent activity"), h("a", { class: "btn btn--sm", href: "/admin/audit" }, "Audit log")),
    h("ul", { class: "list" }, d.activity.map((e) => h("li", null, statusBadge(e.result), h("span", { class: "grow" }, h("b", null, e.api_key_name ? `${e.actor_name || "?"} (key ${e.api_key_name})` : e.actor_name || e.actor_type), " ", actionLabel(e.action), e.label ? ` · ${e.label}` : ""), h("span", { class: "tiny muted" }, ago(e.ts)))))));
  if (row.length) out.push(h("div", { class: `grid ${row.length > 1 ? "g2" : ""}`, style: { marginTop: "16px" } }, row));
  const counts = (list) => (list || []).map((x) => h("span", { class: "row" }, statusBadge(x.status), h("b", null, x.n)));
  if (d.games || d.news) out.push(h("div", { class: "grid g2", style: { marginTop: "16px" } },
    d.games ? h("div", { class: "card" }, h("div", { class: "card__head" }, h("h2", null, "Games & apps"), h("a", { class: "btn btn--sm", href: "/admin/games" }, "Manage")), h("div", { class: "row" }, counts(d.games))) : null,
    d.news ? h("div", { class: "card" }, h("div", { class: "card__head" }, h("h2", null, "Newsroom"), h("a", { class: "btn btn--sm", href: "/admin/news" }, "Manage")), h("div", { class: "row" }, counts(d.news))) : null));
  return h("div", null, out);
}

import { h, api, pageHead, lineChart, barList, fmtNum, fmtPct, seg, select, download, toast, can, field, input, errMsg } from "../ui.js";

const EVENTS = [["page_view", "Page views"], ["store_click", "Store clicks"], ["play_click", "Play clicks"], ["play_unlocked", "Captcha passed"], ["news_read", "News reads"], ["share_click", "Shares"], ["contact_open", "Contact opens"]];
const DIMS = [["path", "Page"], ["game", "Game"], ["country", "Country"], ["device", "Device"], ["browser", "Browser"], ["os", "OS"], ["referrer", "Referrer"], ["platform", "Store"]];
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

export default async function analytics() {
  const st = { days: 30, event: "page_view", dim: "path", from: null, to: null };
  const root = h("div");
  const body = h("div", { class: "stack" });
  const range = () => (st.from ? { from: st.from, to: st.to } : { from: day(Date.now() - (st.days - 1) * 86_400_000), to: day(Date.now()) });
  const from = input("from", "", { type: "date", "aria-label": "From" }), to = input("to", "", { type: "date", "aria-label": "To" });
  const custom = h("span", { class: "row" }, from, to, h("button", { class: "btn btn--sm", type: "button", onclick: () => { if (from.value && to.value) { st.from = from.value; st.to = to.value; load(); } } }, "Apply"));
  const evSel = select("event", EVENTS, st.event, { "aria-label": "Event", onchange: (e) => { st.event = e.target.value; load(); } });
  const toolbar = h("div", { class: "toolbar" }, seg([[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "1 year"]], 30, (v) => { st.days = v; st.from = null; load(); }), custom, evSel);
  let timer;
  async function load() {
    const r = range();
    body.replaceChildren(h("div", { class: "card empty" }, "Loading…"));
    try {
      const [sum, ts, vis, br, fun, rt] = await Promise.all([
        api("GET", "/analytics/summary", { query: r }), api("GET", "/analytics/timeseries", { query: { ...r, event: st.event } }),
        api("GET", "/analytics/timeseries", { query: { ...r, metric: "visitors" } }), api("GET", "/analytics/breakdown", { query: { ...r, event: st.event, dimension: st.dim, limit: 12 } }),
        api("GET", "/analytics/funnel", { query: r }), api("GET", "/analytics/realtime")
      ]);
      const t = sum.data.totals, p = sum.data.previous;
      const series = ts.data.points.map((x, i) => ({ t: x.t, value: x.value, visitors: vis.data.points[i]?.value || 0 }));
      const delta = (a, b) => (b ? `${a >= b ? "▲" : "▼"} ${Math.abs(((a - b) / b) * 100).toFixed(0)}%` : "—");
      const brBox = h("div");
      const showBr = (rows) => brBox.replaceChildren(barList(rows, { label: (x) => x.key || "(direct)" }));
      showBr(br.data.rows);
      body.replaceChildren(
        h("div", { class: "grid g4" }, [["Visitors", "visitors"], ["Page views", "page_view"], ["Store clicks", "store_click"], ["Captcha passes", "play_unlocked"]].map(([l, k]) =>
          h("div", { class: "card kpi" }, h("div", { class: "kpi__label" }, l), h("div", { class: "kpi__value" }, fmtNum(t[k])), h("div", { class: ["kpi__delta", t[k] >= p[k] ? "up" : "down"] }, `${delta(t[k], p[k])} vs previous period`)))),
        h("div", { class: "card" }, h("div", { class: "card__head" }, h("h2", null, EVENTS.find((e) => e[0] === st.event)[1]), h("div", { class: "chart-legend" }, h("span", null, h("i"), "Events"), h("span", null, h("i", { class: "l2" }), "Visitors"))), lineChart(series, { key: "value", key2: "visitors", label: "Event time series" })),
        h("div", { class: "grid g2" },
          h("div", { class: "card" }, h("div", { class: "card__head" }, h("h2", null, "Breakdown"), seg(DIMS, st.dim, async (v) => { st.dim = v; showBr((await api("GET", "/analytics/breakdown", { query: { ...range(), event: st.event, dimension: v, limit: 12 } })).data.rows); })), brBox),
          h("div", { class: "card" }, h("h2", null, "Funnel per game"), h("p", { class: "small muted" }, "Distinct visitors: game page → store click / play → captcha passed"),
            fun.data.games.length ? fun.data.games.map((g) => h("div", { class: "funnel", style: { marginBottom: "16px" } }, h("b", null, g.game),
              [["Viewed page", g.page_view], ["Clicked a store", g.store_click], ["Clicked play", g.play_click], ["Passed captcha", g.play_unlocked]].map(([l, v]) =>
                h("div", { class: "funnel__row" }, h("span", null, l), h("div", { class: "funnel__bar" }, h("i", { style: { width: `${g.page_view ? (v / g.page_view) * 100 : 0}%` } })), h("b", { class: "num" }, fmtNum(v)))),
              h("p", { class: "tiny muted" }, `Store rate ${fmtPct(g.store_rate)} · Play rate ${fmtPct(g.play_rate)} · Unlock rate ${fmtPct(g.unlock_rate)}`))) : h("p", { class: "muted" }, "No game traffic in this range yet."))),
        h("div", { class: "grid g2" },
          h("div", { class: "card" }, h("div", { class: "card__head" }, h("h2", null, "Real time"), h("span", { class: "badge badge--ok" }, `${rt.data.active_visitors} active now`)), lineChart(rt.data.per_minute, { height: 140, label: "Events per minute, last 30 minutes" }),
            h("ul", { class: "list" }, rt.data.latest.slice(0, 6).map((e) => h("li", null, h("span", { class: "chip" }, e.event), h("span", { class: "grow" }, e.path || e.game), h("span", { class: "tiny muted" }, `${e.country || "?"} · ${e.device}`))))),
          h("div", { class: "card" }, h("h2", null, "Where visitors come from"), h("div", { class: "grid g2" }, h("div", null, h("h3", null, "Countries"), barList(sum.data.top_countries)), h("div", null, h("h3", null, "Referrers"), barList(sum.data.top_referrers, { empty: "Mostly direct visits" })))))
      );
    } catch (e) { body.replaceChildren(h("div", { class: "banner banner--bad" }, errMsg(e))); }
  }
  const exp = (format, kind) => download("/analytics/export", { ...range(), format, kind }, `analytics-${kind}.${format}`).then(() => toast("Export ready (logged in the audit log)", "ok")).catch((e) => toast(errMsg(e), "bad"));
  root.append(pageHead("Analytics", "Cookie-free and privacy-first: no IP addresses are stored, unique visitors use a hash with a salt that changes daily.",
    h("button", { class: "btn", type: "button", onclick: () => exp("csv", "daily") }, "Export CSV"), h("button", { class: "btn", type: "button", onclick: () => exp("json", "events") }, "Export events JSON"),
    can("analytics:manage") ? h("button", { class: "btn", type: "button", onclick: retention }, "Retention") : null), toolbar, body);
  load();
  timer = setInterval(() => { if (!document.body.contains(root)) clearInterval(timer); }, 15000);
  return root;
}
async function retention() {
  const cur = (await api("GET", "/analytics/retention")).data.days;
  const { dialog } = await import("../ui.js");
  dialog((close) => {
    const days = input("days", String(cur), { type: "number", min: 0, max: 3650 });
    return h("form", { class: "stack", onsubmit: async (e) => { e.preventDefault(); try { await api("PUT", "/analytics/retention", { body: { days: Number(days.value) } }); toast("Saved", "ok"); close(); } catch (x) { toast(errMsg(x), "bad"); } } },
      h("h2", null, "Analytics retention"), field("Keep data for (days)", days, "0 = forever. Older rows are deleted automatically."), h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary" }, "Save")));
  });
}

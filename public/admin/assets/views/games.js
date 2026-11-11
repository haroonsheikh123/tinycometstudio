import { h, api, pageHead, table, statusBadge, field, input, textarea, select, checkbox, toggle, tabs, toast, errMsg, can, confirmDialog, icon, formData, reasonField, fmtBytes, fmtDate, busy } from "../ui.js";
import { historyPanel, previewChanges, lines, paras } from "./_shared.js";

const STATUSES = [["coming-soon", "Coming soon"], ["in-development", "In development"], ["released", "Released / out now"]];
const PLATFORMS = ["android", "ios", "steam", "itch", "web"];

export default async function games({ param, go }) {
  if (param) return editor(param, go);
  const { data } = await api("GET", "/games");
  let order = data.map((g) => g.id);
  const move = async (id, dir) => {
    const i = order.indexOf(id), j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    try { await api("PUT", "/games/order", { body: { ids: order } }); toast("Order saved", "ok"); go("/admin/games", { replace: true }); } catch (e) { toast(errMsg(e), "bad"); }
  };
  return h("div", null,
    pageHead("Games & apps", "Everything shown on the home page and at /<id>/. Order here = order on the site.", can("games:create") ? h("a", { class: "btn btn--accent", href: "/admin/games/new" }, icon("plus"), "New game") : null),
    table([
      { label: "", render: (g) => h("span", { class: "swatch", style: { background: `linear-gradient(135deg, ${(g.colors || ["#FFE07A", "#FF9A3C"])[0]}, ${(g.colors || ["#FFE07A", "#FF9A3C"])[1] || "#FF9A3C"})` } }), hideSm: true },
      { label: "Title", render: (g) => h("div", null, h("span", { class: "cell-title" }, g.title), g.placeholder ? h("span", { class: "badge", style: { marginLeft: "6px" } }, "sample") : null, h("span", { class: "sub" }, `/${g.id}/ · ${g.kind || "Game"}`)) },
      { label: "Status", render: (g) => statusBadge(g.status) },
      { label: "Platforms", render: (g) => (g.platforms || []).join(", "), hideSm: true },
      { label: "Web play", render: (g) => (g.webPlay?.enabled ? h("span", { class: "badge badge--ok" }, g.build ? "on · R2 build" : "on") : h("span", { class: "badge" }, "off")), hideSm: true },
      { label: "Updated", render: (g) => h("span", { class: "small muted" }, fmtDate(g._meta.updated_at)), hideSm: true },
      { label: "", num: true, render: (g) => can("games:update") ? h("span", { class: "row" }, h("button", { class: "btn btn--sm btn--ghost", type: "button", "aria-label": `Move ${g.title} up`, onclick: () => move(g.id, -1) }, icon("up")), h("button", { class: "btn btn--sm btn--ghost", type: "button", "aria-label": `Move ${g.title} down`, onclick: () => move(g.id, 1) }, icon("down"))) : null }
    ], data, { onRow: (g) => go(`/admin/games/${g.id}`), empty: "No games yet — add your first one." }));
}

async function editor(id, go) {
  const isNew = id === "new";
  let g = isNew ? { id: "", title: "", tagline: "", kind: "Game", status: "coming-soon", platforms: [], genres: [], colors: ["#FFE07A", "#FF9A3C"], releaseDate: "", description: [], links: { android: "", ios: "", steam: "", itch: "" }, webPlay: { enabled: false }, cover: "", screenshots: [], trailer: "" } : (await api("GET", `/games/${id}`)).data;
  const etag = isNew ? null : `"v${g._meta.version}"`;
  const canEdit = isNew ? can("games:create") : can("games:update");
  const canPub = can("games:publish");
  const ro = !canEdit;
  const f = h("form", { class: "form form--2", onsubmit: (e) => e.preventDefault() },
    field("Title", input("title", g.title, { required: true, maxlength: 120, readOnly: ro })),
    field("ID (URL slug)", input("id", g.id, { required: true, pattern: "[a-z0-9-]+", readOnly: !isNew }), isNew ? "Lowercase letters, numbers and dashes. Becomes /<id>/ — can't be changed later." : `Lives at /${g.id}/`),
    field("Tagline", input("tagline", g.tagline, { maxlength: 200, readOnly: ro })),
    field("Kind", select("kind", ["Game", "App"], g.kind, { disabled: ro })),
    field("Status", select("status", STATUSES, g.status, { disabled: ro || (!canPub && !isNew) }), !canPub ? "Changing status needs the games:publish permission" : null),
    field("Release date", input("releaseDate", g.releaseDate, { placeholder: "YYYY, YYYY-MM or YYYY-MM-DD", readOnly: ro })),
    h("fieldset", { class: "full" }, h("legend", null, "Platforms"), h("div", { class: "row" }, PLATFORMS.map((p) => checkbox(`pf_${p}`, (g.platforms || []).includes(p), p, { disabled: ro })))),
    field("Genres", input("genres", (g.genres || []).join(", "), { readOnly: ro }), "Comma separated"),
    field("Card colours", h("div", { class: "row" }, input("color1", g.colors?.[0] || "#FFE07A", { type: "color", "aria-label": "Colour 1", disabled: ro }), input("color2", g.colors?.[1] || "#FF9A3C", { type: "color", "aria-label": "Colour 2", disabled: ro }))),
    h("div", { class: "full" }, field("Description", textarea("description", [].concat(g.description || []).join("\n\n"), { rows: 7, readOnly: ro }), "Blank line between paragraphs.")),
    field("Cover image", input("cover", g.cover, { placeholder: "/assets/games/<id>/cover.webp or /media/…", readOnly: ro }), "16:9, 1600×900. Pick from Media and paste the URL."),
    field("Trailer (YouTube URL)", input("trailer", g.trailer, { readOnly: ro })),
    h("div", { class: "full" }, field("Screenshots", textarea("screenshots", (g.screenshots || []).map((s) => (typeof s === "string" ? s : `${s.src} | ${s.alt || ""}`)).join("\n"), { rows: 3, class: "code", readOnly: ro }), "One per line: /path/to/image.webp | alt text")),
    h("fieldset", { class: "full" }, h("legend", null, "Store links"), h("div", { class: "form form--2" }, [["android", "Google Play"], ["ios", "App Store"], ["steam", "Steam"], ["itch", "itch.io"]].map(([k, l]) => field(l, input(`link_${k}`, g.links?.[k] || "", { placeholder: "https://… · empty = hidden · # = placeholder", readOnly: ro }))))),
    h("div", { class: "full" }, checkbox("placeholder", !!g.placeholder, "Sample / placeholder entry (shows a 'Sample' tag)", { disabled: ro })),
    canEdit ? h("div", { class: "full" }, reasonField()) : null);
  const collect = () => {
    const d = formData(f);
    const out = {
      title: d.title.trim(), tagline: d.tagline, kind: d.kind, releaseDate: d.releaseDate.trim(), genres: d.genres.split(",").map((s) => s.trim()).filter(Boolean),
      platforms: PLATFORMS.filter((p) => d[`pf_${p}`]), colors: [d.color1, d.color2].map((c, i) => (g.colors?.[i] && g.colors[i].toLowerCase() === c.toLowerCase() ? g.colors[i] : c)), description: paras(d.description), cover: d.cover.trim(), trailer: d.trailer.trim(),
      screenshots: lines(d.screenshots).map((l) => { const [src, alt] = l.split("|").map((s) => s.trim()); return alt ? { src, alt } : src; }),
      links: { android: d.link_android.trim(), ios: d.link_ios.trim(), steam: d.link_steam.trim(), itch: d.link_itch.trim() }, placeholder: d.placeholder
    };
    if (isNew) { out.id = d.id.trim(); out.status = d.status; out.webPlay = { enabled: false }; }
    else if (canPub && d.status !== g.status) out.status = d.status;
    return { body: out, reason: d.reason };
  };
  const save = async (btn) => {
    const { body, reason } = collect();
    busy(btn, true);
    try {
      if (isNew) { const r = await api("POST", "/games", { body, reason }); toast("Game created", "ok"); go(`/admin/games/${r.data.id}`, { replace: true }); }
      else { await api("PATCH", `/games/${id}`, { body, reason, ifMatch: etag }); toast("Saved — the site updates instantly", "ok"); go(`/admin/games/${id}`, { replace: true }); }
    } catch (e) { toast(e.status === 412 ? "Someone else changed this game — reload to see their version." : errMsg(e), "bad"); busy(btn, false); }
  };
  const saveBtn = h("button", { class: "btn btn--primary", type: "button", onclick: (e) => save(e.currentTarget) }, isNew ? "Create game" : "Save changes");
  const actions = canEdit ? h("div", { class: "sticky-actions actions" }, saveBtn,
    !isNew ? h("button", { class: "btn", type: "button", onclick: async () => { const { body, reason } = collect(); if (await previewChanges("PATCH", `/games/${id}`, body, { reason, ifMatch: etag })) save(saveBtn); } }, icon("eye"), "Preview changes") : null,
    h("a", { class: "btn btn--ghost", href: "/admin/games" }, "Cancel"),
    !isNew && can("games:delete") ? h("button", { class: "btn btn--danger", type: "button", style: { marginLeft: "auto" }, onclick: async () => {
      const ok = await confirmDialog({ title: `Move “${g.title}” to the trash?`, body: "Its page disappears from the site. You can restore it from the history.", ok: "Move to trash", danger: true, reason: true });
      if (!ok) return;
      try { await api("DELETE", `/games/${id}`, { reason: ok.reason }); toast("Moved to trash", "ok"); go("/admin/games"); } catch (e) { toast(errMsg(e), "bad"); }
    } }, icon("trash"), "Delete") : null) : h("div", { class: "banner banner--info" }, "You can view this game but not edit it.");

  const panel = h("div");
  const show = (t) => {
    if (t === "details") panel.replaceChildren(h("div", { class: "card" }, f, actions));
    if (t === "play") panel.replaceChildren(playPanel(g, go));
    if (t === "history") panel.replaceChildren(historyPanel({ base: `/games/${id}`, perm: "games:update", onRestored: () => go(`/admin/games/${id}`, { replace: true }) }));
  };
  show("details");
  return h("div", null,
    pageHead(isNew ? "New game" : g.title, isNew ? "Add a game or app to the site." : h("span", null, statusBadge(g.status), " ", h("a", { href: `/${g.id}/`, target: "_blank", rel: "noopener" }, `/${g.id}/`), ` · v${g._meta.version} · updated ${fmtDate(g._meta.updated_at)} by ${g._meta.updated_by || "—"}`)),
    isNew ? null : tabs([["details", "Details"], ["play", "Web play & build"], ["history", "History"]], show, "details"), panel);
}

function playPanel(g, go) {
  const canPub = can("games:publish"), canEdit = can("games:update");
  const sw = toggle("webplay", !!g.webPlay?.enabled, "Play in browser (behind the Turnstile human check)", { disabled: !canPub, onchange: async (e) => {
    try { await api("PUT", `/games/${g.id}/web-play`, { body: { enabled: e.target.checked } }); toast(`Web play ${e.target.checked ? "on" : "off"}`, "ok"); } catch (x) { e.target.checked = !e.target.checked; toast(errMsg(x), "bad"); }
  } });
  const file = h("input", { type: "file", accept: ".zip,application/zip", "aria-label": "Build zip" });
  const up = h("button", { class: "btn btn--primary", type: "button", disabled: !canEdit, onclick: async (e) => {
    if (!file.files[0]) return toast("Choose a .zip first", "bad");
    busy(e.currentTarget, true);
    try { const r = await api("POST", `/games/${g.id}/build`, { raw: file.files[0], headers: { "Content-Type": "application/zip" } }); toast(`Build uploaded: ${r.data.build.files} files`, "ok"); go(`/admin/games/${g.id}`, { replace: true }); }
    catch (x) { toast(errMsg(x), "bad"); busy(e.currentTarget, false); }
  } }, icon("upload"), "Upload build");
  return h("div", { class: "grid g2" },
    h("div", { class: "card" }, h("h2", null, "Web play"), h("p", { class: "muted" }, "Visitors get a friendly human check (Cloudflare Turnstile) before the game loads at ", h("code", null, `/${g.id}/play/`), "."), sw, !canPub ? h("p", { class: "small muted" }, "Needs games:publish.") : null),
    h("div", { class: "card" }, h("h2", null, "Browser build"),
      g.build ? h("div", { class: "banner banner--ok" }, `Live build ${g.build.id}: ${g.build.files} files, ${fmtBytes(g.build.size)}, uploaded ${fmtDate(g.build.uploaded_at)} by ${g.build.uploaded_by}`) : h("p", { class: "muted" }, "No uploaded build — the site serves public/", g.id, "/play/ from the repo if it exists."),
      h("p", { class: "small muted" }, "Upload your HTML5 / WebGL export as a .zip with index.html at the root (Unity, Godot, Phaser… work as-is). Stored in R2."),
      h("div", { class: "row" }, file, up),
      g.build && canEdit ? h("button", { class: "btn btn--danger btn--sm", type: "button", style: { marginTop: "10px" }, onclick: async () => { if (!(await confirmDialog({ title: "Remove the uploaded build?", danger: true, ok: "Remove" }))) return; try { await api("DELETE", `/games/${g.id}/build`); toast("Build removed", "ok"); go(`/admin/games/${g.id}`, { replace: true }); } catch (x) { toast(errMsg(x), "bad"); } } }, "Remove build") : null));
}

/* Admin UI toolkit: DOM builder (no innerHTML for data → XSS-safe), API client (only the public /api/v1),
   dialogs, toasts, tables, forms, SVG charts and the audit diff viewer. */

/* ---------------------------------------------------------------- DOM */
export function h(tag, attrs, ...kids) {
  const svg = ["svg", "path", "g", "rect", "circle", "line", "polyline", "polygon", "text", "defs", "linearGradient", "stop", "title"].includes(tag);
  const el = svg ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "value" && !svg) el.value = v;
    else if (k === "checked" || k === "selected" || k === "disabled" || k === "multiple" || k === "required" || k === "readOnly") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false || k === true) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
export const mount = (el, ...kids) => { clear(el); append(el, kids); return el; };

const ICONS = {
  dashboard: "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z",
  chart: "M4 19h16v2H2V3h2v16zm3-3V9h3v7H7zm5 0V5h3v11h-3zm5 0v-5h3v5h-3z",
  game: "M7 6h10a5 5 0 0 1 5 5v2a5 5 0 0 1-9 3h-2a5 5 0 0 1-9-3v-2a5 5 0 0 1 5-5zm-1 3v2H4v2h2v2h2v-2h2v-2H8V9H6zm9.5 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm3 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2z",
  news: "M4 4h13v14a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2V4zm15 4h2v10a2 2 0 0 1-4 0V8h2zM7 7v3h7V7H7zm0 5v2h7v-2H7zm0 4v2h5v-2H7z",
  image: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 12h14l-4.5-6-3.5 4.5-2.5-3L5 17zm3-7.5A1.5 1.5 0 1 0 8 6.5a1.5 1.5 0 0 0 0 3z",
  team: "M9 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm8 1a3 3 0 1 1 0-6 3 3 0 0 1 0 6zM2 20a7 7 0 0 1 14 0H2zm15.5 0a8.9 8.9 0 0 0-2.3-6A5.5 5.5 0 0 1 22 19v1h-4.5z",
  page: "M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5L14 3.5zM8 12v2h8v-2H8zm0 4v2h8v-2H8z",
  mail: "M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm9 7.2L4.5 7v.3L12 12l7.5-4.7V7L12 12.2z",
  settings: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm8.6 5.4 1.9 1.5-2 3.4-2.3-.8a7.6 7.6 0 0 1-2 1.2l-.4 2.4h-4l-.4-2.4a7.6 7.6 0 0 1-2-1.2l-2.3.8-2-3.4 1.9-1.5a7.8 7.8 0 0 1 0-2.8L1.5 9.1l2-3.4 2.3.8a7.6 7.6 0 0 1 2-1.2L8.2 2.9h4l.4 2.4a7.6 7.6 0 0 1 2 1.2l2.3-.8 2 3.4-1.9 1.5a7.8 7.8 0 0 1 0 2.8z",
  user: "M12 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm-8 9a8 8 0 0 1 16 0H4z",
  shield: "M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3zm-1 13.5 6-6-1.4-1.4L11 12.7 8.4 10.1 7 11.5l4 4z",
  key: "M14 2a8 8 0 0 1 0 16c-.9 0-1.8-.2-2.6-.4L9 20H7v2H2v-5l7.4-7.4A8 8 0 0 1 14 2zm2 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  check: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z",
  hook: "M10 3a4 4 0 0 1 2 7.5V14a2 2 0 1 0 2-2h2a4 4 0 1 1-6 3.5v-5A4 4 0 0 1 10 3zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  log: "M4 4h16v2H4V4zm0 5h16v2H4V9zm0 5h10v2H4v-2zm0 5h10v2H4v-2zm14-5 4 3-4 3v-6z",
  system: "M13 2 3 14h7l-1 8 10-12h-7l1-8z",
  code: "M8.6 16.6 4 12l4.6-4.6L7.2 6 1.2 12l6 6 1.4-1.4zm6.8 0L20 12l-4.6-4.6L16.8 6l6 6-6 6-1.4-1.4z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z",
  menu: "M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z",
  x: "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4L12 13.4 6.4 19 5 17.6 10.6 12 5 6.4 6.4 5z",
  moon: "M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z",
  logout: "M10 3h9a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-9v-2h9V5h-9V3zm-.6 5.4L11 7l5 5-5 5-1.6-1.4L12 13H3v-2h9L9.4 8.4z",
  up: "M7 14l5-5 5 5H7z", down: "M7 10l5 5 5-5H7z",
  copy: "M8 3h11a2 2 0 0 1 2 2v11h-2V5H8V3zM5 7h10a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z",
  download: "M11 3h2v9.2l3.6-3.6L18 10l-6 6-6-6 1.4-1.4 3.6 3.6V3zM4 18h16v2H4v-2z",
  upload: "M11 16V6.8L7.4 10.4 6 9l6-6 6 6-1.4 1.4L13 6.8V16h-2zM4 18h16v2H4v-2z",
  external: "M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
  refresh: "M17.7 6.3A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4l-2.3 2.3z",
  trash: "M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9z",
  eye: "M12 5c5 0 9 4.5 10 7-1 2.5-5 7-10 7S3 14.5 2 12c1-2.5 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"
};
export const icon = (name) => h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", fill: "currentColor" }, h("path", { d: ICONS[name] || ICONS.dashboard }));

/* ---------------------------------------------------------------- format */
export const fmtNum = (n) => (n == null ? "—" : Number(n).toLocaleString("en"));
export const fmtPct = (x) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
export function fmtDate(s, { time = true } = {}) {
  if (!s) return "—";
  const d = new Date(s);
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) });
}
export function ago(s) {
  if (!s) return "never";
  const sec = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  if (sec < 86400 * 30) return `${Math.round(sec / 86400)} d ago`;
  return fmtDate(s, { time: false });
}
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const pretty = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/* ---------------------------------------------------------------- toasts & dialogs */
let toastBox;
export function toast(msg, kind = "") {
  if (!toastBox) document.body.append((toastBox = h("div", { class: "toasts", role: "status", "aria-live": "polite" })));
  const t = h("div", { class: ["toast", kind && `toast--${kind}`] }, msg);
  toastBox.append(t);
  setTimeout(() => t.remove(), kind === "bad" ? 7000 : 3800);
}
export function dialog(build, { wide = false, label = "Dialog" } = {}) {
  return new Promise((resolve) => {
    const d = h("dialog", { class: wide ? "wide" : "", "aria-label": label });
    const close = (v) => { d.close(); d.remove(); resolve(v); };
    const content = build(close);
    d.append(h("div", { class: "dlg" }, h("button", { class: "btn btn--ghost btn--sm dlg__close", type: "button", "aria-label": "Close", onclick: () => close(undefined) }, icon("x")), content));
    d.addEventListener("cancel", (e) => { e.preventDefault(); close(undefined); });
    document.body.append(d);
    d.showModal();
    const f = d.querySelector("input:not([type=hidden]), textarea, select");
    if (f) f.focus();
  });
}
export function confirmDialog({ title, body, ok = "Confirm", danger = false, reason = false }) {
  return dialog((close) => {
    const r = reason ? h("textarea", { rows: 2, placeholder: "Reason (saved in the audit log, optional)", maxlength: 1000 }) : null;
    return h("div", { class: "stack" },
      h("h2", null, title), body ? h("div", { class: "muted" }, body) : null, r,
      h("div", { class: "actions actions--end" },
        h("button", { class: "btn", type: "button", onclick: () => close(false) }, "Cancel"),
        h("button", { class: ["btn", danger ? "btn--danger btn--solid" : "btn--primary"], type: "button", onclick: () => close(reason ? { reason: r.value.trim() } : true) }, ok)));
  }, { label: title });
}
export function secretDialog({ title, intro, secret, extra }) {
  return dialog((close) => h("div", { class: "stack" },
    h("h2", null, title), h("p", { class: "muted" }, intro),
    h("div", { class: "secret-box" }, h("code", { "data-secret": "" }, secret), copyBtn(secret)),
    extra || null,
    h("div", { class: "banner banner--warn" }, "This is the only time it's shown. Store it somewhere safe now."),
    h("div", { class: "actions actions--end" }, h("button", { class: "btn btn--primary", type: "button", onclick: () => close(true) }, "I've saved it"))), { label: title });
}
export const copyBtn = (text, label = "Copy") => h("button", { class: "btn btn--sm", type: "button", onclick: async (e) => {
  try { await navigator.clipboard.writeText(text); toast("Copied", "ok"); } catch { toast("Copy failed — select and copy manually", "bad"); }
  e.currentTarget.blur();
} }, icon("copy"), label);

/* ---------------------------------------------------------------- API client (public /api/v1 only) */
export const state = { me: null, csrf: null, onAuthLost: null };
export class ApiErr extends Error { constructor(status, body) { super(body?.error?.message || `HTTP ${status}`); this.status = status; this.code = body?.error?.code; this.details = body?.error?.details; this.body = body; } }

/** fetch /api/v1 — adds CSRF, handles step-up (asks for a code and retries), dry-run, reasons, If-Match. */
export async function api(method, path, { body, raw, headers = {}, dryRun = false, reason, ifMatch, query, noStepUp = false } = {}) {
  let url = "/api/v1" + path;
  if (query) { const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "")); if ([...q].length) url += "?" + q; }
  const h2 = { Accept: "application/json", ...headers };
  if (method !== "GET" && state.csrf) h2["X-CSRF-Token"] = state.csrf;
  if (dryRun) h2["X-Dry-Run"] = "true";
  if (reason) h2["X-Change-Reason"] = reason.slice(0, 1000);
  if (ifMatch) h2["If-Match"] = ifMatch;
  let init = { method, headers: h2, credentials: "same-origin" };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) { init.body = JSON.stringify(body); h2["Content-Type"] = "application/json"; }
  const res = await fetch(url, init);
  if (res.status === 204) return { data: null, res };
  const ct = res.headers.get("Content-Type") || "";
  const json = ct.includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 403 && json?.error?.code === "step_up_required" && !noStepUp) {
      const ok = await stepUp();
      if (ok) return api(method, path, { body, raw, headers, dryRun, reason, ifMatch, query, noStepUp: true });
    }
    if (res.status === 401 && json?.error?.code === "unauthenticated" && state.onAuthLost) state.onAuthLost();
    throw new ApiErr(res.status, json);
  }
  if (!json) return { data: await res.text(), res };
  return { ...json, res, etag: res.headers.get("ETag") };
}
export async function apiBlob(path, query) {
  const q = query ? "?" + new URLSearchParams(query) : "";
  const res = await fetch("/api/v1" + path + q, { credentials: "same-origin" });
  if (!res.ok) throw new ApiErr(res.status, await res.json().catch(() => null));
  return res;
}
export async function download(path, query, filename) {
  const res = await apiBlob(path, query);
  const blob = await res.blob();
  const a = h("a", { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export function stepUp() {
  return dialog((close) => {
    const input = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 7, pattern: "[0-9 ]*", class: "otp", "aria-label": "6-digit code", required: true });
    const err = h("p", { class: "form-error", role: "alert" });
    const form = h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = "";
      try { await api("POST", "/auth/step-up", { body: { code: input.value.replace(/\s/g, "") }, noStepUp: true }); toast("Confirmed for 10 minutes", "ok"); close(true); }
      catch (x) { err.textContent = x.message; input.select(); }
    } },
      h("h2", null, "Confirm it's you"),
      h("p", { class: "muted" }, "This is a sensitive action. Enter the current 6-digit code from your authenticator app."),
      input, err,
      h("div", { class: "actions actions--end" }, h("button", { class: "btn", type: "button", onclick: () => close(false) }, "Cancel"), h("button", { class: "btn btn--primary" }, "Confirm")));
    return form;
  }, { label: "Confirm with authenticator code" });
}
export function errMsg(e) {
  if (e?.code === "validation_failed" && Array.isArray(e.details) && e.details.length) return `${e.message}`;
  return e?.message || String(e);
}
export const can = (perm) => !!state.me && (state.me.permissions.includes("*") || state.me.permissions.includes(perm));

/* ---------------------------------------------------------------- forms */
let fid = 0;
export function field(label, input, hint) {
  const id = input.id || `f${++fid}`;
  input.id = id;
  return h("label", { class: "field", for: id }, h("span", null, label), input, hint ? h("small", null, hint) : null);
}
export const input = (name, value = "", attrs = {}) => h("input", { type: "text", name, value: value ?? "", ...attrs });
export const textarea = (name, value = "", attrs = {}) => { const t = h("textarea", { name, ...attrs }); t.value = value ?? ""; return t; };
export function select(name, options, value, attrs = {}) {
  return h("select", { name, ...attrs }, options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h("option", { value: v, selected: String(v) === String(value) }, l); }));
}
export const checkbox = (name, checked, label, attrs = {}) => h("label", { class: "check" }, h("input", { type: "checkbox", name, checked, ...attrs }), h("span", null, label));
export const toggle = (name, checked, label, attrs = {}, danger = false) => h("label", { class: ["switch", danger && "switch--danger"] }, h("input", { type: "checkbox", role: "switch", name, checked, ...attrs }), h("span", null, label));
export function busy(btn, on) { if (!btn) return; btn.disabled = on; btn.dataset.busy = on ? "1" : ""; }

/* ---------------------------------------------------------------- tables */
export function table(cols, rows, { onRow, empty = "Nothing here yet." } = {}) {
  if (!rows.length) return h("div", { class: "card empty" }, h("img", { src: "/assets/mark.svg", alt: "" }), empty);
  return h("div", { class: "table-wrap" }, h("table", null,
    h("thead", null, h("tr", null, cols.map((c) => h("th", { class: [c.num && "num", c.hideSm && "hide-sm"], scope: "col" }, c.label)))),
    h("tbody", null, rows.map((r) => h("tr", { class: onRow && "clickable", onclick: onRow ? (e) => { if (!e.target.closest("button, a, input, select")) onRow(r); } : null, tabindex: onRow ? 0 : null, onkeydown: onRow ? (e) => { if (e.key === "Enter" && e.target === e.currentTarget) onRow(r); } : null },
      cols.map((c) => h("td", { class: [c.num && "num", c.hideSm && "hide-sm"] }, c.render ? c.render(r) : r[c.key])))))));
}
export function statusBadge(s) {
  const map = { active: "ok", published: "ok", released: "ok", success: "ok", approved: "ok", new: "info", draft: "", scheduled: "warn", "in-development": "info", "coming-soon": "warn", invited: "warn", pending: "warn", dry_run: "info", pending_approval: "warn", suspended: "bad", revoked: "bad", removed: "bad", denied: "bad", error: "bad", failed: "bad", rejected: "bad", expired: "", disabled: "", archived: "", spam: "bad", read: "" };
  return h("span", { class: ["badge", map[s] !== undefined && map[s] !== "" && `badge--${map[s]}`] }, String(s).replace(/[-_]/g, " "));
}

/* ---------------------------------------------------------------- charts (inline SVG) */
export function lineChart(points, { key = "value", key2, height = 220, label = "" } = {}) {
  const W = 760, H = height, P = { l: 40, r: 10, t: 10, b: 26 };
  const vals = points.map((p) => p[key] || 0), vals2 = key2 ? points.map((p) => p[key2] || 0) : [];
  const max = Math.max(1, ...vals, ...vals2);
  const nice = Math.pow(10, Math.floor(Math.log10(max))) * (max / Math.pow(10, Math.floor(Math.log10(max))) > 5 ? 10 : max / Math.pow(10, Math.floor(Math.log10(max))) > 2 ? 5 : 2);
  const top = Math.max(nice, max);
  const x = (i) => P.l + (points.length < 2 ? 0 : (i * (W - P.l - P.r)) / (points.length - 1));
  const y = (v) => P.t + (H - P.t - P.b) * (1 - v / top);
  const path = (vs) => vs.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  const svg = h("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": label || "Chart" },
    h("defs", null, h("linearGradient", { id: "tcArea", x1: 0, x2: 0, y1: 0, y2: 1 }, h("stop", { offset: "0%", "stop-color": "#FF9A3C", "stop-opacity": ".32" }), h("stop", { offset: "100%", "stop-color": "#FF9A3C", "stop-opacity": "0" }))),
    [0, 0.25, 0.5, 0.75, 1].map((f) => [h("line", { class: "grid-line", x1: P.l, x2: W - P.r, y1: y(top * f), y2: y(top * f) }), h("text", { class: "axis", x: P.l - 8, y: y(top * f) + 4, "text-anchor": "end" }, fmtShort(top * f))]),
    points.map((p, i) => (i % Math.ceil(points.length / 7) === 0 || i === points.length - 1 ? h("text", { class: "axis", x: x(i), y: H - 6, "text-anchor": i === 0 ? "start" : i === points.length - 1 ? "end" : "middle" }, shortLabel(p.t)) : null)),
    points.length ? h("path", { class: "area", d: `${path(vals)}L${x(points.length - 1)} ${y(0)}L${x(0)} ${y(0)}Z` }) : null,
    key2 ? h("path", { class: "line2", d: path(vals2) }) : null,
    h("path", { class: "line", d: path(vals) }));
  const tip = h("div", { class: "chart-tip", hidden: true });
  const dot = h("circle", { class: "hover-dot", r: 5, cx: -10, cy: -10 });
  svg.append(dot);
  const box = h("div", { class: "chart-box" }, svg, tip);
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (points.length - 1))));
    const p = points[i];
    if (!p) return;
    dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(p[key] || 0));
    tip.hidden = false;
    tip.textContent = `${shortLabel(p.t, true)} · ${fmtNum(p[key])}${key2 ? ` / ${fmtNum(p[key2])}` : ""}`;
    tip.style.left = `${(x(i) / W) * 100}%`; tip.style.top = `${(y(p[key] || 0) / H) * 100}%`;
  });
  svg.addEventListener("pointerleave", () => { tip.hidden = true; dot.setAttribute("cx", -10); });
  return box;
}
function fmtShort(n) { n = Math.round(n); return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n); }
function shortLabel(t, long = false) {
  if (!t) return "";
  if (/T\d{2}:\d{2}/.test(t)) { const d = new Date(t); return long ? d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }); }
  const d = new Date(t + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
export function barList(rows, { label = (r) => r.key, value = (r) => r.count, empty = "No data yet" } = {}) {
  if (!rows?.length) return h("p", { class: "muted small" }, empty);
  const max = Math.max(...rows.map(value), 1);
  return h("ul", { class: "list" }, rows.map((r) => h("li", null, h("span", { class: "grow", title: label(r) }, label(r)), h("span", { class: "bar" }, h("i", { style: { width: `${(value(r) / max) * 100}%` } })), h("b", { class: "num" }, fmtNum(value(r))))));
}

/* ---------------------------------------------------------------- audit diff viewer */
const show = (v) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 1));
export function diffView(changes) {
  if (!changes?.length) return h("p", { class: "muted small" }, "No field changes recorded.");
  return h("div", { class: "diff" }, h("div", { class: "row tiny muted" }, h("b", null, "Field"), h("span", { class: "hide-sm" }, " · old value → new value")),
    changes.map((c) => {
      if (c.diff?.hunks) return h("div", { class: "diff__row" }, h("div", { class: "diff__path" }, c.path, h("div", { class: "tiny muted" }, `+${c.diff.added} −${c.diff.removed} lines`)),
        h("div", { class: "diff__text" }, c.diff.hunks.map((l) => h("div", { class: l.t === "+" ? "add" : l.t === "-" ? "del" : "" }, h("span", { class: "ln" }, `${l.t === " " ? " " : l.t}${l.n}`), l.line || " "))));
      if (c.diff && (c.diff.added || c.diff.removed)) return h("div", { class: "diff__row" }, h("div", { class: "diff__path" }, c.path), h("div", { class: "diff__old" }, c.diff.removed.length ? `− ${c.diff.removed.join(", ")}` : ""), h("div", { class: "diff__new" }, c.diff.added.length ? `+ ${c.diff.added.join(", ")}` : ""));
      return h("div", { class: "diff__row" }, h("div", { class: "diff__path" }, c.path, c.op !== "changed" ? h("div", { class: "tiny muted" }, c.op) : null), h("div", { class: "diff__old" }, show(c.old)), h("div", { class: "diff__new" }, show(c.new)));
    }));
}
export function kv(pairs) { return h("dl", { class: "kv" }, pairs.filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [h("dt", null, k), h("dd", null, v)])); }
export function jsonBlock(v) { return h("pre", { class: "json" }, JSON.stringify(v, null, 2)); }
export const actionLabel = (a) => String(a || "").replace(/[._]/g, " ");

/* ---------------------------------------------------------------- misc */
export function debounce(fn, ms = 300) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function tabs(items, onChange, current) {
  const bar = h("div", { class: "tabs", role: "tablist" });
  const set = (id) => { $$("button", bar).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.id === id))); onChange(id); };
  items.forEach(([id, label]) => bar.append(h("button", { type: "button", role: "tab", dataset: { id }, "aria-selected": String(id === current), onclick: () => set(id) }, label)));
  return bar;
}
export function seg(items, value, onChange) {
  const box = h("div", { class: "seg", role: "group" });
  items.forEach(([v, l]) => box.append(h("button", { type: "button", "aria-pressed": String(v === value), onclick: () => { $$("button", box).forEach((b) => b.setAttribute("aria-pressed", "false")); box.querySelector(`[data-v="${v}"]`).setAttribute("aria-pressed", "true"); onChange(v); }, dataset: { v } }, l)));
  return box;
}
export function pageHead(title, sub, ...actions) {
  return h("div", { class: "page-head" }, h("div", null, h("h1", null, title), sub ? h("p", null, sub) : null), actions.length ? h("div", { class: "page-head__actions" }, actions) : null);
}
export const loading = () => h("div", { class: "card empty" }, "Loading…");
export const errorCard = (e) => h("div", { class: "banner banner--bad", role: "alert" }, errMsg(e));
export const reasonField = () => field("Reason for change", input("reason", "", { placeholder: "Optional — shown in the audit log", maxlength: 1000 }));
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "number") out[el.name] = el.value === "" ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

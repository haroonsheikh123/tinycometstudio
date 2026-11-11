/* Tiny Comet admin — app shell, router and sign-in flows. Talks only to the public /api/v1 API. */
import { h, $, mount, icon, api, state, toast, field, input, errMsg, busy, can, copyBtn, ApiErr } from "./ui.js";

const app = $("#app");

/* ---------------------------------------------------------------- theme */
const THEME_KEY = "tc-admin-theme";
function applyTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ } }
try { applyTheme(localStorage.getItem(THEME_KEY) || "auto"); } catch { applyTheme("auto"); }
const cycleTheme = () => { const order = ["auto", "light", "dark"]; const t = order[(order.indexOf(document.documentElement.dataset.theme) + 1) % 3]; applyTheme(t); toast(`Theme: ${t}`); };

/* ---------------------------------------------------------------- navigation */
export const NAV = [
  ["Overview", [["/admin/", "Dashboard", "dashboard", null], ["/admin/analytics", "Analytics", "chart", "analytics:read"]]],
  ["Content", [["/admin/games", "Games & apps", "game", "games:read"], ["/admin/news", "Newsroom", "news", "news:read"], ["/admin/media", "Media", "image", "media:read"], ["/admin/team", "Team", "team", "team:read"], ["/admin/pages", "Pages", "page", "pages:read"], ["/admin/messages", "Messages", "mail", "messages:read"], ["/admin/settings", "Site settings", "settings", "settings:read"]]],
  ["Access", [["/admin/users", "Users", "user", "users:read"], ["/admin/roles", "Roles", "shield", "roles:read"], ["/admin/api-keys", "API keys", "key", "api_keys:read"], ["/admin/approvals", "Approvals", "check", "approvals:read"], ["/admin/webhooks", "Webhooks", "hook", "webhooks:read"]]],
  ["Security", [["/admin/audit", "Audit log", "log", "audit:read"], ["/admin/system", "System", "system", "system:read"]]],
  ["Help", [["/admin/api-docs", "API docs", "code", null]]]
];
const VIEWS = [
  [/^\/admin\/?$/, "dashboard"], [/^\/admin\/analytics$/, "analytics"], [/^\/admin\/games(?:\/([^/]+))?$/, "games"], [/^\/admin\/news(?:\/([^/]+))?$/, "news"],
  [/^\/admin\/media$/, "media"], [/^\/admin\/team(?:\/([^/]+))?$/, "team"], [/^\/admin\/pages(?:\/([^/]+))?$/, "pages"], [/^\/admin\/messages$/, "messages"],
  [/^\/admin\/settings$/, "settings"], [/^\/admin\/users(?:\/([^/]+))?$/, "users"], [/^\/admin\/roles(?:\/([^/]+))?$/, "roles"], [/^\/admin\/api-keys$/, "keys"],
  [/^\/admin\/approvals$/, "approvals"], [/^\/admin\/webhooks(?:\/([^/]+))?$/, "webhooks"], [/^\/admin\/audit$/, "audit"], [/^\/admin\/system$/, "system"],
  [/^\/admin\/account$/, "account"], [/^\/admin\/api-docs$/, "apidocs"]
];
export function go(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", path); else history.pushState(null, "", path);
  route();
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href^='/admin']");
  if (!a || a.target || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0 || a.hasAttribute("download")) return;
  e.preventDefault();
  go(a.getAttribute("href"));
});
addEventListener("popstate", () => route());

/* ---------------------------------------------------------------- session */
async function loadMe() {
  try { const r = await api("GET", "/auth/session"); state.me = r.data; state.csrf = r.data.csrf_token; return true; }
  catch (e) { if (e instanceof ApiErr && (e.status === 401 || e.status === 403)) { state.me = null; return false; } throw e; }
}
state.onAuthLost = () => { if (state.me) { state.me = null; toast("Your session ended — please sign in again", "bad"); go("/admin/login", { replace: true }); } };

let shell = null;
async function route() {
  const path = location.pathname.replace(/\/index\.html$/, "/");
  const publicScreens = { "/admin/login": loginScreen, "/admin/setup": setupScreen, "/admin/invite": inviteScreen, "/admin/enroll": enrollLinkScreen };
  if (publicScreens[path]) { shell = null; return publicScreens[path](); }
  if (!state.me && !(await loadMe())) {
    const st = await api("GET", "/setup").catch(() => null);
    return go(st?.data?.setup_required ? "/admin/setup" : "/admin/login", { replace: true });
  }
  const hit = VIEWS.map(([re, name]) => [re.exec(path), name]).find(([m]) => m);
  if (!hit) return go("/admin/", { replace: true });
  const [m, name] = hit;
  if (!shell) shell = buildShell();
  markNav(path);
  const content = $(".content", shell);
  content.setAttribute("aria-busy", "true");
  try {
    const mod = await import(`./views/${name}.js`);
    const view = await mod.default({ param: m[1] ? decodeURIComponent(m[1]) : null, go, query: new URLSearchParams(location.search) });
    if (location.pathname.replace(/\/index\.html$/, "/") !== path) return; // navigated away meanwhile
    mount(content, view);
    document.title = `${($("h1", content)?.textContent || "Admin")} · Tiny Comet admin`;
    $(".top__title", shell).textContent = $("h1", content)?.textContent || "";
  } catch (e) {
    console.error(e);
    mount(content, h("div", { class: "banner banner--bad", role: "alert" }, errMsg(e)));
  } finally { content.removeAttribute("aria-busy"); }
  $(".side", shell).classList.remove("open");
  scrollTo(0, 0);
}

function buildShell() {
  const me = state.me;
  const nav = h("nav", { class: "nav", "aria-label": "Admin" }, NAV.map(([group, items]) => {
    const visible = items.filter(([, , , perm]) => !perm || can(perm));
    return visible.length ? [h("div", { class: "side__group" }, group), visible.map(([href, label, ic]) => h("a", { href, dataset: { href } }, icon(ic), h("span", null, label), href === "/admin/approvals" ? h("span", { class: "count", hidden: true, id: "nav-approvals" }) : href === "/admin/messages" ? h("span", { class: "count", hidden: true, id: "nav-messages" }) : null))] : null;
  }));
  const side = h("aside", { class: "side" }, h("a", { class: "side__brand", href: "/admin/" }, h("img", { src: "/assets/mark.svg", alt: "", width: 32, height: 32 }), h("span", null, "Tiny Comet", h("small", null, "Studio admin"))), nav,
    h("div", { class: "side__group" }, "Site"), h("nav", { class: "nav" }, h("a", { href: "/", target: "_blank", rel: "noopener" }, icon("external"), h("span", null, "View website"))));
  const userBtn = h("a", { class: "btn btn--ghost btn--sm", href: "/admin/account", title: "My account" }, icon("user"), h("span", { class: "hide-sm" }, me.user.name));
  const top = h("header", { class: "top" },
    h("button", { class: "btn btn--ghost btn--sm menu-btn", type: "button", "aria-label": "Menu", onclick: () => side.classList.toggle("open") }, icon("menu")),
    h("div", { class: "top__title" }), h("div", { class: "top__spacer" }),
    me.api_key ? null : h("span", { class: "badge badge--brand hide-sm" }, me.role?.name || me.user.role_id),
    h("button", { class: "btn btn--ghost btn--sm", type: "button", title: "Theme", "aria-label": "Switch theme", onclick: cycleTheme }, icon("moon")),
    userBtn,
    h("button", { class: "btn btn--ghost btn--sm", type: "button", title: "Sign out", "aria-label": "Sign out", onclick: signOut }, icon("logout")));
  const el = h("div", { class: "shell" }, side, h("div", { class: "main" }, top, h("main", { class: "content", id: "main", tabindex: -1 })));
  mount(app, el);
  refreshCounts();
  return el;
}
export async function refreshCounts() {
  if (can("approvals:read")) api("GET", "/approvals", { query: { status: "pending", limit: 1 } }).then((r) => { const c = $("#nav-approvals"); if (c) { c.textContent = r.meta.total; c.hidden = !r.meta.total; } }).catch(() => {});
  if (can("messages:read")) api("GET", "/messages", { query: { status: "new", limit: 1 } }).then((r) => { const c = $("#nav-messages"); if (c) { c.textContent = r.meta.total; c.hidden = !r.meta.total; } }).catch(() => {});
}
function markNav(path) {
  for (const a of shell.querySelectorAll(".nav a[data-href]")) {
    const href = a.dataset.href;
    const on = href === "/admin/" ? path === "/admin/" : path === href || path.startsWith(href + "/");
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
}
async function signOut() {
  try { await api("POST", "/auth/logout"); } catch { /* already gone */ }
  state.me = null; state.csrf = null; shell = null;
  go("/admin/login", { replace: true });
}

/* ---------------------------------------------------------------- auth screens */
function authCard(children, { wide = false, steps } = {}) {
  mount(app, h("main", { class: "auth", id: "main" }, h("div", { class: ["auth__card", wide && "auth__card--wide"] },
    h("div", { class: "auth__brand" }, h("img", { src: "/assets/mark.svg", alt: "", width: 36, height: 36 }), h("div", null, "Tiny Comet Studio", h("small", null, "Admin"))),
    steps ? h("div", { class: "steps", "aria-hidden": "true" }, Array.from({ length: steps[1] }, (_, i) => h("span", { class: i < steps[0] ? "on" : "" }))) : null,
    children,
    h("p", { class: "auth__foot" }, "Protected area · two-factor sign-in required"))));
  document.title = "Sign in · Tiny Comet admin";
  setTimeout(() => app.querySelector("input")?.focus(), 30);
}
const errBox = () => h("p", { class: "form-error", role: "alert", "aria-live": "assertive" });

let turnstileLoaded = null;
function loadTurnstile() {
  turnstileLoaded ||= new Promise((res, rej) => { const s = h("script", { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", async: true }); s.onload = res; s.onerror = rej; document.head.append(s); });
  return turnstileLoaded;
}

function loginScreen() {
  const email = input("email", "", { type: "email", autocomplete: "username", required: true });
  const pw = input("password", "", { type: "password", autocomplete: "current-password", required: true });
  const err = errBox();
  const captcha = h("div", { class: "captcha" });
  let tsToken = null;
  const btn = h("button", { class: "btn btn--primary btn--block" }, "Continue");
  const form = h("form", { class: "form", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; busy(btn, true);
    try {
      const r = await api("POST", "/auth/login", { body: { email: email.value.trim(), password: pw.value, ...(tsToken ? { turnstile_token: tsToken } : {}) } });
      codeScreen(r.data.mfa_token, email.value.trim());
    } catch (x) {
      err.textContent = errMsg(x);
      if (x.code === "captcha_required" && x.details?.site_key) {
        await loadTurnstile().catch(() => { err.textContent = "Couldn't load the human check — check your connection."; });
        if (window.turnstile && !captcha.dataset.ready) { captcha.dataset.ready = "1"; window.turnstile.render(captcha, { sitekey: x.details.site_key, action: "admin-login", callback: (t) => { tsToken = t; } }); }
      } else if (window.turnstile && captcha.dataset.ready) { window.turnstile.reset(captcha); tsToken = null; }
      busy(btn, false);
    }
  } }, h("h1", null, "Sign in"), h("p", { class: "muted" }, "Email and password, then a code from your authenticator app."), field("Email", email), field("Password", pw), captcha, err, btn);
  authCard(form, { steps: [1, 2] });
}

function codeScreen(mfaToken, email) {
  let recovery = false;
  const code = input("code", "", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 7, class: "otp", required: true, "aria-label": "6-digit code" });
  const rec = input("recovery", "", { autocomplete: "off", placeholder: "xxxxx-xxxxx", hidden: true, "aria-label": "Recovery code" });
  const err = errBox();
  const btn = h("button", { class: "btn btn--primary btn--block" }, "Sign in");
  const swap = h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => { recovery = !recovery; code.hidden = recovery; rec.hidden = !recovery; swap.textContent = recovery ? "Use authenticator code" : "Use a recovery code"; (recovery ? rec : code).focus(); } }, "Use a recovery code");
  const form = h("form", { class: "form", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; busy(btn, true);
    try {
      const r = await api("POST", "/auth/mfa", { body: recovery ? { mfa_token: mfaToken, recovery_code: rec.value.trim() } : { mfa_token: mfaToken, code: code.value.replace(/\s/g, "") } });
      state.csrf = r.data.csrf_token; state.me = null;
      if (recovery) toast(`Signed in with a recovery code — ${r.data.user.recovery_codes_left} left`, "ok");
      go("/admin/", { replace: true });
    } catch (x) {
      err.textContent = errMsg(x); busy(btn, false);
      if (x.code === "mfa_token_invalid") setTimeout(loginScreen, 1600);
      code.select();
    }
  } }, h("h1", null, "Enter your code"), h("p", { class: "muted" }, `Open your authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…) and enter the 6-digit code for Tiny Comet Studio (${email}).`),
    code, rec, err, btn, h("div", { class: "row" }, swap));
  form.addEventListener("input", (e) => { if (e.target === code && /^\d{6}$/.test(code.value.replace(/\s/g, ""))) form.requestSubmit(); });
  authCard(form, { steps: [2, 2] });
}

function setupScreen() {
  const token = input("setup_token", "", { type: "password", autocomplete: "off", required: true });
  const name = input("name", "", { autocomplete: "name", required: true });
  const email = input("email", "", { type: "email", autocomplete: "username", required: true });
  const pw = input("password", "", { type: "password", autocomplete: "new-password", required: true, minlength: 12 });
  const err = errBox();
  const btn = h("button", { class: "btn btn--primary btn--block" }, "Create owner account");
  const form = h("form", { class: "form", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; busy(btn, true);
    try {
      const r = await api("POST", "/setup", { body: { setup_token: token.value, name: name.value.trim(), email: email.value.trim(), password: pw.value } });
      enrollScreen(r.data.mfa_token, {});
    } catch (x) { err.textContent = errMsg(x); busy(btn, false); if (x.code === "setup_complete") setTimeout(() => go("/admin/login"), 1500); }
  } }, h("h1", null, "Set up the admin"), h("p", { class: "muted" }, "Create the first owner account. You'll need the one-time SETUP_TOKEN secret from your Cloudflare project. This page switches itself off once it's used."),
    field("Setup token", token), field("Your name", name), field("Email", email), field("Password", pw, "At least 12 characters. A long passphrase is best."), err, btn);
  authCard(form, { steps: [1, 3] });
}

async function enrollScreen(mfaToken, { password } = {}) {
  authCard(h("p", { class: "muted" }, "Preparing your authenticator…"), { steps: [2, 3] });
  let s;
  try { s = (await api("POST", "/auth/totp/setup", { body: { mfa_token: mfaToken, ...(password ? { password } : {}) } })).data; }
  catch (x) { return authCard(h("div", null, h("h1", null, "Link problem"), h("p", { class: "form-error" }, errMsg(x)), h("a", { class: "btn", href: "/admin/login" }, "Go to sign in"))); }
  const code = input("code", "", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: 7, class: "otp", required: true, "aria-label": "6-digit code" });
  const err = errBox();
  const btn = h("button", { class: "btn btn--primary btn--block" }, "Verify & finish");
  const qrUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s.qr_svg);
  const form = h("form", { class: "form", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ""; busy(btn, true);
    try {
      const r = await api("POST", "/auth/totp/confirm", { body: { mfa_token: mfaToken, code: code.value.replace(/\s/g, ""), ...(password ? { password } : {}) } });
      state.csrf = r.data.csrf_token;
      recoveryScreen(r.data.recovery_codes);
    } catch (x) { err.textContent = errMsg(x); busy(btn, false); code.select(); }
  } },
    h("h1", null, "Connect your authenticator"),
    h("p", { class: "muted" }, "Two-factor sign-in is required for every admin. Scan this QR code with Google Authenticator, Microsoft Authenticator, Authy, 1Password or any TOTP app."),
    h("div", { class: "qr" }, h("img", { src: qrUrl, alt: "QR code for your authenticator app", width: 168, height: 168 }),
      h("div", { class: "stack" }, h("div", null, h("div", { class: "label" }, "Can't scan? Enter this key"), h("div", { class: "secret", "data-totp-secret": s.secret }, s.secret_grouped)), h("div", { class: "row" }, copyBtn(s.secret, "Copy key")), h("p", { class: "tiny muted" }, `Account: ${s.account} · Time-based · 6 digits`))),
    field("Code from the app", code), err, btn);
  authCard(form, { wide: true, steps: [2, 3] });
}

function recoveryScreen(codes) {
  const ok = h("input", { type: "checkbox", id: "saved" });
  const btn = h("button", { class: "btn btn--primary btn--block", type: "button", disabled: true, onclick: () => { state.me = null; go("/admin/", { replace: true }); } }, "Go to the dashboard");
  ok.addEventListener("change", () => (btn.disabled = !ok.checked));
  const text = `Tiny Comet Studio admin — recovery codes\nEach code works once if you lose your phone.\n\n${codes.join("\n")}\n`;
  const dl = h("a", { class: "btn btn--sm", href: "data:text/plain;charset=utf-8," + encodeURIComponent(text), download: "tiny-comet-recovery-codes.txt" }, icon("download"), "Download");
  authCard(h("div", { class: "stack" }, h("h1", null, "Save your recovery codes"),
    h("p", { class: "muted" }, "If you lose your phone, each of these codes lets you sign in once. They're shown only now — store them in a password manager or print them."),
    h("div", { class: "codes", "data-recovery-codes": "" }, codes.map((c) => h("span", null, c))),
    h("div", { class: "row" }, copyBtn(codes.join("\n"), "Copy all"), dl),
    h("label", { class: "check" }, ok, h("span", null, "I've saved my recovery codes somewhere safe")), btn), { wide: true, steps: [3, 3] });
}

async function inviteScreen() {
  const token = location.hash.slice(1);
  history.replaceState(null, "", "/admin/invite"); // keep the token out of history/screens
  if (!token) return authCard(h("div", null, h("h1", null, "Invite link"), h("p", { class: "muted" }, "Open the full link you were sent.")));
  let info;
  try { info = (await api("POST", "/auth/invite/inspect", { body: { token } })).data; }
  catch (x) { return authCard(h("div", null, h("h1", null, "Link expired"), h("p", { class: "form-error" }, errMsg(x)), h("a", { class: "btn", href: "/admin/login" }, "Go to sign in"))); }
  const name = input("name", info.name, { autocomplete: "name", required: true });
  const pw = input("password", "", { type: "password", autocomplete: "new-password", required: true, minlength: 12 });
  const pw2 = input("password2", "", { type: "password", autocomplete: "new-password", required: true });
  const err = errBox();
  const btn = h("button", { class: "btn btn--primary btn--block" }, info.kind === "reset" ? "Set new password" : "Continue");
  const form = h("form", { class: "form", onsubmit: async (e) => {
    e.preventDefault(); err.textContent = "";
    if (pw.value !== pw2.value) { err.textContent = "The passwords don't match"; return; }
    busy(btn, true);
    try {
      const r = await api("POST", "/auth/invite/accept", { body: { token, password: pw.value, name: name.value.trim() } });
      if (r.data.next === "enroll") enrollScreen(r.data.mfa_token);
      else { toast("Password updated — sign in now", "ok"); go("/admin/login", { replace: true }); }
    } catch (x) { err.textContent = errMsg(x); busy(btn, false); }
  } }, h("h1", null, info.kind === "reset" ? "Reset your password" : "Welcome aboard!"), h("p", { class: "muted" }, `${info.email} · ${info.kind === "reset" ? "choose a new password." : "choose a password, then connect your authenticator app."}`),
    info.kind === "invite" ? field("Your name", name) : null, field("New password", pw, "At least 12 characters."), field("Repeat password", pw2), err, btn);
  authCard(form, { steps: [1, 3] });
}

async function enrollLinkScreen() {
  const token = location.hash.slice(1);
  history.replaceState(null, "", "/admin/enroll");
  let info;
  try { info = (await api("POST", "/auth/invite/inspect", { body: { token } })).data; }
  catch (x) { return authCard(h("div", null, h("h1", null, "Link expired"), h("p", { class: "form-error" }, errMsg(x)))); }
  const pw = input("password", "", { type: "password", autocomplete: "current-password", required: true });
  const form = h("form", { class: "form", onsubmit: (e) => { e.preventDefault(); enrollScreen(token, { password: pw.value }); } },
    h("h1", null, "Set up your authenticator again"), h("p", { class: "muted" }, `${info.email} — an admin reset your two-factor sign-in. Confirm your password to connect a new authenticator.`),
    field("Password", pw), h("button", { class: "btn btn--primary btn--block" }, "Continue"));
  authCard(form, { steps: [1, 3] });
}

route();

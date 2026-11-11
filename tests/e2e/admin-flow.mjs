#!/usr/bin/env node
/* End-to-end admin flow in a real browser against `npx wrangler pages dev` (local D1 + R2).
   Prereqs: node tools/db-seed.mjs --local && npx wrangler pages dev --port 8788   (fresh DB: no users yet)
   Run:     NODE_PATH=$(npm root -g) node tests/e2e/admin-flow.mjs [--base http://127.0.0.1:8788] [--shots DIR]
   TOTP codes are computed here from the secret shown on the enrollment screen (lib/admin/totp.js). */
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import { totp, timeStep } from "../../lib/admin/totp.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const BASE = opt("--base", "http://127.0.0.1:8788");
const SHOTS = opt("--shots", "/home/user/tiny-comet-admin-screenshots");
const SETUP_TOKEN = (readFileSync(new URL("../../.dev.vars", import.meta.url), "utf8").match(/^SETUP_TOKEN=(.*)$/m) || [])[1];
mkdirSync(SHOTS, { recursive: true });

const OWNER = { name: "Haroon Sheikh", email: "haroon@tinycometstudio.com", password: "Comet-launch-Lahore-2026!" };
const CHILD = { name: "Sana Writer", email: "sana@tinycometstudio.com", password: "Stardust-notes-blue-77" };
const log = (...a) => console.log("•", ...a);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(ok ? "  ✔" : "  ✖", name, detail); if (!ok) process.exitCode = 1; };

/* fresh TOTP codes without reuse (server rejects a step ≤ the last one used) */
const used = new Map();
async function freshCode(secret) {
  for (;;) {
    const last = used.get(secret) ?? -1, cur = timeStep();
    const step = cur > last ? cur : last + 1 <= cur + 1 ? last + 1 : null;
    if (step !== null) { used.set(secret, step); return totp(secret, step * 30_000 + 1000); }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const VIEWPORTS = [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]];
async function shoot(page, name, { full = true } = {}) {
  const vp = page.viewportSize();
  for (const [label, size] of VIEWPORTS) {
    await page.setViewportSize(size);
    await page.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${label}-${size.width}.png`, fullPage: full });
  }
  await page.setViewportSize(vp);
}
const settle = (page) => page.waitForFunction(() => !document.querySelector("[aria-busy='true']")).then(() => page.waitForTimeout(350));
async function nav(page, path) { await page.goto(BASE + path); await page.waitForSelector(".content h1, .auth h1"); await settle(page); }

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource: the server responded with a status of (401|403|404)/.test(m.text())) consoleErrors.push(m.text()); }); // 401/403 = the deliberate failed attempts
page.on("pageerror", (e) => consoleErrors.push(String(e)));

/* 1. setup token → owner */
log("Setup");
await page.goto(BASE + "/admin/");
await page.waitForURL(/\/admin\/(setup|login)/);
check("fresh install redirects to /admin/setup", page.url().endsWith("/admin/setup"));
await shoot(page, "01-setup");
await page.fill("input[name=setup_token]", SETUP_TOKEN);
await page.fill("input[name=name]", OWNER.name);
await page.fill("input[name=email]", OWNER.email);
await page.fill("input[name=password]", OWNER.password);
await page.click("button:has-text('Create owner account')");

/* 2. enroll TOTP */
log("Enroll authenticator");
await page.waitForSelector("[data-totp-secret]");
const ownerSecret = await page.getAttribute("[data-totp-secret]", "data-totp-secret");
check("QR code rendered as inline SVG image", (await page.getAttribute(".qr img", "src")).startsWith("data:image/svg+xml"));
await shoot(page, "02-enroll-totp");
await page.fill("input[name=code]", "123456");
await page.click("button:has-text('Verify & finish')");
await page.waitForSelector(".form-error:not(:empty)");
check("wrong enrollment code is rejected", (await page.textContent(".form-error")).includes("isn't right"));
await page.fill("input[name=code]", await freshCode(ownerSecret));
await page.click("button:has-text('Verify & finish')");
await page.waitForSelector("[data-recovery-codes]");
const recovery = await page.$$eval("[data-recovery-codes] span", (s) => s.map((x) => x.textContent));
check("10 recovery codes shown once", recovery.length === 10);
await shoot(page, "03-recovery-codes");
await page.check("#saved");
await page.click("button:has-text('Go to the dashboard')");
await page.waitForSelector(".content h1");
await settle(page);

/* 3. log out, log in with password + TOTP */
log("Login");
await page.click("button[aria-label='Sign out']");
await page.waitForURL(/\/admin\/login/);
await page.waitForSelector("input[name=email]");
await shoot(page, "04-login");
await page.fill("input[name=email]", OWNER.email);
await page.fill("input[name=password]", "wrong-password-123");
await page.click("button:has-text('Continue')");
await page.waitForSelector(".form-error:not(:empty)");
check("wrong password → generic error", (await page.textContent(".form-error")).includes("Wrong email or password"));
await page.fill("input[name=password]", OWNER.password);
await page.click("button:has-text('Continue')");
await page.waitForSelector("input[name=code]");
await shoot(page, "05-login-code");
await page.fill("input[name=code]", await freshCode(ownerSecret));
await page.waitForURL(BASE + "/admin/");
await page.waitForSelector(".content h1");
await settle(page);
check("signed in with email + password + TOTP", (await page.textContent(".content h1")).includes("Haroon"));
const cookies = await ctx.cookies();
const sc = cookies.find((c) => c.name === "__Host-tc_session");
check("session cookie is HttpOnly + Secure + SameSite=Strict", !!sc && sc.httpOnly && sc.secure && sc.sameSite === "Strict");
await shoot(page, "06-dashboard");

/* 4. custom role */
log("Custom role");
await nav(page, "/admin/roles");
await shoot(page, "07-roles");
await nav(page, "/admin/roles/new");
await page.fill("input[name=name]", "Newsroom writer");
await page.fill("textarea[name=description]", "Writes and edits posts, can't publish or touch games.");
for (const p of ["news:read", "news:create", "news:update", "games:read", "media:read", "media:create"]) await page.check(`.matrix input[value='${p}']`);
await page.click("button:has-text('Create role')");
let stepped = false;
try { await page.waitForSelector("dialog input.otp", { timeout: 3000 }); stepped = true; } catch { /* still inside step-up window */ }
if (stepped) { await page.fill("dialog input.otp", await freshCode(ownerSecret)); await page.click("dialog button:has-text('Confirm')"); }
await page.waitForURL(/\/admin\/roles\/newsroom-writer/);
await settle(page);
check("custom role created", (await page.textContent(".content h1")) === "Newsroom writer");
await shoot(page, "08-role-editor");

/* 5. invite child user */
log("Invite child user");
await nav(page, "/admin/users");
await page.click("button:has-text('Invite user')");
await page.fill("dialog input[name=email]", CHILD.email);
await page.fill("dialog input[name=name]", CHILD.name);
await page.selectOption("dialog select[name=role_id]", "newsroom-writer");
await shoot(page, "09-invite-dialog", { full: false });
await page.click("dialog button:has-text('Create invite')");
await page.waitForSelector("dialog [data-link]");
const inviteUrl = await page.textContent("dialog [data-link]");
check("invite link issued (one-time, shown once)", /\/admin\/invite#[A-Za-z0-9_-]{40,}/.test(inviteUrl));
await page.click("dialog button:has-text('Done')");
await settle(page);
await shoot(page, "10-users");

/* 6. edit a game (with dry-run preview) */
log("Edit game");
await nav(page, "/admin/games");
await shoot(page, "11-games");
await nav(page, "/admin/games/project-nova");
await page.fill("input[name=tagline]", "Steer a tiny comet through a very big sky.");
await page.fill("input[name=link_android]", "https://play.google.com/store/apps/details?id=com.tinycomet.nova");
await page.fill("input[name=reason]", "Launch copy from the marketing doc");
await page.click("button:has-text('Preview changes')");
await page.waitForSelector("dialog .diff__row");
const previewPaths = await page.$$eval("dialog .diff__path", (els) => els.map((e) => e.firstChild.textContent));
check("dry-run preview shows field diffs", previewPaths.includes("tagline") && previewPaths.includes("links.android"), previewPaths.join(","));
await shoot(page, "12-game-preview-diff", { full: false });
await page.click("dialog button:has-text('Save now')");
await page.waitForSelector(".toast");
await settle(page);
await shoot(page, "13-game-editor");
await page.click(".tabs button:has-text('Web play')"); await page.waitForTimeout(300);
await shoot(page, "14-game-webplay");
await page.click(".tabs button:has-text('History')"); await page.waitForSelector(".timeline li"); await page.waitForTimeout(300);
await shoot(page, "15-game-history");
const live = await (await fetch(BASE + "/project-nova/")).text();
check("public game page re-rendered from D1 with the new tagline", live.includes("Steer a tiny comet through a very big sky."));

/* 7. publish a news post */
log("Publish news");
await nav(page, "/admin/news");
await shoot(page, "16-news");
await nav(page, "/admin/news/new");
await page.fill("input[name=title]", "Project Nova is coming to Android");
await page.fill("textarea[name=excerpt]", "Our tiny comet is nearly ready for your phone.");
await page.selectOption("select[name=game]", "project-nova");
await page.selectOption("select[name=category]", "Announcement");
await page.fill("textarea[name=body]", "## Big news\n\nProject Nova lands on **Google Play** soon.\n\n- Smooth comet trails\n- 30 hand-made skies\n\n> Small studio. Big little worlds.");
await page.waitForSelector(".preview h2");
await shoot(page, "17-news-editor");
await page.click("button:has-text('Publish now')");
await page.waitForURL(/\/admin\/news\/project-nova-is-coming-to-android/);
await settle(page);
check("news post published", (await page.textContent(".page-head")).includes("published"));
const post = await fetch(BASE + "/news/project-nova-is-coming-to-android/");
check("post is live on the public site", post.status === 200 && (await post.text()).includes("Project Nova is coming to Android"));
const home = await (await fetch(BASE + "/")).text();
check("home page shows the new post (cache purged)", home.includes("Project Nova is coming to Android"));

/* 8. API key + use it via fetch */
log("API key");
await nav(page, "/admin/api-keys");
await page.click("button:has-text('New API key')");
await page.waitForSelector("dialog .matrix");
await page.fill("dialog input[name=name]", "Release agent");
await page.fill("dialog input[name=description]", "Cloud agent that reads the catalogue and drafts news");
for (const p of ["games:read", "news:read", "news:create", "analytics:read"]) await page.check(`dialog .matrix input[value='${p}']`);
await shoot(page, "18-api-key-create", { full: false });
await page.click("dialog button:has-text('Create key')");
try { await page.waitForSelector("dialog input.otp", { timeout: 2500 }); await page.fill("dialog input.otp", await freshCode(ownerSecret)); await page.click("dialog button:has-text('Confirm')"); } catch { /* step-up still valid */ }
await page.waitForSelector("dialog [data-secret]");
const apiKey = (await page.textContent("dialog [data-secret]")).trim();
check("key secret shown once", /^tck_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/.test(apiKey));
await shoot(page, "19-api-key-secret", { full: false });
await page.click("dialog button:has-text('I\\'ve saved it')");
await settle(page);
const H = { Authorization: `Bearer ${apiKey}`, "X-Agent-Name": "release-bot", "Content-Type": "application/json" };
const g = await fetch(BASE + "/api/v1/games", { headers: H });
check("API key can read games (200)", g.status === 200 && (await g.json()).data.length >= 3);
const dry = await fetch(BASE + "/api/v1/news", { method: "POST", headers: { ...H, "X-Dry-Run": "true" }, body: JSON.stringify({ title: "Agent draft", body: "Hello from the agent" }) });
const dryJ = await dry.json();
check("dry-run returns the would-be diff and writes nothing", dry.status === 200 && dryJ.meta?.would_change?.[0]?.action === "news.create" && dryJ.meta?.dry_run === true && (await fetch(BASE + "/api/v1/news/agent-draft", { headers: H })).status === 404);
const created = await fetch(BASE + "/api/v1/news", { method: "POST", headers: { ...H, "Idempotency-Key": "draft-1", "X-Change-Reason": "weekly devlog draft" }, body: JSON.stringify({ title: "Agent draft", body: "Hello from the agent" }) });
check("API key creates a draft post (201)", created.status === 201);
const again = await fetch(BASE + "/api/v1/news", { method: "POST", headers: { ...H, "Idempotency-Key": "draft-1", "X-Change-Reason": "weekly devlog draft" }, body: JSON.stringify({ title: "Agent draft", body: "Hello from the agent" }) });
check("Idempotency-Key replays the first response", again.status === 201 && again.headers.get("Idempotent-Replayed") === "true");
const denied = await fetch(BASE + "/api/v1/games/project-nova", { method: "PATCH", headers: H, body: JSON.stringify({ tagline: "hacked" }) });
const deniedJ = await denied.json();
check("denied: key without games:update gets 403", denied.status === 403 && deniedJ.error.code === "forbidden", deniedJ.error?.message);
const pub = await fetch(BASE + "/api/v1/news/agent-draft/publish", { method: "POST", headers: H, body: "{}" });
check("denied: key without news:publish can't publish", pub.status === 403);
await nav(page, "/admin/api-keys");
await shoot(page, "20-api-keys");

/* 9. child user: accept invite, enroll, try something they can't do */
log("Child user");
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p2 = await ctx2.newPage();
await p2.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, BASE));
await p2.waitForSelector("input[name=password]");
await shoot(p2, "21-invite-accept");
await p2.fill("input[name=password]", CHILD.password);
await p2.fill("input[name=password2]", CHILD.password);
await p2.click("button:has-text('Continue')");
await p2.waitForSelector("[data-totp-secret]");
const childSecret = await p2.getAttribute("[data-totp-secret]", "data-totp-secret");
await p2.fill("input[name=code]", await freshCode(childSecret));
await p2.click("button:has-text('Verify & finish')");
await p2.waitForSelector("[data-recovery-codes]");
await p2.check("#saved");
await p2.click("button:has-text('Go to the dashboard')");
await p2.waitForSelector(".content h1");
const navLinks = await p2.$$eval(".nav a", (as) => as.map((a) => a.textContent.trim()));
check("child user sees only what the custom role allows", navLinks.includes("Newsroom") && !navLinks.includes("Users") && !navLinks.includes("API keys") && !navLinks.includes("Audit log"), navLinks.join(" | "));
const childDenied = await p2.evaluate(async () => {
  const s = await (await fetch("/api/v1/auth/session")).json();
  const r = await fetch("/api/v1/games/project-nova", { method: "DELETE", headers: { "X-CSRF-Token": s.data.csrf_token } });
  const r2 = await fetch("/api/v1/news/project-nova-is-coming-to-android/unpublish", { method: "POST", headers: { "X-CSRF-Token": s.data.csrf_token } });
  const r3 = await fetch("/api/v1/games/project-nova", { method: "DELETE" }); // no CSRF token
  return [r.status, (await r.json()).error.code, r2.status, r3.status, (await r3.json()).error.code];
});
check("denied: child user can't delete a game (403)", childDenied[0] === 403 && childDenied[1] === "forbidden");
check("denied: child user can't unpublish (needs news:publish)", childDenied[2] === 403);
check("CSRF: cookie request without X-CSRF-Token is refused", childDenied[3] === 403 && childDenied[4] === "csrf_failed");
const escalate = await p2.evaluate(async () => {
  const s = await (await fetch("/api/v1/auth/session")).json();
  const r = await fetch("/api/v1/roles", { method: "POST", headers: { "X-CSRF-Token": s.data.csrf_token, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Sneaky", permissions: ["users:manage"] }) });
  return r.status;
});
check("child user can't create roles / grant more access", escalate === 403);
await nav(p2, "/admin/news");
await shoot(p2, "22-child-newsroom");
await ctx2.close();

/* 10. audit log shows field diffs */
log("Audit log");
await nav(page, "/admin/audit");
await shoot(page, "23-audit-log");
await page.fill("input[name=q]", "Project Nova");
await page.click("button:has-text('Filter')");
await settle(page);
await page.waitForSelector(".timeline li .chip");
await page.locator(".timeline li", { has: page.locator(".chip", { hasText: /^game\.update$/ }) }).first().click();
await page.waitForSelector(".drawer.open .diff__row");
const drawerPaths = await page.$$eval(".drawer .diff__path", (els) => els.map((e) => e.firstChild.textContent));
const drawerText = await page.textContent(".drawer");
check("audit entry shows field-level old → new diff", drawerPaths.includes("tagline") && drawerText.includes("A tiny comet, a very big sky.") && drawerText.includes("Steer a tiny comet"), drawerPaths.join(","));
check("audit entry records who/where/why", drawerText.includes(OWNER.email) && drawerText.includes("Launch copy from the marketing doc") && drawerText.includes("admin_ui"));
await shoot(page, "24-audit-entry-diff", { full: false });
await page.keyboard.press("Escape");
await nav(page, "/admin/audit?result=denied");
const deniedRows = await page.$$eval(".timeline li", (lis) => lis.map((l) => l.textContent));
check("denied attempts are in the audit log (key + child user)", deniedRows.some((t) => t.includes("Release agent")) && deniedRows.some((t) => t.includes(CHILD.name)), `${deniedRows.length} denied rows`);
await nav(page, "/admin/audit?agent=release-bot");
const agentRows = await page.$$eval(".timeline li", (lis) => lis.length);
check("agent name (X-Agent-Name) is filterable", agentRows >= 2);
await nav(page, "/admin/audit");
await page.click("button:has-text('Verify integrity')");
await page.waitForSelector("[data-verify]");
check("hash chain verifies", (await page.getAttribute("[data-verify]", "data-verify")) === "ok");
const v = await (await fetch(BASE + "/api/v1/audit/verify", { headers: { Authorization: `Bearer ${apiKey}` } })).json();
check("/audit/verify needs audit:read (key lacks it → 403)", v.error?.code === "forbidden");

/* 11. extra data for the remaining screens, then screenshots of every screen */
log("Remaining screens");
await fetch(BASE + "/api/v1/contact", { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" }, body: JSON.stringify({ name: "Ayesha", email: "ayesha@example.com", topic: "Press", message: "Hi! I write for a games blog and would love a Project Nova preview build for a feature next month." }) });
const csrf = await page.evaluate(async () => (await (await fetch("/api/v1/auth/session")).json()).data.csrf_token);
const ownerApi = (method, path, body) => page.evaluate(async ([m, p, b, t]) => { const r = await fetch("/api/v1" + p, { method: m, headers: { "X-CSRF-Token": t, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; }, [method, path, body, csrf]);
await ownerApi("POST", "/webhooks", { url: "https://hooks.example.com/tinycomet", description: "Discord relay", events: ["news.published", "message.received"] });
const ak = await ownerApi("POST", "/api-keys", { name: "Cautious agent", scopes: ["news:read", "news:delete"], require_approval: true });
if (ak.json?.data?.secret) {
  const q = await fetch(BASE + "/api/v1/news/agent-draft", { method: "DELETE", headers: { Authorization: `Bearer ${ak.json.data.secret}`, "X-Agent-Name": "cleanup-bot", "X-Change-Reason": "duplicate draft" } });
  check("approval-required key: destructive call is queued (202)", q.status === 202);
}
for (const [path, name] of [["/admin/analytics", "25-analytics"], ["/admin/media", "26-media"], ["/admin/team", "27-team"], ["/admin/team/haroon-sheikh", "28-team-edit"], ["/admin/pages", "29-pages"], ["/admin/pages/privacy", "30-page-edit"],
  ["/admin/messages", "31-messages"], ["/admin/settings", "32-settings"], ["/admin/approvals", "33-approvals"], ["/admin/webhooks", "34-webhooks"], ["/admin/system", "35-system"], ["/admin/account", "36-account"], ["/admin/api-docs", "37-api-docs"], ["/admin/", "38-dashboard-after"]]) {
  await nav(page, path);
  if (name === "31-messages") { await page.click(".list button.btn--ghost"); await page.waitForTimeout(400); }
  await shoot(page, name);
}
await nav(page, "/admin/approvals");
if (await page.$("button:has-text('Approve & run')")) {
  await page.click("button:has-text('Approve & run')");
  await page.click("dialog button:has-text('Approve & run')");
  try { await page.waitForSelector("dialog input.otp", { timeout: 2500 }); await page.fill("dialog input.otp", await freshCode(ownerSecret)); await page.click("dialog button:has-text('Confirm')"); } catch { /* ok */ }
  await page.waitForSelector(".toast");
  const gone = await (await fetch(BASE + "/api/v1/news/agent-draft", { headers: H })).json();
  check("approved request ran (post moved to trash)", gone.data?._meta?.deleted_at != null);
}

check("no browser console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
await browser.close();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed · screenshots in ${SHOTS}`);

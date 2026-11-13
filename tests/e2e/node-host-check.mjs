#!/usr/bin/env node
/* End-to-end checks specific to the Node/cPanel host, in a real browser:
   - the web-play gate with Cloudflare's Turnstile TEST keys (real widget + real siteverify call) unlocks the game
   - an admin session survives a full server restart on a different (unusual) port, like a Passenger restart
   - screenshots of the Node-hosted site
   Run: NODE_PATH=$(npm root -g) node tests/e2e/node-host-check.mjs [--shots DIR]
   It starts `node server.mjs` itself (fresh data folder), with TURNSTILE_SECRET=1x0000000000000000000000000000000AA. */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { totp, timeStep } from "../../lib/admin/totp.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const args = process.argv.slice(2);
const SHOTS = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : "/home/user/tiny-comet-hosting-screenshots";
mkdirSync(SHOTS, { recursive: true });
const ROOT = new URL("../..", import.meta.url).pathname;
const DATA = mkdtempSync(join(tmpdir(), "tc-host-e2e-"));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(ok ? "  ✔" : "  ✖", name, detail); if (!ok) process.exitCode = 1; };
const log = (...a) => console.log("•", ...a);
const SETUP_TOKEN = "e2e-node-host-setup-token-0123456789";

function startServer(port) {
  const env = { ...process.env, DATA_DIR: DATA, PORT: String(port), SIGNING_KEY: "n".repeat(48), ENCRYPTION_KEY: "k".repeat(40), SETUP_TOKEN, TURNSTILE_SECRET: "1x0000000000000000000000000000000AA", ENVIRONMENT: "development", LOG_LEVEL: "warn" };
  const p = spawn(process.execPath, ["server.mjs"], { cwd: ROOT, env, stdio: ["ignore", "inherit", "pipe"] });
  p.stderr.on("data", (d) => { if (!/ExperimentalWarning|trace-warnings/.test(String(d))) process.stderr.write(d); });
  return p;
}
async function waitUp(base) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/api/v1/health")).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server did not start");
}
const stop = (p) => new Promise((r) => { p.once("exit", r); p.kill("SIGTERM"); });

let srv = startServer(48765);
let BASE = "http://127.0.0.1:48765";
const browser = await chromium.launch();
try {
  await waitUp(BASE);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  log("Public site on the Node host");
  const home = await page.goto(BASE + "/");
  check("home page 200, rendered from the database", home.status() === 200 && home.headers()["x-rendered-from"] === "d1");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${SHOTS}/01-home-desktop.png`, fullPage: true });
  await page.goto(BASE + "/project-nova/"); await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${SHOTS}/02-game-page.png`, fullPage: true });
  await page.goto(BASE + "/news/"); await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${SHOTS}/03-news.png`, fullPage: true });
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(BASE + "/"); await mobile.waitForLoadState("networkidle");
  await mobile.screenshot({ path: `${SHOTS}/04-home-mobile.png`, fullPage: false });
  await mobile.close();

  log("Web play gate with Turnstile test keys");
  await page.goto(BASE + "/project-nova/play/");
  check("gate page shown before the captcha", (await page.locator("[data-gate]").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/05-play-gate.png` });
  // The test site key auto-passes; gate.js posts the token to /api/verify, which calls Cloudflare's siteverify.
  await page.waitForURL(BASE + "/project-nova/play/", { timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector("[data-gate]"), null, { timeout: 30_000 });
  const cookies = await ctx.cookies();
  const play = cookies.find((c) => c.name === "tc_play");
  check("captcha solved → signed HttpOnly play cookie for /project-nova/play/", Boolean(play && play.httpOnly && play.path === "/project-nova/play/"));
  check("the game loads after the gate", (await page.content()).length > 0 && (await page.locator("canvas, #game, main").count()) > 0);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/06-play-unlocked.png` });
  // (in-page fetch: the play/session cookies are Secure, which the browser honours on http://127.0.0.1 like on https)
  const inPage = (url) => page.evaluate((u) => fetch(u, { credentials: "same-origin" }).then(async (r) => ({ status: r.status, text: await r.text() })), url);
  check("game assets served once unlocked", (await inPage("/project-nova/play/game.js")).status === 200);

  log("Admin setup + sign-in, then restart the server mid-session");
  const api = (p, body, headers = {}) => page.request.fetch(BASE + "/api/v1" + p, { method: body ? "POST" : "GET", data: body, headers: { Origin: BASE, ...headers } });
  const setup = await (await api("/setup", { setup_token: SETUP_TOKEN, email: "owner@tinycomet.test", name: "Owner Person", password: "Orbit-garden-sunrise-42!" })).json();
  const ts = await (await api("/auth/totp/setup", { mfa_token: setup.data.mfa_token })).json();
  const code = () => totp(ts.data.secret, timeStep() * 30_000 + 500);
  const conf = await api("/auth/totp/confirm", { mfa_token: setup.data.mfa_token, code: await code() });
  check("owner created and signed in (setup → TOTP)", conf.status() === 200);
  await page.goto(BASE + "/admin/");
  await page.waitForSelector(".content h1", { timeout: 15_000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/07-admin-dashboard.png` });
  const before = JSON.parse((await inPage("/api/v1/auth/session")).text);

  await stop(srv);
  srv = startServer(51237); // a different, unusual port — like Passenger handing the app a new socket
  BASE = "http://127.0.0.1:51237";
  await waitUp(BASE);
  const cookie = (await ctx.cookies()).filter((c) => c.name.startsWith("__Host-")).map((c) => ({ ...c, domain: "127.0.0.1" }));
  await ctx.addCookies(cookie); // same host, new port: cookies are per host, so this is the same browser session
  await page.goto(BASE + "/admin/");
  const after = JSON.parse((await inPage("/api/v1/auth/session")).text);
  check("session survives the restart (stored in the database, not memory)", after.data?.user?.email === before.data.user.email);
  await page.goto(BASE + "/admin/games");
  await page.waitForSelector(".content h1", { timeout: 15_000 });
  await page.waitForTimeout(600);
  check("admin still signed in after the restart", (await page.locator(".content h1").innerText()).length > 0 && !page.url().includes("/login"));
  await page.screenshot({ path: `${SHOTS}/08-admin-after-restart.png` });
  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  await stop(srv);
  rmSync(DATA, { recursive: true, force: true });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed · screenshots in ${SHOTS}`);

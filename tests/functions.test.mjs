/* Unit tests for the web-play Pages Functions. Run: npm test
   Uses Node 18+ built-ins (Request/Response/crypto.subtle) with a mocked siteverify + ASSETS. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as middleware } from "../functions/[slug]/play/_middleware.js";
import { onRequestPost as verify, onRequest as verifyOther } from "../functions/api/verify.js";
import { signTicket, verifyTicket } from "../lib/play-auth.js";
import { PLAY_GAMES } from "../lib/games.generated.js";

const SLUG = Object.keys(PLAY_GAMES)[0];
const ORIGIN = "https://tinycometstudio.com";
const env = { TURNSTILE_SECRET: "secret", SIGNING_KEY: "k".repeat(32), PLAY_TTL_HOURS: "4" };
const assets = {
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    if (p === `/${SLUG}/gate/`) return new Response("<h1>gate</h1>", { headers: { "Content-Type": "text/html" } });
    if (p === "/404.html") return new Response("<h1>lost</h1>", { headers: { "Content-Type": "text/html" } });
    return new Response("nope", { status: 404 });
  }
};
const ctx = (path, { headers = {}, method = "GET", slug = SLUG } = {}) => ({
  request: new Request(ORIGIN + path, { method, headers }),
  env: { ...env, ASSETS: assets },
  params: { slug },
  next: async () => new Response("GAME", { headers: { "Content-Type": "text/html" } })
});
function mockSiteverify(result) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: init.body }); return new Response(JSON.stringify(result)); };
  return calls;
}
const post = (fields, headers = {}) => new Request(ORIGIN + "/api/verify", { method: "POST", body: new URLSearchParams(fields), headers: { Origin: ORIGIN, ...headers } });

test("ticket sign/verify round-trip, tamper and expiry", async () => {
  const t = await signTicket(SLUG, "key", 60);
  assert.equal(await verifyTicket(t, SLUG, "key"), true);
  assert.equal(await verifyTicket(t, "other-game", "key"), false);
  assert.equal(await verifyTicket(t, SLUG, "wrong-key"), false);
  assert.equal(await verifyTicket(t.slice(0, -2) + "xx", SLUG, "key"), false);
  assert.equal(await verifyTicket(t, SLUG, "key", Date.now() + 61_000), false);
  assert.equal(await verifyTicket("garbage", SLUG, "key"), false);
});

test("middleware: unknown slug → 404 page", async () => {
  const res = await middleware(ctx("/nope/play/", { slug: "nope" }));
  assert.equal(res.status, 404);
  assert.match(await res.text(), /lost/);
});

test("middleware: no cookie → gate page for documents, 403 for assets", async () => {
  const doc = await middleware(ctx(`/${SLUG}/play/`, { headers: { "Sec-Fetch-Dest": "document" } }));
  assert.equal(doc.status, 200);
  assert.match(await doc.text(), /gate/);
  assert.equal(doc.headers.get("Cache-Control"), "no-store");
  const asset = await middleware(ctx(`/${SLUG}/play/game.js`, { headers: { "Sec-Fetch-Dest": "script" } }));
  assert.equal(asset.status, 403);
});

test("middleware: missing trailing slash → 308", async () => {
  const res = await middleware(ctx(`/${SLUG}/play`));
  assert.equal(res.status, 308);
  assert.equal(res.headers.get("Location"), `${ORIGIN}/${SLUG}/play/`);
});

test("middleware: valid cookie → passes through to the game", async () => {
  const t = await signTicket(SLUG, env.SIGNING_KEY, 3600);
  const res = await middleware(ctx(`/${SLUG}/play/`, { headers: { Cookie: `x=1; tc_play=${encodeURIComponent(t)}`, "Sec-Fetch-Dest": "document" } }));
  assert.equal(await res.text(), "GAME");
  assert.match(res.headers.get("Content-Security-Policy"), /wasm-unsafe-eval/);
});

test("middleware: cookie for another slug is rejected", async () => {
  const t = await signTicket("someone-else", env.SIGNING_KEY, 3600);
  const res = await middleware(ctx(`/${SLUG}/play/`, { headers: { Cookie: `tc_play=${t}`, "Sec-Fetch-Dest": "document" } }));
  assert.match(await res.text(), /gate/);
});

test("verify: success sets a signed HttpOnly cookie", async () => {
  const calls = mockSiteverify({ success: true, hostname: "tinycometstudio.com", action: "play", cdata: SLUG });
  const res = await verify({ request: post({ slug: SLUG, "cf-turnstile-response": "tok" }, { "CF-Connecting-IP": "1.2.3.4" }), env });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, redirect: `/${SLUG}/play/` });
  const cookie = res.headers.get("Set-Cookie");
  assert.match(cookie, new RegExp(`^tc_play=${SLUG}\\.\\d+\\.`));
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", `Path=/${SLUG}/play/`, "Max-Age=14400"]) assert.ok(cookie.includes(flag), flag);
  assert.equal(calls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(calls[0].body.get("secret"), "secret");
  assert.equal(calls[0].body.get("remoteip"), "1.2.3.4");
  const ticket = decodeURIComponent(cookie.split(";")[0].split("=")[1]);
  assert.equal(await verifyTicket(ticket, SLUG, env.SIGNING_KEY), true);
});

test("verify: failed captcha → 403, no cookie", async () => {
  mockSiteverify({ success: false, "error-codes": ["invalid-input-response"] });
  const res = await verify({ request: post({ slug: SLUG, "cf-turnstile-response": "bad" }), env });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "captcha_failed");
  assert.equal(res.headers.get("Set-Cookie"), null);
});

test("verify: hostname / action / cdata mismatches are rejected (non-test keys)", async () => {
  for (const r of [{ hostname: "evil.example" }, { action: "login" }, { cdata: "other" }]) {
    mockSiteverify({ success: true, hostname: "tinycometstudio.com", action: "play", cdata: SLUG, ...r });
    const res = await verify({ request: post({ slug: SLUG, "cf-turnstile-response": "tok" }), env });
    assert.equal(res.status, 403, JSON.stringify(r));
  }
});

test("verify: test keys skip hostname binding", async () => {
  mockSiteverify({ success: true, hostname: "example.com", metadata: { result_with_testing_key: true } });
  const res = await verify({ request: post({ slug: SLUG, "cf-turnstile-response": "tok" }), env });
  assert.equal(res.status, 200);
});

test("verify: bad inputs", async () => {
  mockSiteverify({ success: true });
  assert.equal((await verify({ request: post({ slug: "../etc", "cf-turnstile-response": "t" }), env })).status, 400);
  assert.equal((await verify({ request: post({ slug: "not-a-game", "cf-turnstile-response": "t" }), env })).status, 404);
  assert.equal((await verify({ request: post({ slug: SLUG }), env })).status, 400);
  assert.equal((await verify({ request: post({ slug: SLUG, "cf-turnstile-response": "t" }, { Origin: "https://evil.example" }), env })).status, 403);
  assert.equal((await verify({ request: post({ slug: SLUG, "cf-turnstile-response": "t" }), env: {} })).status, 500);
  assert.equal(verifyOther().status, 405);
});

test("verify: siteverify unreachable → 502", async () => {
  globalThis.fetch = async () => { throw new Error("network down"); };
  const res = await verify({ request: post({ slug: SLUG, "cf-turnstile-response": "tok" }), env });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "verify_unavailable");
});

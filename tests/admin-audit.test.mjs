/* Audit log: field diffs, text diffs, redaction, append-only, HMAC hash chain + /audit/verify, bulk parent/child,
   restore; webhooks signing/delivery/retry; public site rendering from D1 + fallback; headers in sync. Run: npm test */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { diff, textDiff, redact, isSecretKey, canonical, makeEntry, writeAudit, verifyChain } from "../lib/admin/audit.js";
import { signPayload, verifySignature, webhookUrlProblem } from "../lib/admin/webhooks.js";
import { Tx } from "../lib/admin/tx.js";
import { renderPublic, classify } from "../lib/site-render.js";
import { PUBLIC_CSP } from "../lib/site-headers.js";
import { collect } from "../lib/admin/routes/analytics.js";
import { makeEnv, call, bootstrapOwner, mockFetch, ORIGIN, sql, row, rows as allRows } from "./helpers.mjs";

test("diff: nested objects, keyed arrays, primitive arrays, Markdown text diff", () => {
  const a = { title: "Nova", links: { android: "", ios: "#" }, platforms: ["android", "ios"], screenshots: [{ src: "/a.png", alt: "A" }, { src: "/b.png", alt: "B" }], body: "line 1\nline 2\nline 3" };
  const b = { title: "Nova!", links: { android: "https://play.google.com/x", ios: "#" }, platforms: ["android", "web"], screenshots: [{ src: "/b.png", alt: "B2" }], body: "line 1\nline two\nline 3\nline 4", added: true };
  const d = diff(a, b);
  const by = Object.fromEntries(d.map((c) => [c.path, c]));
  assert.deepEqual(by.title, { path: "title", op: "changed", old: "Nova", new: "Nova!" });
  assert.deepEqual(by["links.android"], { path: "links.android", op: "changed", old: "", new: "https://play.google.com/x" });
  assert.ok(!by["links.ios"], "unchanged fields omitted");
  assert.deepEqual(by.platforms.diff, { added: ["web"], removed: ["ios"] });
  assert.equal(by["screenshots[src=/a.png]"].op, "removed");
  assert.equal(by["screenshots[src=/b.png].alt"].new, "B2");
  assert.equal(by.added.op, "added");
  assert.equal(by.body.diff.added, 2);
  assert.equal(by.body.diff.removed, 1);
  assert.deepEqual(by.body.diff.hunks.filter((h) => h.t !== " ").map((h) => `${h.t}${h.line}`), ["-line 2", "+line two", "+line 4"]);
  assert.deepEqual(diff({ x: 1 }, { x: 1 }), []);
  const t = textDiff("a\nb\nc", "a\nB\nc");
  assert.equal(t.added, 1);
});

test("redaction: secrets never stored in plain text (diffs and snapshots)", () => {
  for (const k of ["password", "newPassword", "secret", "totp_secret_enc", "key_hash", "token", "recovery_codes", "authorization", "mfa_token"]) assert.ok(isSecretKey(k), k);
  for (const k of ["title", "turnstileSiteKey", "prefix", "api_key_id", "tagline"]) assert.ok(!isSecretKey(k), k);
  const d = diff({ name: "a", password: "old-pass" }, { name: "b", password: "new-pass" });
  assert.deepEqual(d.find((c) => c.path === "password"), { path: "password", op: "changed", old: "[redacted]", new: "[redacted: changed]" });
  const r = redact({ user: { email: "a@b.co", password_hash: "pbkdf2…", nested: [{ token: "t0k3n" }] }, secret: "" });
  assert.deepEqual(r, { user: { email: "a@b.co", password_hash: "[redacted]", nested: [{ token: "[redacted]" }] }, secret: "" });
  const e = makeEntry({ actor: { type: "user", id: "u" } }, { action: "x", before: { password: "p" }, after: { password: "q" }, meta: { authorization: "Bearer x" } });
  assert.ok(!JSON.stringify(e).includes('"p"') && !JSON.stringify(e).includes("Bearer x"));
});

test("audit entries: who/what/where/why on a real request, field diff + snapshots", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const r = await owner.req("PATCH", "/games/project-nova", { body: { tagline: "Big sky", links: { android: "https://play.google.com/store/apps/details?id=x" } }, headers: { "X-Change-Reason": "launch copy", "CF-IPCountry": "PK" } });
  assert.equal(r.status, 200);
  const [e] = (await owner.req("GET", "/audit?action=game.update")).data;
  assert.equal(e.actor_type, "user");
  assert.equal(e.actor_email, owner.email);
  assert.equal(e.actor_name, "Haroon Sheikh");
  assert.equal(e.actor_role, "Owner");
  assert.match(e.session_id, /^ses_/);
  assert.equal(e.ip, "203.0.113.7");
  assert.equal(e.country, "PK");
  assert.equal(e.device, "Chrome on Linux");
  assert.equal(e.method, "PATCH");
  assert.equal(e.route, "PATCH /api/v1/games/{id}");
  assert.equal(e.source, "admin_ui");
  assert.equal(e.resource_type, "game");
  assert.equal(e.resource_id, "project-nova");
  assert.equal(e.resource_label, "Project Nova");
  assert.equal(e.result, "success");
  assert.equal(e.reason, "launch copy");
  assert.match(e.request_id, /^req_/);
  assert.deepEqual(e.changes.map((c) => c.path).sort(), ["links.android", "tagline"]);
  assert.equal(e.before.tagline, "A tiny comet, a very big sky.");
  assert.equal(e.after.tagline, "Big sky");
  assert.ok(e.ts_ms > 0 && e.prev_hash && e.hash);
  const one = await owner.req("GET", `/audit/${e.id}`);
  assert.equal(one.data.hash, e.hash);
  // per-resource history + revision restore (itself audited)
  const hist = await owner.req("GET", "/games/project-nova/history");
  assert.equal(hist.data[0].action, "game.update");
  const restore = await owner.req("POST", "/games/project-nova/revisions/1/restore");
  assert.equal(restore.status, 200);
  assert.equal((await owner.req("GET", "/games/project-nova")).data.tagline, "A tiny comet, a very big sky.");
  const rest = (await owner.req("GET", "/audit?action=game.restore_version")).data[0];
  assert.equal(rest.meta.restored_version, 1);
  assert.ok(rest.changes.some((c) => c.path === "tagline" && c.new === "A tiny comet, a very big sky."));
});

test("audit: bulk operations → one parent + one child per item", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await call(env, "POST", "/contact", { body: { email: `fan${i}@example.com`, message: `Hello ${i}!` } })).data.id);
  const r = await owner.req("POST", "/messages/bulk", { body: { ids, action: "archive" } });
  assert.equal(r.data.affected, 3);
  const parent = (await owner.req("GET", "/audit?action=message.bulk_archive")).data[0];
  const full = (await owner.req("GET", `/audit/${parent.id}`)).data;
  assert.equal(full.children.length, 3);
  const kids = (await owner.req("GET", `/audit?parent_id=${parent.id}`)).data;
  assert.ok(kids.every((k) => k.changes[0].path === "status" && k.changes[0].new === "archived"));
});

test("audit: append-only (UPDATE/DELETE blocked), no API to edit, chain verifies and detects tampering", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  await owner.req("PATCH", "/games/project-nova", { body: { tagline: "one" } });
  await owner.req("PATCH", "/games/project-nova", { body: { tagline: "two" } });
  // MySQL hosts with binary logging refuse CREATE TRIGGER without SUPER; the migration then only warns (chain still detects edits)
  const triggers = env.DB.driver !== "mysql" || Number((await row(env, "SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'audit_log'")).n) === 2;
  if (triggers) {
    await assert.rejects(sql(env, "UPDATE audit_log SET actor_name = 'Mallory' WHERE seq = 2"), /append-only/);
    await assert.rejects(sql(env, "DELETE FROM audit_log WHERE seq = 2"), /append-only/);
  } else console.warn("audit triggers not installed on this MySQL server (no TRIGGER/SUPER privilege) — skipping the trigger assertions");
  assert.equal((await owner.req("DELETE", "/audit/x")).status, 405);
  assert.equal((await owner.req("PATCH", "/audit/x", { body: {} })).status, 405);
  const ok = await owner.req("GET", "/audit/verify");
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.complete, true);
  assert.ok(ok.data.checked >= 6);
  // someone with raw DB access bypasses the trigger and edits history → detected
  await sql(env, triggers ? "DROP TRIGGER audit_no_update" : "SELECT 1");
  const seq = (await row(env, "SELECT seq FROM audit_log WHERE action = 'game.update' ORDER BY seq LIMIT 1")).seq;
  await sql(env, `UPDATE audit_log SET changes = '[{"path":"tagline","op":"changed","old":"x","new":"innocent"}]' WHERE seq = ${seq}`);
  const bad = await owner.req("GET", "/audit/verify");
  assert.equal(bad.data.ok, false);
  assert.equal(bad.data.broken_at.seq, seq);
  assert.match(bad.data.broken_at.reason, /hash mismatch/);
  // recomputing a plain SHA-256 isn't enough: the chain is an HMAC keyed by SIGNING_KEY
  const wrongKey = await verifyChain({ ...env, SIGNING_KEY: "attacker-key-xxxxxxxxxxxxxxxxxxxxxxxx" });
  assert.equal(wrongKey.ok, false);
  // a deleted row breaks the links
  const env2 = await makeEnv();
  const o2 = await bootstrapOwner(env2);
  await o2.req("PATCH", "/games/project-nova", { body: { tagline: "a" } });
  await sql(env2, `${triggers ? "DROP TRIGGER audit_no_delete; " : ""}DELETE FROM audit_log WHERE seq = 2`);
  const gap = await verifyChain(env2);
  assert.equal(gap.ok, false);
  assert.match(gap.broken_at.reason, /gap/);
});

test("audit: concurrent writers keep one linear chain", async () => {
  const env = await makeEnv();
  await Promise.all(Array.from({ length: 12 }, (_, i) => writeAudit(env, [makeEntry(null, { action: `test.${i}` })])));
  const v = await verifyChain(env);
  assert.equal(v.ok, true);
  assert.equal(v.checked, 12);
});

test("Tx refuses to write without an audit entry", async () => {
  const env = await makeEnv();
  const tx = new Tx({ env, now: Date.now(), actor: { type: "system" }, txs: [] });
  tx.run("UPDATE games SET title = 'x'");
  await assert.rejects(tx.commit(), /without an audit entry/);
  assert.notEqual((await row(env, "SELECT title FROM games LIMIT 1")).title, "x");
});

test("audit: canonical JSON is key-order independent", () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: null }] }), canonical({ a: [2, { c: null, d: 1 }], b: 1 }));
});

test("audit: export is itself audited; retention is owner-only", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const csv = await owner.req("GET", "/audit/export?format=csv");
  assert.equal(csv.status, 200);
  assert.match(csv.text.split("\n")[0], /^seq,id,ts,actor_type/);
  assert.ok((await owner.req("GET", "/audit?action=audit.export")).data.length === 1);
  const k = (await owner.req("POST", "/api-keys", { body: { name: "a", scopes: ["audit:read"] } })).data.secret;
  assert.equal((await call(env, "PUT", "/audit/retention", { body: { days: 1 }, headers: { Authorization: `Bearer ${k}` } })).status, 403);
  assert.equal((await owner.req("PUT", "/audit/retention", { body: { days: 30 } })).status, 200);
});

test("webhooks: HMAC signature (t=…,v1=…), verification, tolerance", async () => {
  const sig = await signPayload("whsec_test", '{"a":1}', 1_700_000_000);
  assert.match(sig, /^t=1700000000,v1=[0-9a-f]{64}$/);
  assert.equal(await verifySignature("whsec_test", '{"a":1}', sig, { now: 1_700_000_100_000 }), true);
  assert.equal(await verifySignature("whsec_test", '{"a":2}', sig, { now: 1_700_000_100_000 }), false, "body tampered");
  assert.equal(await verifySignature("whsec_other", '{"a":1}', sig, { now: 1_700_000_100_000 }), false, "wrong secret");
  assert.equal(await verifySignature("whsec_test", '{"a":1}', sig, { now: 1_700_001_000_000 }), false, "too old (replay)");
  assert.equal(webhookUrlProblem("http://example.com/x"), "must use https://");
  assert.ok(webhookUrlProblem("https://127.0.0.1/x"));
  assert.ok(webhookUrlProblem("https://localhost/x"));
  assert.equal(webhookUrlProblem("https://hooks.example.com/x"), null);
});

test("webhooks: events delivered signed after commit, failures retried, secret shown once", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  const hook = await owner.req("POST", "/webhooks", { body: { url: "https://hooks.example.com/tc", events: ["news.published", "game.*"] } });
  assert.equal(hook.status, 201);
  const secret = hook.data.secret;
  assert.match(secret, /^whsec_/);
  assert.ok(!(await owner.req("GET", "/webhooks")).text.includes(secret));
  let fail = true;
  const m = mockFetch(async () => (fail ? new Response("down", { status: 500 }) : new Response("ok")));
  try {
    await owner.req("PATCH", "/games/project-nova", { body: { tagline: "hooked" } });
    await owner.req("POST", "/news/hello-world/unpublish");
    assert.equal(m.calls.length, 1, "unpublish isn't subscribed; game.updated is");
    const c = m.calls[0];
    assert.equal(c.init.headers["X-TinyComet-Event"], "game.updated");
    assert.equal(await verifySignature(secret, c.init.body, c.init.headers["X-TinyComet-Signature"]), true);
    assert.equal(JSON.parse(c.init.body).data.id, "project-nova");
    const d1 = (await owner.req("GET", `/webhooks/${hook.data.webhook.id}/deliveries`)).data[0];
    assert.equal(d1.status, "pending");
    assert.equal(d1.attempts, 1);
    fail = false;
    const re = await owner.req("POST", `/webhook-deliveries/${d1.id}/redeliver`);
    assert.equal(re.data.status, "success");
    assert.equal(re.data.attempts, 2);
    const t = await owner.req("POST", `/webhooks/${hook.data.webhook.id}/test`);
    assert.equal(t.data.status, "success");
  } finally { m.restore(); }
});

test("public site: rendered from D1, identical to the static build, purge on change, fallback without D1", async () => {
  const env = await makeEnv();
  const req = (p, h = {}) => renderPublic({ request: new Request(ORIGIN + p, { headers: h }), env });
  const home = await req("/");
  assert.equal(home.headers.get("X-Rendered-From"), "d1");
  assert.equal(home.headers.get("Content-Security-Policy"), PUBLIC_CSP);
  const stat = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.equal(await home.text(), stat, "byte-identical to tools/build.mjs output");
  // The sitemap stamps undated pages (/, /press/, games…) with the build day, so ignore those lastmod values.
  const undated = (s) => s.replace(/(<loc>[^<]*<\/loc>)<lastmod>\d{4}-\d\d-\d\d<\/lastmod>(<priority>(?:1\.0|0\.5|0\.3|0\.9)<\/priority>)/g, "$1<lastmod>*</lastmod>$2");
  for (const p of ["/news/", "/news/hello-world/", "/project-nova/", "/privacy/", "/press/", "/news/feed.xml", "/sitemap.xml"]) {
    const f = p.endsWith("/") ? `../public${p}index.html` : `../public${p}`;
    assert.equal(undated(await (await req(p)).text()), undated(await readFile(new URL(f, import.meta.url), "utf8")), p);
  }
  const etag = home.headers.get("ETag");
  assert.equal((await req("/", { "If-None-Match": etag })).status, 304);
  const owner = await bootstrapOwner(env);
  await owner.req("PATCH", "/games/project-nova", { body: { title: "Project Nova Deluxe" } });
  assert.ok((await (await req("/")).text()).includes("Project Nova Deluxe"), "content version bump → fresh render");
  await owner.req("DELETE", "/games/orbit-garden");
  assert.equal((await req("/orbit-garden/")).status, 404, "deleted game is gone even though public/orbit-garden/ exists");
  assert.equal((await req("/news/nope/")).status, 404);
  assert.equal(await req("/css/style.css"), null, "assets stay static");
  assert.equal(await renderPublic({ request: new Request(ORIGIN + "/"), env: {} }), null, "no D1 → static files");
  const unseeded = await makeEnv({ seed: false });
  assert.equal(await renderPublic({ request: new Request(ORIGIN + "/"), env: unseeded }), null, "not seeded → static files");
  await owner.req("PUT", "/system/maintenance", { body: { enabled: true, message: "Back at 5" } });
  const m = await req("/");
  assert.equal(m.status, 503);
  assert.match(await m.text(), /Back at 5/);
  assert.equal((await req("/", { Cookie: owner.cookie })).status, 200, "signed-in admins still see the site");
  assert.deepEqual(classify("/admin/"), null);
});

test("scheduled posts publish themselves when due (audited as the scheduler)", async () => {
  const env = await makeEnv();
  const owner = await bootstrapOwner(env);
  await owner.req("POST", "/news", { body: { title: "Future post", body: "Soon" } });
  const s = await owner.req("POST", "/news/future-post/publish", { body: { publish_at: new Date(Date.now() + 60_000).toISOString() } });
  assert.equal(s.data.status, "scheduled");
  const req = () => renderPublic({ request: new Request(ORIGIN + "/news/future-post/"), env });
  assert.equal((await req()).status, 404);
  await sql(env, `UPDATE news SET publish_at = ${Date.now() - 1000} WHERE slug = 'future-post'; UPDATE site_state SET value = '${Date.now() - 1000}' WHERE key = 'next_publish_at'`);
  const { invalidatePublicState } = await import("../lib/admin/state.js");
  invalidatePublicState();
  assert.equal((await req()).status, 200);
  const e = (await owner.req("GET", "/audit?action=news.publish")).data[0];
  assert.equal(e.actor_type, "system");
  assert.equal(e.source, "scheduler");
});

test("analytics collect: no cookies, no IPs, bot-filtered, counted", async () => {
  const env = await makeEnv();
  const send = (body, h = {}) => collect(new Request(ORIGIN + "/api/v1/collect", { method: "POST", body: JSON.stringify(body), headers: { Origin: ORIGIN, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1", "CF-Connecting-IP": "203.0.113.9", ...h } }), env);
  for (const ev of [{ event: "page_view", path: "/project-nova/" }, { event: "store_click", props: { game: "project-nova", platform: "android" }, path: "/project-nova/" }, { event: "nope" }]) assert.equal((await send(ev)).status, 204);
  await send({ event: "page_view", path: "/" }, { "User-Agent": "Googlebot/2.1" });
  await send({ event: "page_view", path: "/" }, { Origin: "https://evil.example" });
  const rows = await allRows(env, "SELECT * FROM analytics_events");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].game, "project-nova", "game derived from the path");
  assert.equal(rows[0].device, "mobile");
  assert.ok(!JSON.stringify(rows).includes("203.0.113.9"), "IP never stored");
  const owner = await bootstrapOwner(env);
  const sum = await owner.req("GET", "/analytics/summary");
  assert.equal(sum.data.totals.page_view, 1);
  assert.equal(sum.data.totals.visitors, 1);
  const fun = await owner.req("GET", "/analytics/funnel");
  assert.equal(fun.data.games[0].store_click, 1);
});

test("_headers and the in-code headers stay in sync; /admin and /api are noindex", async () => {
  const h = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
  assert.ok(h.includes(`Content-Security-Policy: ${PUBLIC_CSP}`));
  assert.match(h, /\/admin\/\*\n\s+X-Robots-Tag: noindex/);
  assert.match(h, /\/api\/\*\n\s+X-Robots-Tag: noindex/);
  const env = await makeEnv();
  assert.equal((await call(env, "GET", "/health")).headers.get("X-Robots-Tag"), "noindex, nofollow");
  const { onRequest } = await import("../functions/admin/[[path]].js");
  const res = await onRequest({ request: new Request(ORIGIN + "/admin/games"), env: { ASSETS: { fetch: async () => new Response("<html>") } }, next: async () => new Response("x") });
  assert.match(res.headers.get("X-Robots-Tag"), /noindex/);
  assert.match(res.headers.get("Content-Security-Policy"), /style-src 'self';/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
});

test("OpenAPI 3.1 is generated from the route table and covers every route", async () => {
  const env = await makeEnv();
  const r = await call(env, "GET", "/openapi.json");
  assert.equal(r.json.openapi, "3.1.0");
  const { routes } = await import("../lib/admin/api.js");
  for (const rt of routes) assert.ok(r.json.paths[rt.path]?.[rt.method.toLowerCase()], `${rt.method} ${rt.path}`);
  const patch = r.json.paths["/games/{id}"].patch;
  assert.ok(patch.parameters.some((p) => p.name === "X-Dry-Run") && patch.parameters.some((p) => p.name === "If-Match"));
  assert.equal(r.json.paths["/games"].post["x-permission"], "games:create");
});

test("audit: retention archive moves old entries to storage, purges them (trigger unlock) and re-anchors the chain", async () => {
  const env = await makeEnv();
  const old = Date.now() - 40 * 86_400_000;
  await writeAudit(env, [1, 2, 3].map((i) => makeEntry({ now: old }, { action: "test.old", label: `old ${i}`, ts: old + i })));
  const owner = await bootstrapOwner(env);
  assert.equal((await owner.req("PUT", "/audit/retention", { body: { days: 30 } })).status, 200);
  const r = await owner.req("POST", "/audit/archive");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.archived, 3);
  assert.equal(r.data.anchor.seq, 3);
  const obj = await env.MEDIA.get(r.data.r2_key);
  assert.equal((await obj.text()).trim().split("\n").length, 3);
  assert.equal((await row(env, "SELECT MIN(seq) AS s FROM audit_log")).s, 4);
  const v = await owner.req("GET", "/audit/verify");
  assert.equal(v.data.ok, true, JSON.stringify(v.data));
  // the unlock flag is closed again: ordinary deletes are still refused (where the server has the trigger)
  if (env.DB.driver !== "mysql" || Number((await row(env, "SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()")).n)) {
    await assert.rejects(sql(env, "DELETE FROM audit_log WHERE seq = 4"), /append-only/);
  }
});

/* The Node host end to end over real HTTP (lib/platform/node-server.js): Pages-style routing, static files with
   _headers/_redirects, compression/ETag/Range, media + game builds from the local bucket, body limits, client-IP
   spoofing, and sessions surviving an app restart (Passenger may restart/idle the app at any time). */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gunzipSync, brotliDecompressSync } from "node:zlib";
import { createApp } from "../lib/platform/node-server.js";
import { createLogger } from "../lib/platform/logger.js";
import { matchSegments, parseSegments } from "../lib/platform/pages-router.js";
import { signTicket } from "../lib/play-auth.js";
import { bootstrapOwner, SETUP_TOKEN, DB_DRIVER, freshMysqlUrl } from "./helpers.mjs";

const dirs = [];
const mysqlUrls = {};
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function start(dataDir, extra = {}) {
  dataDir ||= mkdtempSync(join(tmpdir(), "tc-node-"));
  if (!dirs.includes(dataDir)) dirs.push(dataDir);
  const db = DB_DRIVER === "mysql" ? { DB_DRIVER: "mysql", DATABASE_URL: (mysqlUrls[dataDir] ||= await freshMysqlUrl()) } : { DB_DRIVER: "sqlite" };
  const vars = { DATA_DIR: dataDir, ...db, SIGNING_KEY: "s".repeat(48), ENCRYPTION_KEY: "e".repeat(48), SETUP_TOKEN, DISABLE_AUTO_TICK: "1", PBKDF2_ITERATIONS: "100000", ...extra };
  const app = await createApp({ vars, log: createLogger("silent"), noTimers: true });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, server, base, dataDir, stop: async () => { const done = new Promise((r) => server.close(r)); server.closeAllConnections(); await done; await app.close(); } };
}
const req = (url, opts = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || "GET", headers: opts.headers || {} }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  r.on("error", reject);
  if (opts.body) r.write(opts.body);
  r.end();
});

/** Minimal zip writer (deflate) for build uploads. */
function zip(files) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const local = [], central = [];
  let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content), comp = deflateRawSync(data), nb = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc(data), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc(data), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    local.push(h, nb, comp); central.push(c, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, e]);
}

test("node: Pages-style routing for functions (params, catch-alls, specificity)", () => {
  assert.deepEqual(matchSegments(parseSegments("[slug]/play/[[path]]"), ["nova", "play", "a", "b.js"]), { slug: "nova", path: ["a", "b.js"] });
  assert.deepEqual(matchSegments(parseSegments("[slug]/play/[[path]]"), ["nova", "play"]), { slug: "nova", path: [] });
  assert.equal(matchSegments(parseSegments("api/verify"), ["api", "verify", "x"]), null);
  assert.deepEqual(matchSegments(parseSegments("[slug]/play/"), ["nova", "play", "x"], { prefix: true }), { slug: "nova" });
  assert.equal(matchSegments(parseSegments("[slug]/play/"), ["nova"], { prefix: true }), null);
});

test("node: public pages, static files, _headers, _redirects, 404, compression, ETag/304, HEAD, ranges", async () => {
  const s = await start();
  try {
    const home = await req(s.base + "/", { headers: { "Accept-Encoding": "br" } });
    assert.equal(home.status, 200);
    assert.equal(home.headers["x-rendered-from"], "d1");
    assert.equal(home.headers["content-encoding"], "br");
    assert.match(brotliDecompressSync(home.body).toString(), /Tiny Comet/);
    assert.match(home.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(home.headers["x-frame-options"], "DENY");
    assert.equal((await req(s.base + "/", { headers: { "If-None-Match": home.headers.etag } })).status, 304);
    const head = await req(s.base + "/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);

    const css = await req(s.base + "/css/style.css?v=1", { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(css.status, 200);
    assert.equal(css.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(css.headers["content-encoding"], "gzip");
    assert.match(gunzipSync(css.body).toString(), /\{/);
    assert.equal(css.headers.vary, "Accept-Encoding");
    assert.equal((await req(s.base + "/css/style.css", { headers: { "Accept-Encoding": "gzip", "If-None-Match": css.headers.etag } })).status, 304);
    assert.equal((await req(s.base + "/assets/fonts/nunito-latin.woff2")).headers["cache-control"], "public, max-age=31536000, immutable", "first (most specific) Cache-Control rule wins");
    assert.match((await req(s.base + "/assets/icon.png")).headers["cache-control"], /max-age=86400/);
    const part = await req(s.base + "/assets/icon-512.png", { headers: { Range: "bytes=0-9" } });
    assert.equal(part.status, 206);
    assert.equal(part.body.length, 10);
    assert.match(part.headers["content-range"], /^bytes 0-9\/\d+$/);
    assert.equal((await req(s.base + "/assets/icon-512.png", { headers: { Range: "bytes=999999999-" } })).status, 416);

    const blog = await req(s.base + "/blog");
    assert.equal(blog.status, 301);
    assert.equal(blog.headers.location, "/news/");
    assert.equal((await req(s.base + "/blog/hello-world")).headers.location, "/news/hello-world");
    assert.equal((await req(s.base + "/news")).status, 308);
    const admin = await req(s.base + "/admin/games");
    assert.equal(admin.status, 200);
    assert.match(admin.headers["content-security-policy"], /style-src 'self';/);
    assert.equal(admin.headers["cache-control"], "no-store");
    assert.equal((await req(s.base + "/admin")).status, 308);
    assert.equal((await req(s.base + "/admin/assets/app.js")).headers["cache-control"], "no-cache");
    const lost = await req(s.base + "/no-such-page/");
    assert.equal(lost.status, 404);
    assert.match(lost.body.toString(), /drifted off course|not found/i);
    for (const p of ["/_headers", "/_routes.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/css/..%2f..%2fpackage.json", "/.git/config"]) assert.equal((await req(s.base + p)).status, 404, p);
    const health = await req(s.base + "/api/v1/health");
    assert.equal(JSON.parse(health.body).data.ok, true);
    assert.equal(JSON.parse(health.body).data.d1, true);
    assert.equal((await req(s.base + "/css/style.css", { method: "POST" })).status, 405);
    assert.equal((await req(s.base + "/news/feed.xml")).headers["content-type"], "application/rss+xml; charset=utf-8");
  } finally { await s.stop(); }
});

test("node: media + game builds from the local bucket (ranges, ETag), play gate, body limit, spoofed IP headers", async () => {
  const s = await start(null, { MAX_BODY_MB: "2" });
  try {
    const owner = await bootstrapOwner(s.app.env);
    const png = Buffer.alloc(5000, 7);
    const up = await owner.req("POST", "/media?filename=pic.png", { raw: png, headers: { "Content-Type": "image/png" } });
    assert.equal(up.status, 201, up.text);
    const m = await req(s.base + up.data.url);
    assert.equal(m.status, 200);
    assert.equal(m.headers["content-type"], "image/png");
    assert.equal(m.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(m.body.length, 5000);
    const mr = await req(s.base + up.data.url, { headers: { Range: "bytes=100-199" } });
    assert.equal(mr.status, 206);
    assert.equal(mr.headers["content-range"], "bytes 100-199/5000");
    assert.equal(mr.body.length, 100);
    assert.equal((await req(s.base + up.data.url, { headers: { "If-None-Match": m.headers.etag } })).status, 304);
    assert.equal((await req(s.base + "/media/../package.json")).status, 404);

    const z = zip({ "index.html": "<h1>build!</h1>", "Build/game.data": "D".repeat(4096) });
    const b = await owner.req("POST", "/games/project-nova/build", { raw: z, headers: { "Content-Type": "application/zip" } });
    assert.equal(b.status, 201, b.text);
    const gate = await req(s.base + "/project-nova/play/", { headers: { "Sec-Fetch-Dest": "document" } });
    assert.equal(gate.status, 200);
    assert.match(gate.body.toString(), /cf-turnstile|turnstile/i);
    assert.equal((await req(s.base + "/project-nova/play/Build/game.data", { headers: { "Sec-Fetch-Dest": "empty" } })).status, 403);
    const ticket = await signTicket("project-nova", s.app.env.SIGNING_KEY, 3600);
    const cookie = { Cookie: `tc_play=${encodeURIComponent(ticket)}` };
    const idx = await req(s.base + "/project-nova/play/", { headers: { ...cookie, "Sec-Fetch-Dest": "document" } });
    assert.equal(idx.body.toString(), "<h1>build!</h1>");
    assert.match(idx.headers["content-security-policy"], /wasm-unsafe-eval/);
    const dr = await req(s.base + "/project-nova/play/Build/game.data", { headers: { ...cookie, Range: "bytes=-96" } });
    assert.equal(dr.status, 206);
    assert.equal(dr.headers["content-range"], "bytes 4000-4095/4096");
    assert.equal(dr.body.toString(), "D".repeat(96));

    // body limit (2 MB here): refused before the handler runs
    const big = await req(s.base + "/api/v1/collect", { method: "POST", headers: { "Content-Type": "text/plain", "User-Agent": "Mozilla/5.0 Chrome/130.0" }, body: Buffer.alloc(3 * 1024 * 1024) }); // chunked: no Content-Length
    assert.equal(big.status, 413);
    const declared = await req(s.base + "/api/v1/collect", { method: "POST", headers: { "Content-Length": String(3 * 1024 * 1024) } }).catch((e) => ({ status: e.code }));
    assert.ok(declared.status === 413 || declared.status === "ECONNRESET", String(declared.status));

    // a visitor can't choose their audit-log IP / country by sending Cloudflare headers
    await req(s.base + "/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "6.6.6.6", "CF-IPCountry": "KP", "X-Real-IP": "6.6.6.7" }, body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password-123" }) });
    const e = await s.app.env.DB.prepare("SELECT ip, country FROM audit_log WHERE action = 'auth.login' ORDER BY seq DESC LIMIT 1").first();
    assert.equal(e.ip, "127.0.0.1");
    assert.equal(e.country, null);
  } finally { await s.stop(); }
});

test("node: sessions and data survive an app restart (Passenger restarts/idles apps)", async () => {
  const first = await start();
  const owner = await bootstrapOwner(first.app.env);
  const cookie = owner.cookie;
  const me1 = await req(first.base + "/api/v1/auth/session", { headers: { Cookie: cookie } });
  assert.equal(JSON.parse(me1.body).data.user.email, owner.email);
  await first.stop();
  const second = await start(first.dataDir, { PORT: "0" }); // new process state, same data folder
  try {
    const me2 = await req(second.base + "/api/v1/auth/session", { headers: { Cookie: cookie } });
    assert.equal(me2.status, 200);
    assert.equal(JSON.parse(me2.body).data.user.email, owner.email);
    // rate-limit counters live in the database too
    const n = await second.app.env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first();
    assert.ok(n.n >= 1);
  } finally { await second.stop(); }
});

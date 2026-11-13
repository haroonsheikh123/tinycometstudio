/* The Node.js host for the Cloudflare Pages app: one http handler that turns Node requests into web-standard Request
   objects, runs the unchanged Pages Functions (lib/platform/pages-router.js) with env bindings backed by local
   adapters, and writes the Response back — with compression, HEAD, body-size limits and structured logs.

     env.DB           → SQLite file (node:sqlite) or MySQL/MariaDB (mysql2)      lib/platform/db/
     env.MEDIA        → local folder, R2-compatible                             lib/platform/storage/fs-bucket.js
     env.ASSETS       → public/ with _headers/_redirects semantics              lib/platform/static.js
     env.RENDER_CACHE → LRU + file cache in place of caches.default             lib/platform/cache.js */
import "./polyfills.js";
import { createReadStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { loadEnv, resolveConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { openDatabase } from "./db/index.js";
import { migrate, schemaReady } from "./db/migrate.js";
import { FsBucket } from "./storage/fs-bucket.js";
import { RenderCache, LruMap } from "./cache.js";
import { StaticServer, compressible, negotiate, toWebResponse } from "./static.js";
import { loadSiteConfig, matchRedirect } from "./site-config.js";
import { loadFunctions, createPagesHandler } from "./pages-router.js";
import { clientAddress } from "./client-ip.js";
import { setPasswordIterations } from "../admin/crypto.js";
import { smtpSenderFromEnv } from "./smtp.js";

const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);
const SPOOFABLE = ["cf-connecting-ip", "cf-ipcountry", "cf-ipcity", "cf-visitor", "true-client-ip", "x-real-ip", "x-client-ip"];
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "http2-settings"]);

/** Seed content/ into an empty database (INSERT OR IGNORE — never overwrites admin edits). */
export async function seedDatabase(db) {
  const { buildSeedSql } = await import("../../tools/db-seed.mjs");
  await db.exec(await buildSeedSql());
}

/**
 * @param {{ vars?: object, config?: object, log?: object, db?: object, media?: object }} [opts]
 */
export async function createApp(opts = {}) {
  const loaded = opts.vars ? { vars: opts.vars, files: [] } : loadEnv();
  const config = opts.config || resolveConfig(loaded.vars);
  const log = opts.log || createLogger(config.logLevel);
  setPasswordIterations(config.pbkdf2Iterations);

  const db = opts.db || (await openDatabase(config.db));
  const bool = (v, d) => (v == null || v === "" ? d : /^(1|true|yes|on)$/i.test(String(v)));
  if (bool(config.vars.AUTO_MIGRATE, true)) {
    try {
      const r = await migrate(db, { log: (m) => log.info("migrate", { step: m }) });
      for (const w of r.warnings) log.warn("migration warning", { warning: w });
      if (r.applied.length) log.info("migrations applied", { applied: r.applied });
    } catch (err) { log.error("migration failed — run `npm run migrate` to see why", { err }); }
  }
  if (!(await schemaReady(db))) log.error("database has no tables yet — run `npm run migrate` (cPanel: Run JS script › migrate)");
  else if (bool(config.vars.AUTO_SEED, true)) {
    try {
      const seeded = await db.prepare("SELECT value FROM site_state WHERE key = 'seeded_at'").first();
      if (!seeded) { await seedDatabase(db); log.info("seeded the database from content/"); }
    } catch (err) { log.error("seeding failed — run `npm run seed`", { err }); }
  }

  const media = opts.media || new FsBucket(config.mediaDir);
  const site = loadSiteConfig(config.publicDir);
  const statics = new StaticServer(config.publicDir, { headerRules: site.headers });
  const renderCache = new RenderCache({ maxEntries: config.renderCacheEntries, dir: config.cacheDir });
  const table = await loadFunctions(config.functionsDir);
  const pages = createPagesHandler(table);

  /** env.ASSETS: _redirects first (like Pages), then the file. Status 200 rules are rewrites. */
  async function assetsFetch(input, init) {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    for (let i = 0; i < 3; i++) {
      const r = matchRedirect(site.redirects, url);
      if (!r) break;
      if (r.status === 200) { const to = new URL(r.location, url); url.pathname = to.pathname; continue; }
      return new Response(null, { status: r.status, headers: { Location: r.location, "Cache-Control": "public, max-age=0, must-revalidate" } });
    }
    return statics.fetch(new Request(url, { method: req.method, headers: req.headers }));
  }

  const env = { ...config.vars, DB: db, MEDIA: media, ASSETS: { fetch: assetsFetch }, RENDER_CACHE: renderCache, PLATFORM: "node" };
  // shell/system variables and the DB password are not app config — keep them out of env (like a Pages env)
  for (const k of Object.keys(env)) if (/^(npm_|PASSENGER_|PATH$|HOME$|PWD$|OLDPWD$|SHELL$|_$|DATABASE_URL$|MYSQL_URL$|MYSQL_PASSWORD$)/.test(k)) delete env[k];
  if (!env.PUBLIC_STATE_MEMO_MS) env.PUBLIC_STATE_MEMO_MS = "2000";
  const smtp = smtpSenderFromEnv(config.vars, log); // off unless SMTP_HOST is set
  if (smtp) env.EMAIL_SENDER = smtp;
  delete env.SMTP_PASSWORD; delete env.SMTP_PASS;

  const compressedMemo = new LruMap({ maxEntries: 1000, maxBytes: 32 * 1024 * 1024 });
  const pending = new Set();
  const waitUntil = (p) => {
    const q = Promise.resolve(p).catch((err) => log.error("background task failed", { err }));
    pending.add(q); q.finally(() => pending.delete(q));
  };

  // optional in-process housekeeping (scheduled posts, webhook retries) while the app is awake; cron covers idle times
  let tickTimer = null;
  const tickMin = Number(config.vars.TICK_INTERVAL_MINUTES ?? 5);
  if (tickMin > 0 && !opts.noTimers) {
    tickTimer = setInterval(async () => {
      try { const { runTick } = await import("../admin/tick.js"); await runTick(env, { waitUntil }); }
      catch (err) { log.warn("background tick failed", { err }); }
    }, tickMin * 60_000);
    tickTimer.unref();
  }

  function buildUrl(req, info) {
    let proto = info.proto || (req.socket.encrypted ? "https" : "http");
    if (config.forceHttps) proto = "https";
    let host = String(req.headers.host || "localhost").toLowerCase();
    if (!/^[a-z0-9.\-:[\]]+$/.test(host)) host = "localhost";
    if (config.publicUrl) { const u = new URL(config.publicUrl); if (!/^(localhost|127\.|\[::1\])/.test(host)) { proto = u.protocol.slice(0, -1); host = u.host; } }
    return new URL(`${proto}://${host}${req.url.startsWith("/") ? req.url : "/" + req.url}`);
  }

  function requestHeaders(req, info) {
    const h = new Headers();
    const raw = req.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i].toLowerCase();
      if (HOP_BY_HOP.has(k) || k.startsWith("!~") || SPOOFABLE.includes(k) || k.startsWith(":")) continue;
      try { h.append(raw[i], raw[i + 1]); } catch { /* invalid header value */ }
    }
    h.set("X-Real-IP", info.ip);
    if (info.country) h.set("CF-IPCountry", info.country);
    return h;
  }

  function bodyStream(req, state) {
    let seen = 0;
    const limit = config.maxBodyBytes;
    const counter = new Transform({
      transform(chunk, _e, cb) { seen += chunk.length; if (seen > limit) { state.tooLarge = true; cb(Object.assign(new Error("Request body too large"), { status: 413 })); } else cb(null, chunk); }
    });
    req.pipe(counter);
    req.on("error", (e) => counter.destroy(e));
    return Readable.toWeb(counter);
  }

  async function writeResponse(req, res, response, started) {
    const status = response.status;
    const headers = response.headers;
    const cookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    const out = {};
    for (const [k, v] of headers) if (k !== "set-cookie" && !HOP_BY_HOP.has(k)) out[k] = v;
    if (cookies.length) out["set-cookie"] = cookies;
    const isHead = req.method === "HEAD";
    const noBody = isHead || status === 204 || status === 304 || (status >= 100 && status < 200);

    if (noBody || !response.body) {
      response.body?.cancel?.().catch(() => {});
      if (status === 204 || status === 304) delete out["content-length"];
      res.writeHead(status, out); res.end(); return;
    }
    // static fast paths (Response came straight from the asset server)
    if (response.__buffer && !response.bodyUsed) { response.body.cancel().catch(() => {}); res.writeHead(status, out); res.end(response.__buffer); return; }
    if (response.__file && !response.bodyUsed) {
      response.body.cancel().catch(() => {});
      res.writeHead(status, out);
      await pipeline(createReadStream(response.__file.path, { start: response.__file.start, end: response.__file.end }), res).catch(() => {});
      return;
    }
    const type = out["content-type"] || "";
    const enc = !out["content-encoding"] && compressible(type) && status !== 206 ? negotiate(req.headers["accept-encoding"]) : null;
    const len = Number(out["content-length"] || 0);
    if (enc && (!len || len <= 8 * 1024 * 1024)) {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length < 1024) { out["content-length"] = String(buf.length); res.writeHead(status, out); res.end(buf); return; }
      const memoKey = out.etag ? `${out.etag}|${enc}|${buf.length}` : null;
      let z = memoKey && compressedMemo.get(memoKey)?.v;
      if (!z) {
        z = enc === "br" ? await brotli(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: buf.length > 256 * 1024 ? 5 : 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }) : await gzip(buf, { level: 6 });
        if (memoKey) compressedMemo.set(memoKey, z, z.length);
      }
      out["content-encoding"] = enc;
      out["content-length"] = String(z.length);
      out.vary = out.vary ? (/accept-encoding/i.test(out.vary) ? out.vary : `${out.vary}, Accept-Encoding`) : "Accept-Encoding";
      res.writeHead(status, out); res.end(z); return;
    }
    res.writeHead(status, out);
    await pipeline(Readable.fromWeb(response.body), res).catch((err) => { log.debug("response stream aborted", { err: err?.message }); });
    void started;
  }

  function errorPage(status, url, message) {
    const isApi = url.pathname.startsWith("/api/");
    return isApi
      ? new Response(JSON.stringify({ error: { code: status === 413 ? "payload_too_large" : "internal_error", message } }), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } })
      : new Response(`<!doctype html><meta charset="utf-8"><title>${status}</title><p>${message}</p>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }

  async function handler(req, res) {
    const started = process.hrtime.bigint();
    const info = clientAddress({ remoteAddress: req.socket.remoteAddress, headers: req.headers, trustProxy: config.trustProxy, trustCloudflare: config.trustCloudflare });
    let url;
    try { url = buildUrl(req, info); } catch { res.writeHead(400); res.end("Bad request"); return; }
    let response;
    try {
      if (req.url.length > 8192) response = new Response("URI too long", { status: 414 });
      else if (config.forceHttps && info.proto === "http" && !/^(localhost|127\.)/.test(url.hostname)) {
        response = new Response(null, { status: 301, headers: { Location: url.href.replace(/^http:/, "https:") } });
      } else if (!site.runsFunctions(url.pathname)) {
        // _routes.json excludes (css/js/assets…): straight to the asset server — no Request objects, no DB
        const r = await statics.serve({ method: req.method, pathname: url.pathname, search: url.search, headers: new Headers({ "If-None-Match": req.headers["if-none-match"] || "", "If-Modified-Since": req.headers["if-modified-since"] || "", Range: req.headers.range || "", "If-Range": req.headers["if-range"] || "", "Accept-Encoding": req.headers["accept-encoding"] || "" }) });
        response = toWebResponse(r);
      } else {
        const len = Number(req.headers["content-length"] || 0);
        if (len > config.maxBodyBytes) response = errorPage(413, url, `Request body too large (max ${Math.round(config.maxBodyBytes / 1048576)} MB)`);
        else {
          const hasBody = req.method !== "GET" && req.method !== "HEAD" && (len > 0 || req.headers["transfer-encoding"]);
          const state = { tooLarge: false };
          const request = new Request(url, { method: req.method, headers: requestHeaders(req, info), body: hasBody ? bodyStream(req, state) : undefined, duplex: hasBody ? "half" : undefined });
          response = await pages(request, env, { waitUntil, assets: assetsFetch });
          if (!(response instanceof Response)) throw new Error("A function did not return a Response");
          // a chunked upload that went over the limit: whatever the handler made of the cut-off body, answer 413
          if (state.tooLarge) { response.body?.cancel?.().catch(() => {}); response = errorPage(413, url, `Request body too large (max ${Math.round(config.maxBodyBytes / 1048576)} MB)`); }
        }
      }
    } catch (err) {
      if (err?.status === 413 || err?.cause?.status === 413) response = errorPage(413, url, "Request body too large");
      else { log.error("request failed", { err, method: req.method, path: url.pathname }); response = errorPage(500, url, "Something went wrong."); }
    }
    try { await writeResponse(req, res, response, started); }
    catch (err) { log.error("writing the response failed", { err, path: url.pathname }); if (!res.headersSent) { res.writeHead(500); } res.end(); }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (response.status >= 500 || ms > 2000 || bool(config.vars.LOG_REQUESTS, false)) {
      (response.status >= 500 ? log.error : ms > 2000 ? log.warn : log.info)("request", { method: req.method, path: url.pathname, status: response.status, ms: Math.round(ms * 10) / 10, ip: info.ip });
    }
  }

  async function close() {
    if (tickTimer) clearInterval(tickTimer);
    await Promise.allSettled([...pending]);
    await db.close?.();
  }

  return { handler, close, env, config, log, db, media, statics, renderCache, table, envFiles: loaded.files };
}

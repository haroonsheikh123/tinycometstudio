/* Cloudflare Pages Functions file-based routing, for the Node host. Scans functions/ once at startup and runs the same
   handler modules with a Pages-compatible context { request, env, params, data, next, waitUntil, passThroughOnException }.
   - functions/a/b.js → /a/b · functions/a/index.js → /a · [name] → one segment · [[name]] → zero or more segments (array)
   - _middleware.js applies to its folder and everything below it; middlewares run outermost (root) first
   - onRequest, or method-specific onRequestGet / onRequestPost / … (exported as a function or an array of functions)
   - next() inside the last handler → the static asset server (env.ASSETS)
   Route order follows Pages: more specific first (static segment > [param] > [[catch-all]], longer paths first). */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const METHOD_EXPORT = { GET: "onRequestGet", POST: "onRequestPost", PUT: "onRequestPut", PATCH: "onRequestPatch", DELETE: "onRequestDelete", HEAD: "onRequestHead", OPTIONS: "onRequestOptions" };

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js|ts)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** "[slug]/play/[[path]]" → { segs: [{type, name}], score } */
export function parseSegments(relPath) {
  const segs = relPath.split("/").filter(Boolean).map((s) => {
    let m;
    if ((m = /^\[\[(\w+)\]\]$/.exec(s))) return { type: "catchall", name: m[1] };
    if ((m = /^\[(\w+)\]$/.exec(s))) return { type: "param", name: m[1] };
    return { type: "static", value: s };
  });
  return segs;
}
const weight = { static: 3, param: 2, catchall: 1 };
function compareRoutes(a, b) {
  for (let i = 0; i < Math.max(a.segs.length, b.segs.length); i++) {
    const x = a.segs[i], y = b.segs[i];
    if (!x) return 1;
    if (!y) return -1;
    if (weight[x.type] !== weight[y.type]) return weight[y.type] - weight[x.type];
  }
  return 0;
}

/** Match path segments against a pattern. `prefix` → pattern may match the beginning only (middleware). */
export function matchSegments(segs, parts, { prefix = false } = {}) {
  const params = {};
  let i = 0;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (s.type === "catchall") { params[s.name] = parts.slice(i); return params; }
    if (i >= parts.length) return null;
    if (s.type === "static" && s.value !== parts[i]) return null;
    if (s.type === "param") params[s.name] = parts[i];
    i++;
  }
  if (i < parts.length && !prefix) return null;
  return params;
}

export async function loadFunctions(functionsDir) {
  const routes = [], middlewares = [];
  let files = [];
  try { files = walk(functionsDir); } catch { return { routes, middlewares }; }
  for (const file of files) {
    const rel = relative(functionsDir, file).split(sep).join("/").replace(/\.(m?js|ts)$/, "");
    const mod = await import(pathToFileURL(file).href);
    const base = rel.split("/").pop();
    if (base === "_middleware") {
      const dirRel = rel.slice(0, -"_middleware".length);
      middlewares.push({ file: rel, segs: parseSegments(dirRel), mod });
    } else {
      const routeRel = base === "index" ? rel.slice(0, -"index".length) : rel;
      routes.push({ file: rel, segs: parseSegments(routeRel), mod });
    }
  }
  routes.sort(compareRoutes);
  middlewares.sort((a, b) => a.segs.length - b.segs.length); // root first
  return { routes, middlewares };
}

const handlersOf = (mod, method) => {
  const h = mod[METHOD_EXPORT[method]] || mod.onRequest || (method === "HEAD" ? mod.onRequestGet : null);
  return h ? [].concat(h) : null;
};

/**
 * Build the request handler. @param {{ routes, middlewares }} table
 * @returns {(request: Request, env: object, ctx: { waitUntil, assets: (req) => Promise<Response> }) => Promise<Response>}
 */
export function createPagesHandler(table) {
  return async function handle(request, env, { waitUntil, assets }) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    const method = request.method.toUpperCase();
    const chain = [];
    for (const mw of table.middlewares) {
      const params = matchSegments(mw.segs, parts, { prefix: true });
      const hs = params && handlersOf(mw.mod, method);
      if (hs) for (const h of hs) chain.push({ h, params, file: mw.file });
    }
    for (const r of table.routes) {
      const params = matchSegments(r.segs, parts);
      const hs = params && handlersOf(r.mod, method);
      if (hs) { for (const h of hs) chain.push({ h, params, file: r.file }); break; }
    }
    const data = {};
    let passThrough = false;
    const run = async (i, req) => {
      if (i >= chain.length) return assets(req);
      const { h, params, file } = chain[i];
      const context = {
        request: req, env, params, data, functionPath: "/" + file,
        waitUntil, passThroughOnException: () => { passThrough = true; },
        next: (input, init) => run(i + 1, input === undefined ? req : input instanceof Request && !init ? input : new Request(input, init || req))
      };
      try { return await h(context); }
      catch (e) { if (passThrough) return assets(req); throw e; }
    };
    return run(0, request);
  };
}

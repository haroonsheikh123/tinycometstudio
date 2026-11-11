/* Route registry. Each route definition is used for dispatch, permission checks, validation AND
   to generate the OpenAPI document, so the docs can't drift from the implementation. */

export const routes = [];

/**
 * @param {object} def
 * @param {string} def.method   GET|POST|PATCH|PUT|DELETE
 * @param {string} def.path     e.g. "/games/{id}"
 * @param {string} def.op       operation id, e.g. "games.update"
 * @param {string} def.tag      OpenAPI tag
 * @param {string} def.summary
 * @param {"public"|"mfa"|"user"|"session"} [def.auth="user"]  user = session cookie OR API key; session = cookie only
 * @param {string|function} [def.perm]  "resource:action" or (ctx, input) => string|string[]
 * @param {boolean} [def.stepUp]        session users must have re-entered a TOTP code in the last 10 minutes
 * @param {boolean} [def.ownerOnly]
 * @param {boolean} [def.destructive]   queued for approval when the API key requires approval
 * @param {object} [def.body] [def.query]  JSON schemas (lib/admin/schema.js)
 * @param {function} def.handler        (ctx, { params, query, body }) => data | { $status, $headers, $meta, data } | Response
 */
export function route(def) {
  const keys = [];
  const re = new RegExp("^" + def.path.replace(/\{(\w+)\}/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  const action = typeof def.perm === "string" ? def.perm.split(":")[1] : null;
  const r = {
    auth: "user",
    destructive: def.method === "DELETE" || ["delete", "publish", "manage"].includes(action),
    write: def.method !== "GET" && def.method !== "HEAD",
    ...def,
    keys, re
  };
  routes.push(r);
  return r;
}

export function match(method, path) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method && !(method === "HEAD" && r.method === "GET")) continue;
    const params = {};
    r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; } });
    return { route: r, params };
  }
  return { route: null, allowed: pathMatched ? routes.filter((r) => r.re.test(path)).map((r) => r.method) : null };
}

/** Response helper for handlers that need a status/headers/meta. */
export const reply = (data, { status = 200, headers = {}, meta } = {}) => ({ $reply: true, data, status, headers, meta });

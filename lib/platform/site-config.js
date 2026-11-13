/* Cloudflare Pages' public/_headers, public/_redirects and public/_routes.json, implemented for the Node host.
   Same file formats, so the founder edits one set of files for both hosts.
   https://developers.cloudflare.com/pages/configuration/headers/ · …/redirects/ · …/functions/routing/#create-a-_routesjson-file */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** "/blog/*" or "/news/:slug" → RegExp with named groups (splat → "splat"). */
export function patternToRegExp(pattern, { prefix = false } = {}) {
  let re = "";
  const names = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") { if (names.includes("splat")) re += ".*"; else { re += "(?<splat>.*)"; names.push("splat"); } }
    else if (c === ":" && /[A-Za-z]/.test(pattern[i + 1] || "")) {
      const m = /^[A-Za-z]\w*/.exec(pattern.slice(i + 1))[0];
      re += `(?<${m}>[^/]+)`; names.push(m); i += m.length;
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return { re: new RegExp(`^${re}${prefix ? "" : "$"}`), names };
}

/** Parse _headers → [{ pattern, re, set: [[name, value]], detach: [name] }] */
export function parseHeaders(text) {
  const rules = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const pattern = raw.trim();
      cur = { pattern, ...patternToRegExp(/^https?:\/\//.test(pattern) ? new URL(pattern.replace(/\*/g, "__s__")).pathname.replace(/__s__/g, "*") : pattern), set: [], detach: [] };
      rules.push(cur);
      continue;
    }
    if (!cur) continue;
    const line = raw.trim();
    if (line.startsWith("!")) { cur.detach.push(line.slice(1).trim().toLowerCase()); continue; }
    const i = line.indexOf(":");
    if (i > 0) cur.set.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return rules;
}

/** Headers for a static file at `path`. Like Cloudflare: every matching rule applies in order and repeated headers are
    comma-joined — except Cache-Control, where the first (most specific, listed first) rule wins so values never conflict. */
export function headersFor(rules, path) {
  const out = new Map(); // lower name → [Name, value]
  for (const r of rules) {
    const m = r.re.exec(path);
    if (!m) continue;
    for (const d of r.detach) out.delete(d);
    for (const [name, v0] of r.set) {
      const v = v0.replace(/:(\w+)/g, (s, k) => (m.groups && m.groups[k] !== undefined ? m.groups[k] : s));
      const k = name.toLowerCase();
      if (out.has(k) && k !== "cache-control") out.set(k, [name, `${out.get(k)[1]}, ${v}`]);
      else if (!out.has(k)) out.set(k, [name, v]);
    }
  }
  return Object.fromEntries([...out.values()]);
}

/** Parse _redirects → [{ from, re, to, status }] (200 = rewrite). */
export function parseRedirects(text) {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const [from, to, st] = line.split(/\s+/);
    if (!from || !to) continue;
    rules.push({ from, to, status: st ? Number(st.replace(/!$/, "")) : 302, ...patternToRegExp(from) });
  }
  return rules;
}
/** First matching redirect for `url` → { status, location } | null */
export function matchRedirect(rules, url) {
  for (const r of rules) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    let to = r.to.replace(/:(\w+)/g, (s, k) => (m.groups && m.groups[k] !== undefined ? m.groups[k] : s));
    if (url.search && !to.includes("?")) to += url.search;
    return { status: r.status, location: to };
  }
  return null;
}

/** Parse _routes.json → (path) => boolean "should Functions run for this path?" */
export function parseRoutes(json) {
  let cfg;
  try { cfg = typeof json === "string" ? JSON.parse(json) : json; } catch { cfg = null; }
  if (!cfg) return () => true;
  const inc = (cfg.include || ["/*"]).map((p) => patternToRegExp(p).re);
  const exc = (cfg.exclude || []).map((p) => patternToRegExp(p).re);
  return (path) => inc.some((r) => r.test(path)) && !exc.some((r) => r.test(path));
}

export function loadSiteConfig(publicDir) {
  const read = (f) => (existsSync(join(publicDir, f)) ? readFileSync(join(publicDir, f), "utf8") : "");
  return { headers: parseHeaders(read("_headers")), redirects: parseRedirects(read("_redirects")), runsFunctions: parseRoutes(read("_routes.json") || null) };
}

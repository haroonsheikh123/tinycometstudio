/* Who is the client? (Node host.) On Cloudflare the edge sets CF-Connecting-IP; here we work it out ourselves and never
   trust a header a visitor could have typed:
   1. Passenger (cPanel) passes the real peer in the secure header "!~Passenger-Client-Address" (clients cannot send
      "!~" headers — Passenger rejects them) and the scheme in "!~Passenger-Proto".
   2. Otherwise X-Forwarded-For is walked from the right, skipping only TRUST_PROXY hops (a number, or a list of
      trusted proxy IPs/CIDRs). X-Real-IP is used only when the direct peer is a trusted proxy.
   3. With TRUST_CLOUDFLARE=1, CF-Connecting-IP / CF-IPCountry are honoured only when the request really arrived from a
      Cloudflare edge address (the site is behind Cloudflare DNS, orange cloud). Otherwise country/city stay empty. */
import { ipInCidr, validCidr } from "../admin/http.js";

export const CLOUDFLARE_RANGES = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20",
  "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"
];
const LOOPBACK = ["127.0.0.0/8", "::1/128"];

/** Normalise "::ffff:1.2.3.4", "1.2.3.4:5678", "[::1]:80" → bare IP, or null if it isn't an IP. */
export function normIp(s) {
  let ip = String(s ?? "").trim();
  if (!ip) return null;
  const br = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (br) ip = br[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, "");
  ip = ip.replace(/^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i, "$1").toLowerCase();
  return validCidr(ip) && !ip.includes("/") ? ip : null;
}

/** Parse TRUST_PROXY: "0"/"false" → 0 hops, "1" → 1 hop, "true" → all, "10.0.0.0/8,127.0.0.1" → list. */
export function parseTrust(v) {
  const s = String(v ?? "1").trim().toLowerCase();
  if (s === "" || s === "false" || s === "no") return { hops: 0 };
  if (s === "true" || s === "yes") return { hops: Infinity };
  if (/^\d+$/.test(s)) return { hops: Number(s) };
  if (s === "loopback") return { cidrs: LOOPBACK };
  return { cidrs: s.split(",").map((x) => x.trim()).filter((x) => validCidr(x)) };
}

const get = (headers, name) => (typeof headers.get === "function" ? headers.get(name) : headers[name.toLowerCase()]) ?? null;

/**
 * @param {{ remoteAddress?: string, headers: Headers|object, trustProxy?: string|number, trustCloudflare?: boolean }} o
 * @returns {{ ip: string, country: string|null, proto: string|null, via: string }}
 */
export function clientAddress({ remoteAddress, headers, trustProxy = "1", trustCloudflare = false }) {
  const trust = typeof trustProxy === "object" ? trustProxy : parseTrust(trustProxy);
  const isTrusted = (ip, hop) => (trust.cidrs ? trust.cidrs.some((c) => ipInCidr(ip, c)) : hop < trust.hops);
  let ip, via;
  let proto = null;

  const passenger = normIp(get(headers, "!~passenger-client-address"));
  const peer = normIp(remoteAddress);
  if (passenger) { ip = passenger; via = "passenger"; proto = get(headers, "!~passenger-proto"); }
  else {
    // chain from the client (left) to the direct peer (right); a unix-socket peer (no address) counts as local
    const xff = String(get(headers, "x-forwarded-for") || "").split(",").map(normIp);
    const chain = [...xff.filter(Boolean), peer || "127.0.0.1"];
    let i = chain.length - 1, hop = 0;
    while (i > 0 && isTrusted(chain[i], hop)) { i--; hop++; }
    ip = chain[i]; via = i === chain.length - 1 ? "socket" : "x-forwarded-for";
    const peerTrusted = isTrusted(chain[chain.length - 1], 0);
    const xri = normIp(get(headers, "x-real-ip"));
    if (via === "socket" && peerTrusted && xri) { ip = xri; via = "x-real-ip"; }
    if (peerTrusted) proto = get(headers, "x-forwarded-proto");
  }

  let country = null;
  if (trustCloudflare && CLOUDFLARE_RANGES.some((c) => ipInCidr(ip, c))) {
    const cfip = normIp(get(headers, "cf-connecting-ip"));
    if (cfip) { ip = cfip; via = "cloudflare"; }
    const cc = String(get(headers, "cf-ipcountry") || "").toUpperCase();
    if (/^[A-Z]{2}$/.test(cc) && cc !== "XX") country = cc;
    if (!proto) { try { proto = JSON.parse(get(headers, "cf-visitor") || "{}").scheme || null; } catch { /* ignore */ } }
  }
  proto = proto ? String(proto).split(",")[0].trim().toLowerCase() : null;
  return { ip, country, proto: proto === "https" || proto === "http" ? proto : null, via };
}

/* Client IP / scheme / country on the Node host (lib/platform/client-ip.js). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { clientAddress, normIp, parseTrust } from "../lib/platform/client-ip.js";

const ca = (headers, o = {}) => clientAddress({ remoteAddress: "127.0.0.1", headers, ...o });

test("client ip: Passenger's secure header wins and cannot be spoofed by X-Forwarded-For", () => {
  const r = clientAddress({ remoteAddress: undefined, headers: { "!~passenger-client-address": "198.51.100.4", "!~passenger-proto": "https", "x-forwarded-for": "6.6.6.6" } });
  assert.deepEqual(r, { ip: "198.51.100.4", country: null, proto: "https", via: "passenger" });
});

test("client ip: X-Forwarded-For honours only the trusted number of proxy hops", () => {
  // client 203.0.113.9 → (attacker-supplied 1.1.1.1 prefix) → Apache on 127.0.0.1
  assert.equal(ca({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }).ip, "203.0.113.9", "1 trusted hop: the address Apache saw");
  assert.equal(ca({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }, { trustProxy: "2" }).ip, "1.1.1.1");
  assert.equal(ca({ "x-forwarded-for": "203.0.113.9" }, { trustProxy: "0" }).ip, "127.0.0.1", "0 hops: the socket peer");
  assert.equal(ca({ "x-forwarded-for": "203.0.113.9, 10.0.0.5" }, { trustProxy: "127.0.0.1,10.0.0.0/8" }).ip, "203.0.113.9", "CIDR list");
  assert.equal(ca({ "x-forwarded-for": "garbage, 203.0.113.9" }).ip, "203.0.113.9");
  assert.equal(clientAddress({ remoteAddress: "::ffff:192.0.2.1", headers: {}, trustProxy: "0" }).ip, "192.0.2.1");
  assert.equal(ca({ "x-forwarded-for": "2001:db8::1" }).ip, "2001:db8::1");
  assert.equal(ca({ "x-real-ip": "6.6.6.6" }).ip, "127.0.0.1", "X-Real-IP is never trusted (proxies pass visitor-sent ones through)");
  assert.equal(ca({ "x-forwarded-proto": "https" }).proto, "https");
  assert.equal(clientAddress({ remoteAddress: "192.0.2.50", headers: { "x-forwarded-proto": "https" }, trustProxy: "127.0.0.1" }).proto, null);
});

test("client ip: CF-Connecting-IP / CF-IPCountry only from real Cloudflare edges, only when enabled", () => {
  const viaCf = { "x-forwarded-for": "172.70.1.2", "cf-connecting-ip": "203.0.113.50", "cf-ipcountry": "pk", "cf-visitor": '{"scheme":"https"}' };
  assert.deepEqual(ca(viaCf, { trustCloudflare: true }), { ip: "203.0.113.50", country: "PK", proto: "https", via: "cloudflare" });
  assert.deepEqual(ca(viaCf, { trustCloudflare: false }), { ip: "172.70.1.2", country: null, proto: null, via: "x-forwarded-for" });
  const spoof = { "x-forwarded-for": "198.51.100.7", "cf-connecting-ip": "1.2.3.4", "cf-ipcountry": "US" };
  assert.deepEqual(ca(spoof, { trustCloudflare: true }), { ip: "198.51.100.7", country: null, proto: null, via: "x-forwarded-for" }, "not a Cloudflare address → ignored");
  assert.equal(ca({ ...viaCf, "cf-ipcountry": "XX" }, { trustCloudflare: true }).country, null, "unknown country stays empty");
});

test("client ip: normalisation helpers", () => {
  assert.equal(normIp("[2001:db8::2]:443"), "2001:db8::2");
  assert.equal(normIp("192.0.2.1:8080"), "192.0.2.1");
  assert.equal(normIp("not-an-ip"), null);
  assert.equal(normIp("10.0.0.0/8"), null);
  assert.deepEqual(parseTrust("false"), { hops: 0 });
  assert.deepEqual(parseTrust("true"), { hops: Infinity });
  assert.deepEqual(parseTrust("3"), { hops: 3 });
});

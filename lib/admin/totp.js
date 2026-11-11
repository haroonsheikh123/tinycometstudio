/* RFC 4226 HOTP / RFC 6238 TOTP with Web Crypto (no dependencies).
   Defaults match every authenticator app: SHA-1, 6 digits, 30 s step. */
import { randomBytes, safeEqual } from "./crypto.js";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const c of s) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** New random TOTP secret (160 bits, base32 — what authenticator apps expect). */
export const generateTotpSecret = () => base32Encode(randomBytes(20));

const HASHES = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };
export async function hotp(secretBytes, counter, { digits = 6, algorithm = "SHA1" } = {}) {
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: HASHES[algorithm] || "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) { msg[i] = Number(c & 0xffn); c >>= 8n; }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const timeStep = (now = Date.now(), period = 30) => Math.floor(now / 1000 / period);

/** TOTP code for `secret` (base32 string or bytes) at time `now` (ms). */
export function totp(secret, now = Date.now(), { period = 30, digits = 6, algorithm = "SHA1" } = {}) {
  const bytes = typeof secret === "string" ? base32Decode(secret) : secret;
  return hotp(bytes, timeStep(now, period), { digits, algorithm });
}

/**
 * Verify a code with a ±`window` step tolerance and replay protection.
 * @returns {Promise<number|null>} the matched time-step (store it as the user's last used step) or null.
 * Codes for steps ≤ `lastStep` are rejected so a code can't be used twice.
 */
export async function verifyTotp(secret, code, { now = Date.now(), window = 1, lastStep = -1, period = 30, digits = 6 } = {}) {
  const c = String(code ?? "").replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(c)) return null;
  const bytes = typeof secret === "string" ? base32Decode(secret) : secret;
  const cur = timeStep(now, period);
  let match = null;
  for (let s = cur - window; s <= cur + window; s++) {
    // Check every candidate (no early exit) to keep timing flat.
    if (safeEqual(await hotp(bytes, s, { digits }), c) && s > lastStep && match === null) match = s;
  }
  return match;
}

/** otpauth:// URI for QR enrollment. */
export function otpauthUri({ secret, account, issuer = "Tiny Comet Studio" }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

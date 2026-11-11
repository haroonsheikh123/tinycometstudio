/* Crypto helpers for the admin/control API — Web Crypto only (crypto.subtle), no dependencies.
   Runs in Cloudflare Workers/Pages Functions and in Node 18+ (tests). */

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64url(s) {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
/** URL-safe random token with `bytes` bytes of entropy. */
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));
/** Short random id (lowercase base32-ish) — not secret, just unique. */
export function randomId(prefix = "", n = 12) {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const b = randomBytes(n);
  let s = "";
  for (const x of b) s += alphabet[x % alphabet.length];
  return prefix + s;
}

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
}
export const sha256Hex = async (data) => toHex(await sha256(data));

const hmacKeys = new Map();
async function hmacKey(secret, hash = "SHA-256") {
  const id = hash + ":" + (typeof secret === "string" ? secret : b64url(secret));
  if (!hmacKeys.has(id)) {
    if (hmacKeys.size > 64) hmacKeys.clear();
    hmacKeys.set(id, crypto.subtle.importKey("raw", typeof secret === "string" ? enc.encode(secret) : secret, { name: "HMAC", hash }, false, ["sign", "verify"]));
  }
  return hmacKeys.get(id);
}
export async function hmac(secret, data, hash = "SHA-256") {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, hash), typeof data === "string" ? enc.encode(data) : data));
}
export const hmacHex = async (secret, data) => toHex(await hmac(secret, data));
export const hmacB64 = async (secret, data) => b64url(await hmac(secret, data));

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  a = String(a ?? ""); b = String(b ?? "");
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Derive a purpose-specific sub-key from a master secret (HMAC-based, so one secret can serve several uses). */
export const deriveKey = (master, purpose) => hmac(master, `tinycomet:${purpose}:v1`);

/* ---------- AES-GCM encryption at rest (TOTP secrets, webhook secrets) ---------- */
const aesKeys = new Map();
async function aesKey(secret) {
  if (!secret || String(secret).length < 16) throw new Error("ENCRYPTION_KEY is missing or too short (need ≥ 16 chars, 32 random bytes recommended)");
  if (!aesKeys.has(secret)) {
    const raw = await deriveKey(secret, "aes-gcm");
    aesKeys.set(secret, crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
  }
  return aesKeys.get(secret);
}
/** Encrypt a string → "v1.<iv>.<ciphertext>" (base64url). `aad` binds the ciphertext to a context (e.g. user id). */
export async function encrypt(secret, plaintext, aad = "") {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(secret), enc.encode(plaintext));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}
export async function decrypt(secret, box, aad = "") {
  const [v, iv, ct] = String(box || "").split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("bad ciphertext");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv), additionalData: enc.encode(aad) }, await aesKey(secret), fromB64url(ct));
  return dec.decode(pt);
}

/* ---------- passwords: PBKDF2-SHA256 ----------
   100 000 iterations is the maximum Cloudflare Workers' Web Crypto allows for PBKDF2 (and the floor the spec asks for).
   Format: pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url> */
export const PBKDF2_ITERATIONS = 100_000;
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(String(password).normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const salt = randomBytes(16);
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(await pbkdf2(password, salt, iterations))}`;
}
export async function verifyPassword(password, stored) {
  const [alg, it, salt, hash] = String(stored || "").split("$");
  const iterations = Number(it);
  if (alg !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 1000 || iterations > PBKDF2_ITERATIONS || !salt || !hash) {
    // Still burn comparable time so a missing user is not distinguishable by timing.
    await pbkdf2(password, randomBytes(16), PBKDF2_ITERATIONS);
    return false;
  }
  const got = await pbkdf2(password, fromB64url(salt), iterations);
  return safeEqual(b64url(got), hash);
}
/** A fixed dummy hash used to equalise timing for unknown accounts. */
export const DUMMY_HASH = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/* A small list of very common passwords (plus anything containing the studio name) — rejected at set time. */
const COMMON = new Set(("123456789012 1234567890123 password1234 passwordpassword qwertyuiopas qwerty123456 iloveyou1234 " +
  "letmein12345 welcome12345 administrator admin1234567 adminadmin123 changeme1234 abc123456789 111111111111 000000000000 " +
  "123123123123 football1234 baseball1234 sunshine1234 princess1234 dragon123456 monkey123456 master123456 trustno11234 " +
  "superman1234 batman123456 starwars1234 pakistan1234 pakistan123456 karachi12345 lahore123456 islamabad123 " +
  "correcthorsebatterystaple 1q2w3e4r5t6y qazwsxedcrfv zaq12wsxcde3 p@ssw0rd1234 passw0rd1234 password123! " +
  "Password1234 Password123! Welcome123! Qwerty123456 Admin@123456").toLowerCase().split(/\s+/));
export function passwordProblems(pw, { email = "", name = "" } = {}) {
  const p = String(pw ?? "");
  const out = [];
  if (p.length < 12) out.push("must be at least 12 characters");
  if (p.length > 256) out.push("must be at most 256 characters");
  const low = p.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(p) || /tiny ?comet/.test(low)) out.push("is too common or easy to guess");
  const local = String(email).toLowerCase().split("@")[0];
  if (local.length >= 4 && low.includes(local)) out.push("must not contain your email address");
  if (name && String(name).length >= 4 && low.includes(String(name).toLowerCase())) out.push("must not contain your name");
  if (new Set(p).size < 5) out.push("needs more variety of characters");
  return out;
}

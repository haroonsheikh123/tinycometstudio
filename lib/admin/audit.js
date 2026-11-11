/* Audit log: field-level diffs, secret redaction, append-only HMAC hash chain, verification.
   Every write path goes through Tx (lib/admin/tx.js), which refuses to commit a write without an audit entry. */
import { hmacHex, deriveKey, randomId } from "./crypto.js";

export const GENESIS_HASH = "0".repeat(64);

/* ---------------------------------------------------------------- redaction */
const SECRET_EXACT = new Set(["password", "password_hash", "passwordhash", "currentpassword", "newpassword", "secret", "secret_enc",
  "totp_secret_enc", "totp_pending_enc", "totpsecret", "token", "token_hash", "key", "key_hash", "prev_key_hash", "recovery_codes",
  "recoverycodes", "apikey", "api_key", "authorization", "cookie", "signingsecret", "setuptoken", "setup_token", "mfatoken", "code", "recoverycode"]);
export function isSecretKey(k) {
  const s = String(k).toLowerCase();
  return SECRET_EXACT.has(s) || /(password|secret|_hash|token|_enc)$/.test(s);
}
export const REDACTED = "[redacted]";
export const REDACTED_CHANGED = "[redacted: changed]";
/** Deep copy with secret-looking keys replaced by "[redacted]". */
export function redact(v, depth = 0) {
  if (depth > 20) return "[too deep]";
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = isSecretKey(k) ? (val == null || val === "" ? val : REDACTED) : redact(val, depth + 1);
    return out;
  }
  return v;
}

/* ---------------------------------------------------------------- diff */
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyOf = (x) => (isObj(x) ? x.id ?? x.src ?? x.label ?? null : null);

/**
 * Field-level deep diff.
 * @returns {{path:string, op:"added"|"removed"|"changed", old?:any, new?:any, diff?:object}[]}
 *   - nested objects → dotted paths (links.android)
 *   - arrays of objects with id/src/label → matched by that key (screenshots[src=/a.png].alt)
 *   - other arrays → by index
 *   - multi-line strings (Markdown) → line diff { added, removed, hunks }
 *   - secret fields → "[redacted]" → "[redacted: changed]"
 */
export function diff(before, after, path = "") {
  const out = [];
  const lastKey = path.split(/[.[\]]/).filter(Boolean).pop() || "";
  if (same(before, after)) return out;
  if (path && isSecretKey(lastKey)) {
    out.push({ path, op: before === undefined ? "added" : after === undefined ? "removed" : "changed", old: before === undefined ? undefined : REDACTED, new: after === undefined ? undefined : REDACTED_CHANGED });
    return out;
  }
  if (before === undefined) { out.push({ path, op: "added", new: redact(after) }); return out; }
  if (after === undefined) { out.push({ path, op: "removed", old: redact(before) }); return out; }
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    for (const k of keys) out.push(...diff(before[k], after[k], path ? `${path}.${k}` : k));
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const keyed = [...before, ...after].length > 0 && [...before, ...after].every((x) => keyOf(x) != null);
    if (keyed) {
      const field = isObj(before[0] ?? after[0]) && "id" in (before[0] ?? after[0]) ? "id" : isObj(before[0] ?? after[0]) && "src" in (before[0] ?? after[0]) ? "src" : "label";
      const bm = new Map(before.map((x) => [keyOf(x), x])), am = new Map(after.map((x) => [keyOf(x), x]));
      for (const k of new Set([...bm.keys(), ...am.keys()])) out.push(...diff(bm.get(k), am.get(k), `${path}[${field}=${k}]`));
      const order = (arr) => arr.map(keyOf).filter((k) => bm.has(k) && am.has(k));
      if (!same(order(before), order(after))) out.push({ path: `${path}.$order`, op: "changed", old: before.map(keyOf), new: after.map(keyOf) });
      return out;
    }
    if (before.every((x) => !isObj(x) && !Array.isArray(x)) && after.every((x) => !isObj(x) && !Array.isArray(x))) {
      const added = after.filter((x) => !before.includes(x)), removed = before.filter((x) => !after.includes(x));
      out.push({ path, op: "changed", old: before, new: after, diff: { added, removed } });
      return out;
    }
    const n = Math.max(before.length, after.length);
    for (let i = 0; i < n; i++) out.push(...diff(before[i], after[i], `${path}[${i}]`));
    return out;
  }
  if (typeof before === "string" && typeof after === "string" && (before.includes("\n") || after.includes("\n"))) {
    out.push({ path, op: "changed", diff: textDiff(before, after) });
    return out;
  }
  out.push({ path, op: "changed", old: before, new: after });
  return out;
}

/** Line diff (LCS on the changed middle section). Returns { added, removed, hunks: [{ t: "+"|"-"|" ", line, n }] } */
export function textDiff(a, b, { context = 1, maxHunkLines = 400 } = {}) {
  const A = String(a).split("\n"), B = String(b).split("\n");
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  let ops = [];
  if (a2.length * b2.length <= 2_000_000) {
    const m = a2.length, n = b2.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a2[i] === b2[j]) { ops.push([" ", a2[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", a2[i++]]);
      else ops.push(["+", b2[j++]]);
    }
    while (i < m) ops.push(["-", a2[i++]]);
    while (j < n) ops.push(["+", b2[j++]]);
  } else {
    ops = [...a2.map((l) => ["-", l]), ...b2.map((l) => ["+", l])];
  }
  const full = [...A.slice(0, pre).map((l) => [" ", l]), ...ops, ...A.slice(A.length - suf).map((l) => [" ", l])];
  const keep = new Set();
  full.forEach(([t], i) => { if (t !== " ") for (let k = i - context; k <= i + context; k++) keep.add(k); });
  const hunks = [];
  let lineA = 0, lineB = 0;
  full.forEach(([t, line], i) => {
    if (t !== "+") lineA++;
    if (t !== "-") lineB++;
    if (keep.has(i) && hunks.length < maxHunkLines) hunks.push({ t, line, n: t === "-" ? lineA : lineB });
  });
  return { added: full.filter(([t]) => t === "+").length, removed: full.filter(([t]) => t === "-").length, hunks, truncated: keep.size > maxHunkLines };
}

/* ---------------------------------------------------------------- entries & hash chain */
export const AUDIT_COLUMNS = ["seq", "id", "ts", "parent_id", "actor_type", "actor_id", "actor_name", "actor_email", "actor_role", "api_key_id",
  "api_key_name", "session_id", "ip", "country", "city", "user_agent", "device", "request_id", "method", "route", "source", "action",
  "resource_type", "resource_id", "resource_label", "result", "result_reason", "reason", "changes", "before", "after", "meta", "prev_hash", "hash"];
const JSON_COLS = ["changes", "before", "after", "meta"];

/** Canonical JSON (sorted keys) — the hashed representation must be byte-stable. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** Build a (not yet chained) audit entry from the request context. */
export function makeEntry(ctx, e) {
  const a = ctx?.actor || { type: "system", id: "system", name: "System" };
  const trunc = (s, n) => (s == null ? null : String(s).slice(0, n));
  return {
    id: e.id || randomId("aud_", 16),
    ts: e.ts ?? ctx?.now ?? Date.now(),
    parent_id: e.parentId ?? null,
    actor_type: e.actorType || a.type,
    actor_id: e.actorId ?? a.id ?? null,
    actor_name: e.actorName ?? a.name ?? null,
    actor_email: e.actorEmail ?? a.email ?? null,
    actor_role: a.role ?? null,
    api_key_id: a.apiKeyId ?? null,
    api_key_name: a.apiKeyName ?? null,
    session_id: a.sessionId ?? null,
    ip: ctx?.ip ?? null,
    country: ctx?.country ?? null,
    city: ctx?.city ?? null,
    user_agent: trunc(ctx?.ua, 400),
    device: ctx?.device ?? null,
    request_id: ctx?.reqId ?? null,
    method: ctx?.method ?? null,
    route: ctx?.route ?? null,
    source: e.source ?? ctx?.source ?? "system",
    action: e.action,
    resource_type: e.resourceType ?? null,
    resource_id: e.resourceId != null ? String(e.resourceId) : null,
    resource_label: trunc(e.label, 300),
    result: e.result || "success",
    result_reason: trunc(e.resultReason, 1000),
    reason: trunc(e.reason ?? ctx?.changeReason, 1000),
    changes: e.changes && e.changes.length ? e.changes : null,
    before: e.before !== undefined ? redact(e.before) : null,
    after: e.after !== undefined ? redact(e.after) : null,
    meta: ctx?.approval ? redact({ ...(e.meta || {}), approval_id: ctx.approval.id, approved_by: ctx.approval.by }) : e.meta ? redact(e.meta) : null
  };
}

const auditKeys = new Map();
async function auditKey(env) {
  const master = env?.SIGNING_KEY;
  if (!master) throw new Error("SIGNING_KEY is not configured");
  if (!auditKeys.has(master)) auditKeys.set(master, await deriveKey(master, "audit-chain"));
  return auditKeys.get(master);
}
/** hash = HMAC-SHA256(key derived from SIGNING_KEY, prev_hash + "\n" + canonical(entry without hash)). */
export async function entryHash(env, row) {
  const { hash: _h, ...rest } = row;
  const norm = { ...rest };
  for (const c of JSON_COLS) if (typeof norm[c] === "string") norm[c] = JSON.parse(norm[c]);
  return hmacHex(await auditKey(env), `${row.prev_hash}\n${canonical(norm)}`);
}

export async function chainHead(db) {
  const last = await db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").first();
  if (last) return { seq: last.seq, hash: last.hash };
  const anchor = await db.prepare("SELECT value FROM site_state WHERE key = 'audit_anchor'").first();
  if (anchor) { const a = JSON.parse(anchor.value); return { seq: a.seq, hash: a.hash }; }
  return { seq: 0, hash: GENESIS_HASH };
}

/** Chain entries after `head`, return { rows, statements }. */
export async function chainEntries(env, db, entries, head) {
  let { seq, hash } = head;
  const rows = [];
  for (const e of entries) {
    const row = { seq: ++seq, ...e, prev_hash: hash };
    row.hash = await entryHash(env, row);
    hash = row.hash;
    rows.push(row);
  }
  const ph = AUDIT_COLUMNS.map(() => "?").join(", ");
  const statements = rows.map((r) => db.prepare(`INSERT INTO audit_log (${AUDIT_COLUMNS.join(", ")}) VALUES (${ph})`)
    .bind(...AUDIT_COLUMNS.map((c) => (JSON_COLS.includes(c) ? (r[c] == null ? null : JSON.stringify(r[c])) : r[c] ?? null))));
  return { rows, statements };
}

/** Write standalone entries (denied attempts, logins…) — retries on a concurrent chain collision. */
export async function writeAudit(env, entries) {
  const db = env.DB;
  for (let attempt = 0; attempt < 6; attempt++) {
    const head = await chainHead(db);
    const { rows, statements } = await chainEntries(env, db, entries, head);
    try { await db.batch(statements); return rows; }
    catch (e) { if (!isChainCollision(e) || attempt === 5) throw e; }
  }
}
export const isChainCollision = (e) => /UNIQUE constraint failed: audit_log\.(seq|id)|PRIMARY KEY/i.test(String(e?.message || e));

export function parseRow(r) {
  if (!r) return r;
  const out = { ...r };
  for (const c of JSON_COLS) if (typeof out[c] === "string") { try { out[c] = JSON.parse(out[c]); } catch { /* keep */ } }
  return out;
}

/**
 * Verify the chain: contiguous seq, prev_hash links and recomputed HMACs.
 * @returns {{ ok, checked, first_seq, last_seq, head_hash, anchor, broken_at?: { seq, reason } }}
 */
export async function verifyChain(env, { fromSeq = null, limit = 50_000 } = {}) {
  const db = env.DB;
  const anchorRow = await db.prepare("SELECT value FROM site_state WHERE key = 'audit_anchor'").first();
  const anchor = anchorRow ? JSON.parse(anchorRow.value) : { seq: 0, hash: GENESIS_HASH };
  let prev;
  if (fromSeq != null && fromSeq > anchor.seq + 1) {
    const p = await db.prepare("SELECT seq, hash FROM audit_log WHERE seq = ?").bind(fromSeq - 1).first();
    if (!p) return { ok: false, checked: 0, broken_at: { seq: fromSeq - 1, reason: "missing entry" } };
    prev = p;
  } else prev = { seq: anchor.seq, hash: anchor.hash };
  let checked = 0, first = null;
  const page = 500;
  while (checked < limit) {
    const { results } = await db.prepare("SELECT * FROM audit_log WHERE seq > ? ORDER BY seq LIMIT ?").bind(prev.seq, page).all();
    if (!results.length) break;
    for (const r of results) {
      if (first === null) first = r.seq;
      if (r.seq !== prev.seq + 1) return { ok: false, checked, first_seq: first, broken_at: { seq: r.seq, reason: `gap: expected seq ${prev.seq + 1}` }, anchor };
      if (r.prev_hash !== prev.hash) return { ok: false, checked, first_seq: first, broken_at: { seq: r.seq, reason: "prev_hash does not match the previous entry" }, anchor };
      const h = await entryHash(env, r);
      if (h !== r.hash) return { ok: false, checked, first_seq: first, broken_at: { seq: r.seq, reason: "hash mismatch — entry was modified" }, anchor };
      prev = r; checked++;
    }
    if (results.length < page) break;
  }
  const total = await db.prepare("SELECT COUNT(*) AS n, MAX(seq) AS max FROM audit_log").first();
  return { ok: true, checked, first_seq: first, last_seq: prev.seq, head_hash: prev.hash, total: total.n, complete: prev.seq === (total.max ?? anchor.seq), anchor };
}

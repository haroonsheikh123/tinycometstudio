/* Small key/value system state in D1 (site_state): kill switch, maintenance mode, content version, retention… */

export const stateKeys = {
  killSwitch: "kill_switch",          // { enabled, at, by, reason }
  maintenance: "maintenance",         // { enabled, message, at, by }
  contentVersion: "content_version",  // integer, bumped on every content change (cache key)
  nextPublishAt: "next_publish_at",   // ms of the earliest scheduled news post, or ""
  auditRetention: "audit_retention",  // { days: 0 = forever }
  analyticsRetention: "analytics_retention", // { days }
  setupDone: "setup_done"
};

export async function getState(db, keys) {
  const list = [].concat(keys);
  const { results } = await db.prepare(`SELECT key, value FROM site_state WHERE key IN (${list.map(() => "?").join(",")})`).bind(...list).all();
  const out = {};
  for (const r of results) { try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; } }
  return out;
}
export const getOne = async (db, key, fallback = null) => (await getState(db, key))[key] ?? fallback;

export const setStateStmt = (db, key, value, now = Date.now()) =>
  db.prepare("INSERT INTO site_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, JSON.stringify(value), now);

export const bumpContentVersionStmt = (db, now = Date.now()) =>
  db.prepare("INSERT INTO site_state (key, value, updated_at) VALUES ('content_version', '2', ?) ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at")
    .bind(now);

/* Per-isolate memo for the public site (avoids a D1 read on every page view for longer than MEMO_MS). */
const MEMO_MS = 10_000;
let memo = null;
export async function publicState(env, now = Date.now()) {
  if (memo && memo.db === env.DB && now - memo.at < MEMO_MS) return memo.value;
  const s = await getState(env.DB, [stateKeys.contentVersion, stateKeys.maintenance, stateKeys.nextPublishAt, stateKeys.setupDone, "seeded_at"]);
  const value = {
    contentVersion: Number(s.content_version || 1),
    maintenance: s.maintenance?.enabled ? s.maintenance : null,
    nextPublishAt: Number(s.next_publish_at || 0) || null,
    seeded: Boolean(s.seeded_at)
  };
  memo = { db: env.DB, at: now, value };
  return value;
}
export const invalidatePublicState = () => { memo = null; };

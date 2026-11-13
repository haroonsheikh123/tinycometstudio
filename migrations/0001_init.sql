-- Tiny Comet Studio — admin panel / control API schema (Cloudflare D1 = SQLite).
-- Apply: npx wrangler d1 migrations apply tinycomet --local   (or --remote)
-- Timestamps are UTC milliseconds since the epoch (INTEGER) unless noted.

-- ---------------------------------------------------------------- content
CREATE TABLE settings (
  id          TEXT PRIMARY KEY CHECK (id = 'site'),
  data        TEXT NOT NULL,                 -- JSON, same shape as content/settings.json
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

CREATE TABLE games (
  id          TEXT PRIMARY KEY,              -- slug, also the URL /<id>/
  position    INTEGER NOT NULL DEFAULT 0,    -- display order (ascending)
  title       TEXT NOT NULL,
  status      TEXT NOT NULL,
  data        TEXT NOT NULL,                 -- JSON, same shape as one entry of content/games.json
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT,
  updated_by  TEXT,
  deleted_at  INTEGER                        -- soft delete (restorable)
);
CREATE INDEX games_live ON games (deleted_at, position);

CREATE TABLE news (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'published')),
  publish_at  INTEGER,                       -- scheduled/published time (ms)
  date        TEXT NOT NULL,                 -- YYYY-MM-DD shown on the site
  category    TEXT NOT NULL DEFAULT 'Update',
  game        TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL,                 -- JSON: excerpt, cover, updated, placeholder
  body        TEXT NOT NULL DEFAULT '',      -- Markdown
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT,
  updated_by  TEXT,
  deleted_at  INTEGER
);
CREATE INDEX news_live ON news (deleted_at, status, date);

CREATE TABLE team (
  id          TEXT PRIMARY KEY,
  position    INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,
  data        TEXT NOT NULL,                 -- JSON, same shape as one entry of content/team.json
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT,
  updated_by  TEXT,
  deleted_at  INTEGER
);

CREATE TABLE pages (
  slug        TEXT PRIMARY KEY,              -- rendered at /<slug>/
  title       TEXT NOT NULL,
  source      TEXT NOT NULL,                 -- Markdown with front-matter (same as content/pages/*.md)
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT,
  updated_by  TEXT,
  deleted_at  INTEGER
);

-- Every saved version of every content row (undo / restore).
CREATE TABLE revisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_type TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  version       INTEGER NOT NULL,
  data          TEXT NOT NULL,               -- full JSON snapshot
  deleted       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  actor         TEXT,                        -- display name snapshot
  audit_id      TEXT
);
CREATE INDEX revisions_by_resource ON revisions (resource_type, resource_id, version);

CREATE TABLE media (
  id            TEXT PRIMARY KEY,
  r2_key        TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  alt           TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  deleted_at    INTEGER
);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL,
  topic       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'archived', 'spam')),
  country     TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX messages_by_status ON messages (status, created_at);

-- ---------------------------------------------------------------- people & access
CREATE TABLE roles (
  id          TEXT PRIMARY KEY,              -- slug
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  builtin     INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL,                 -- JSON array of "resource:action"
  game_scope  TEXT,                          -- JSON array of game ids, NULL = all games
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  created_by  TEXT
);

CREATE TABLE users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name                TEXT NOT NULL,
  role_id             TEXT NOT NULL REFERENCES roles (id),
  status              TEXT NOT NULL CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  password_hash       TEXT,
  password_changed_at INTEGER,
  totp_secret_enc     TEXT,                  -- AES-GCM (ENCRYPTION_KEY), never returned
  totp_pending_enc    TEXT,                  -- secret being enrolled
  totp_enabled        INTEGER NOT NULL DEFAULT 0,
  totp_last_step      INTEGER NOT NULL DEFAULT -1, -- replay protection
  recovery_codes      TEXT,                  -- JSON array of SHA-256 hashes (used ones removed)
  failed_logins       INTEGER NOT NULL DEFAULT 0,
  locked_until        INTEGER,
  last_login_at       INTEGER,
  last_login_ip       TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  created_by          TEXT
);

CREATE TABLE sessions (
  id_hash       TEXT PRIMARY KEY,            -- SHA-256 of the session id (the cookie holds the id)
  public_id     TEXT NOT NULL UNIQUE,        -- safe to show / revoke by
  user_id       TEXT NOT NULL REFERENCES users (id),
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,            -- absolute timeout
  stepup_at     INTEGER NOT NULL,            -- last TOTP verification (sensitive actions)
  ip            TEXT,
  country       TEXT,
  user_agent    TEXT,
  revoked_at    INTEGER
);
CREATE INDEX sessions_by_user ON sessions (user_id, revoked_at);

-- One-time tokens: invites, password resets, MFA login tickets.
CREATE TABLE tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('invite', 'reset', 'mfa', 'enroll')),
  user_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT
);

CREATE TABLE api_keys (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  prefix             TEXT NOT NULL UNIQUE,   -- public lookup part, e.g. tck_ab12cd34ef56
  key_hash           TEXT NOT NULL,          -- SHA-256 of the full key
  prev_key_hash      TEXT,                   -- previous secret during a rotation grace period
  prev_valid_until   INTEGER,
  scopes             TEXT NOT NULL,          -- JSON array
  role_id            TEXT,                   -- optional: key inherits this role's permissions
  owner_user_id      TEXT NOT NULL,          -- creator; the key can never exceed their current access
  expires_at         INTEGER,
  ip_allowlist       TEXT NOT NULL DEFAULT '[]', -- JSON array of IPs / CIDRs, [] = any
  rate_limit         INTEGER NOT NULL DEFAULT 60, -- requests / minute
  environments       TEXT NOT NULL DEFAULT '["production","preview","development"]',
  enabled            INTEGER NOT NULL DEFAULT 1,
  require_approval   INTEGER NOT NULL DEFAULT 0, -- destructive calls are queued for a human
  force_dry_run      INTEGER NOT NULL DEFAULT 0, -- every write is a preview
  revoked_at         INTEGER,
  last_used_at       INTEGER,
  last_used_ip       TEXT,
  usage_count        INTEGER NOT NULL DEFAULT 0,
  version            INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'failed')),
  api_key_id    TEXT NOT NULL,
  requested_by  TEXT NOT NULL,               -- JSON actor snapshot
  operation     TEXT NOT NULL,               -- e.g. games.delete
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,               -- path + query
  body          TEXT,                        -- request body (JSON)
  headers       TEXT,                        -- replay-relevant headers (If-Match, X-Change-Reason, X-Agent-Name)
  preview       TEXT,                        -- dry-run result at request time
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  decided_at    INTEGER,
  decided_by    TEXT,
  decision_note TEXT,
  result        TEXT                         -- JSON response of the executed request
);
CREATE INDEX approvals_by_status ON approvals (status, created_at);

CREATE TABLE idempotency (
  id            TEXT PRIMARY KEY,            -- actor + key
  request_hash  TEXT NOT NULL,
  status        INTEGER NOT NULL,
  response      TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE rate_limits (
  bucket   TEXT NOT NULL,
  window   INTEGER NOT NULL,
  count    INTEGER NOT NULL,
  PRIMARY KEY (bucket, window)
);

-- ---------------------------------------------------------------- webhooks
CREATE TABLE webhooks (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  events        TEXT NOT NULL,               -- JSON array, ["*"] = all
  secret_enc    TEXT NOT NULL,               -- AES-GCM, used to sign payloads
  enabled       INTEGER NOT NULL DEFAULT 1,
  failure_count INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  created_by    TEXT
);

CREATE TABLE webhook_deliveries (
  id               TEXT PRIMARY KEY,
  webhook_id       TEXT NOT NULL,
  event            TEXT NOT NULL,
  payload          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  response_status  INTEGER,
  response_excerpt TEXT,
  next_attempt_at  INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX deliveries_by_hook ON webhook_deliveries (webhook_id, created_at);

-- ---------------------------------------------------------------- analytics (no cookies, no IPs)
CREATE TABLE analytics_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  day         TEXT NOT NULL,                 -- YYYY-MM-DD (UTC)
  event       TEXT NOT NULL,
  path        TEXT NOT NULL DEFAULT '',
  game        TEXT NOT NULL DEFAULT '',
  platform    TEXT NOT NULL DEFAULT '',
  network     TEXT NOT NULL DEFAULT '',
  slug        TEXT NOT NULL DEFAULT '',
  referrer    TEXT NOT NULL DEFAULT '',      -- host only
  country     TEXT NOT NULL DEFAULT '',
  device      TEXT NOT NULL DEFAULT '',
  browser     TEXT NOT NULL DEFAULT '',
  os          TEXT NOT NULL DEFAULT '',
  visitor     TEXT NOT NULL                  -- SHA-256(daily salt + IP + UA), salt rotates daily and is deleted
);
CREATE INDEX analytics_events_ts ON analytics_events (ts);
CREATE INDEX analytics_events_day ON analytics_events (day, event);

CREATE TABLE analytics_daily (
  day       TEXT NOT NULL,
  event     TEXT NOT NULL,
  path      TEXT NOT NULL,
  game      TEXT NOT NULL,
  platform  TEXT NOT NULL,
  referrer  TEXT NOT NULL,
  country   TEXT NOT NULL,
  device    TEXT NOT NULL,
  browser   TEXT NOT NULL,
  os        TEXT NOT NULL,
  count     INTEGER NOT NULL,
  PRIMARY KEY (day, event, path, game, platform, referrer, country, device, browser, os)
);

CREATE TABLE analytics_uniques (
  day      TEXT NOT NULL,
  visitor  TEXT NOT NULL,
  PRIMARY KEY (day, visitor)
);

-- ---------------------------------------------------------------- system state
CREATE TABLE site_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Guard rows for atomic optimistic-concurrency checks inside D1 batches:
-- INSERT INTO tx_guard (ok) SELECT 0 WHERE <condition fails>  → CHECK violation → whole batch rolls back.
CREATE TABLE tx_guard (ok INTEGER NOT NULL CHECK (ok = 1));

-- ---------------------------------------------------------------- audit log (append-only, hash-chained)
CREATE TABLE audit_log (
  seq            INTEGER PRIMARY KEY,         -- strictly increasing; a concurrent writer collides and retries
  id             TEXT NOT NULL UNIQUE,
  ts             INTEGER NOT NULL,
  parent_id      TEXT,                        -- bulk operations: children point to the parent entry
  actor_type     TEXT NOT NULL,               -- user | api_key | system | webhook | anonymous
  actor_id       TEXT,
  actor_name     TEXT,
  actor_email    TEXT,
  actor_role     TEXT,
  api_key_id     TEXT,
  api_key_name   TEXT,
  session_id     TEXT,                        -- public session id
  ip             TEXT,
  country        TEXT,
  city           TEXT,
  user_agent     TEXT,
  device         TEXT,
  request_id     TEXT,
  method         TEXT,
  route          TEXT,
  source         TEXT,                        -- admin_ui | api | agent:<name> | system | scheduler
  action         TEXT NOT NULL,               -- e.g. game.update
  resource_type  TEXT,
  resource_id    TEXT,
  resource_label TEXT,
  result         TEXT NOT NULL,               -- success | denied | error | dry_run | pending_approval
  result_reason  TEXT,
  reason         TEXT,                        -- X-Change-Reason
  changes        TEXT,                        -- JSON field-level diff [{path, op, old, new, diff?}]
  before         TEXT,                        -- JSON snapshot (secrets redacted)
  after          TEXT,                        -- JSON snapshot (secrets redacted)
  meta           TEXT,                        -- JSON extras
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
);
CREATE INDEX audit_ts ON audit_log (ts);
CREATE INDEX audit_actor ON audit_log (actor_type, actor_id, seq);
CREATE INDEX audit_resource ON audit_log (resource_type, resource_id, seq);
CREATE INDEX audit_action ON audit_log (action, seq);
CREATE INDEX audit_key ON audit_log (api_key_id, seq);

-- The audit log cannot be edited, and rows can only be deleted by the retention job, which unlocks
-- deletion inside the same transaction (site_state 'audit_purge_unlock' = '1') and logs itself.
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
WHEN (SELECT value FROM site_state WHERE key = 'audit_purge_unlock') IS NOT '1'
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

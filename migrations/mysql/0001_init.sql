-- Tiny Comet Studio — MySQL 5.7+/8.x and MariaDB 10.3+ version of migrations/0001_init.sql (keep the two in sync).
-- Apply with: node tools/migrate.mjs   (DB_DRIVER=mysql) — or paste into phpMyAdmin › SQL (it understands DELIMITER).
-- Differences from the SQLite schema:
--   * TEXT keys/indexed columns are VARCHAR (MySQL can't index unbounded TEXT); big JSON/Markdown columns are LONGTEXT
--   * timestamps stay integer milliseconds (BIGINT) — the app never uses SQL date functions
--   * utf8mb4_bin everywhere (byte-wise compare/sort, like SQLite); users.email is case-insensitive (COLLATE NOCASE)
--   * AUTOINCREMENT → AUTO_INCREMENT; `key`, `window`, `before` are reserved words → backticks
--   * the append-only audit triggers use SIGNAL instead of RAISE(ABORT)
-- The app sends SQLite-dialect SQL; lib/platform/db/mysql-translate.js converts it.

-- ---------------------------------------------------------------- content
CREATE TABLE settings (
  id          VARCHAR(16) NOT NULL PRIMARY KEY,
  data        LONGTEXT NOT NULL,
  version     INT NOT NULL DEFAULT 1,
  updated_at  BIGINT NOT NULL,
  updated_by  VARCHAR(255),
  CONSTRAINT settings_singleton CHECK (id = 'site')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE games (
  id          VARCHAR(100) NOT NULL PRIMARY KEY,
  position    INT NOT NULL DEFAULT 0,
  title       VARCHAR(255) NOT NULL,
  status      VARCHAR(40) NOT NULL,
  data        LONGTEXT NOT NULL,
  version     INT NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  created_by  VARCHAR(255),
  updated_by  VARCHAR(255),
  deleted_at  BIGINT,
  INDEX games_live (deleted_at, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE news (
  slug        VARCHAR(150) NOT NULL PRIMARY KEY,
  title       VARCHAR(255) NOT NULL,
  status      VARCHAR(16) NOT NULL,
  publish_at  BIGINT,
  date        VARCHAR(32) NOT NULL,
  category    VARCHAR(100) NOT NULL DEFAULT 'Update',
  game        VARCHAR(100) NOT NULL DEFAULT '',
  author      VARCHAR(100) NOT NULL DEFAULT '',
  data        LONGTEXT NOT NULL,
  body        LONGTEXT NOT NULL,
  version     INT NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  created_by  VARCHAR(255),
  updated_by  VARCHAR(255),
  deleted_at  BIGINT,
  INDEX news_live (deleted_at, status, date),
  CONSTRAINT news_status CHECK (status IN ('draft', 'scheduled', 'published'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE team (
  id          VARCHAR(100) NOT NULL PRIMARY KEY,
  position    INT NOT NULL DEFAULT 0,
  name        VARCHAR(255) NOT NULL,
  data        LONGTEXT NOT NULL,
  version     INT NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  created_by  VARCHAR(255),
  updated_by  VARCHAR(255),
  deleted_at  BIGINT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE pages (
  slug        VARCHAR(100) NOT NULL PRIMARY KEY,
  title       VARCHAR(255) NOT NULL,
  source      LONGTEXT NOT NULL,
  version     INT NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  created_by  VARCHAR(255),
  updated_by  VARCHAR(255),
  deleted_at  BIGINT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE revisions (
  id            BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  resource_type VARCHAR(40) NOT NULL,
  resource_id   VARCHAR(150) NOT NULL,
  version       INT NOT NULL,
  data          LONGTEXT NOT NULL,
  deleted       TINYINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,
  actor         VARCHAR(255),
  audit_id      VARCHAR(64),
  INDEX revisions_by_resource (resource_type, resource_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE media (
  id            VARCHAR(64) NOT NULL PRIMARY KEY,
  r2_key        VARCHAR(512) NOT NULL,
  filename      VARCHAR(255) NOT NULL,
  content_type  VARCHAR(100) NOT NULL,
  size          BIGINT NOT NULL,
  sha256        CHAR(64) NOT NULL,
  alt           VARCHAR(1000) NOT NULL DEFAULT '',
  created_at    BIGINT NOT NULL,
  created_by    VARCHAR(255),
  deleted_at    BIGINT,
  UNIQUE KEY r2_key (r2_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE messages (
  id          VARCHAR(64) NOT NULL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL DEFAULT '',
  email       VARCHAR(320) NOT NULL,
  topic       VARCHAR(255) NOT NULL DEFAULT '',
  body        LONGTEXT NOT NULL,
  status      VARCHAR(16) NOT NULL DEFAULT 'new',
  country     VARCHAR(8),
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  INDEX messages_by_status (status, created_at),
  CONSTRAINT messages_status CHECK (status IN ('new', 'read', 'archived', 'spam'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------- people & access
CREATE TABLE roles (
  id          VARCHAR(64) NOT NULL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  description VARCHAR(2000) NOT NULL DEFAULT '',
  builtin     TINYINT NOT NULL DEFAULT 0,
  permissions LONGTEXT NOT NULL,
  game_scope  LONGTEXT,
  version     INT NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  created_by  VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE users (
  id                  VARCHAR(64) NOT NULL PRIMARY KEY,
  email               VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  name                VARCHAR(255) NOT NULL,
  role_id             VARCHAR(64) NOT NULL,
  status              VARCHAR(16) NOT NULL,
  password_hash       VARCHAR(255),
  password_changed_at BIGINT,
  totp_secret_enc     VARCHAR(1000),
  totp_pending_enc    VARCHAR(1000),
  totp_enabled        TINYINT NOT NULL DEFAULT 0,
  totp_last_step      BIGINT NOT NULL DEFAULT -1,
  recovery_codes      LONGTEXT,
  failed_logins       INT NOT NULL DEFAULT 0,
  locked_until        BIGINT,
  last_login_at       BIGINT,
  last_login_ip       VARCHAR(64),
  version             INT NOT NULL DEFAULT 1,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  created_by          VARCHAR(255),
  UNIQUE KEY email (email),
  CONSTRAINT users_role FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT users_status CHECK (status IN ('invited', 'active', 'suspended', 'removed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE sessions (
  id_hash       CHAR(64) NOT NULL PRIMARY KEY,
  public_id     VARCHAR(64) NOT NULL,
  user_id       VARCHAR(64) NOT NULL,
  created_at    BIGINT NOT NULL,
  last_seen_at  BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  stepup_at     BIGINT NOT NULL,
  ip            VARCHAR(64),
  country       VARCHAR(8),
  user_agent    VARCHAR(1000),
  revoked_at    BIGINT,
  UNIQUE KEY public_id (public_id),
  INDEX sessions_by_user (user_id, revoked_at),
  CONSTRAINT sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE tokens (
  token_hash  CHAR(64) NOT NULL PRIMARY KEY,
  kind        VARCHAR(16) NOT NULL,
  user_id     VARCHAR(64) NOT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  used_at     BIGINT,
  attempts    INT NOT NULL DEFAULT 0,
  created_by  VARCHAR(255),
  CONSTRAINT tokens_kind CHECK (kind IN ('invite', 'reset', 'mfa', 'enroll'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE api_keys (
  id                 VARCHAR(64) NOT NULL PRIMARY KEY,
  name               VARCHAR(255) NOT NULL,
  description        VARCHAR(2000) NOT NULL DEFAULT '',
  prefix             VARCHAR(64) NOT NULL,
  key_hash           CHAR(64) NOT NULL,
  prev_key_hash      CHAR(64),
  prev_valid_until   BIGINT,
  scopes             LONGTEXT NOT NULL,
  role_id            VARCHAR(64),
  owner_user_id      VARCHAR(64) NOT NULL,
  expires_at         BIGINT,
  ip_allowlist       LONGTEXT NOT NULL,
  rate_limit         INT NOT NULL DEFAULT 60,
  environments       VARCHAR(255) NOT NULL DEFAULT '["production","preview","development"]',
  enabled            TINYINT NOT NULL DEFAULT 1,
  require_approval   TINYINT NOT NULL DEFAULT 0,
  force_dry_run      TINYINT NOT NULL DEFAULT 0,
  revoked_at         BIGINT,
  last_used_at       BIGINT,
  last_used_ip       VARCHAR(64),
  usage_count        BIGINT NOT NULL DEFAULT 0,
  version            INT NOT NULL DEFAULT 1,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  UNIQUE KEY prefix (prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE approvals (
  id            VARCHAR(64) NOT NULL PRIMARY KEY,
  status        VARCHAR(16) NOT NULL,
  api_key_id    VARCHAR(64) NOT NULL,
  requested_by  LONGTEXT NOT NULL,
  operation     VARCHAR(100) NOT NULL,
  method        VARCHAR(10) NOT NULL,
  path          VARCHAR(2000) NOT NULL,
  body          LONGTEXT,
  headers       LONGTEXT,
  preview       LONGTEXT,
  reason        VARCHAR(2000),
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  decided_at    BIGINT,
  decided_by    VARCHAR(255),
  decision_note VARCHAR(2000),
  result        LONGTEXT,
  INDEX approvals_by_status (status, created_at),
  CONSTRAINT approvals_status CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE idempotency (
  id            CHAR(64) NOT NULL PRIMARY KEY,
  request_hash  CHAR(64) NOT NULL,
  status        INT NOT NULL,
  response      LONGTEXT NOT NULL,
  created_at    BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE rate_limits (
  bucket   VARCHAR(255) NOT NULL,
  `window` BIGINT NOT NULL,
  count    BIGINT NOT NULL,
  PRIMARY KEY (bucket, `window`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------- webhooks
CREATE TABLE webhooks (
  id            VARCHAR(64) NOT NULL PRIMARY KEY,
  url           VARCHAR(2000) NOT NULL,
  description   VARCHAR(2000) NOT NULL DEFAULT '',
  events        LONGTEXT NOT NULL,
  secret_enc    VARCHAR(1000) NOT NULL,
  enabled       TINYINT NOT NULL DEFAULT 1,
  failure_count INT NOT NULL DEFAULT 0,
  version       INT NOT NULL DEFAULT 1,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  created_by    VARCHAR(255)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE webhook_deliveries (
  id               VARCHAR(64) NOT NULL PRIMARY KEY,
  webhook_id       VARCHAR(64) NOT NULL,
  event            VARCHAR(100) NOT NULL,
  payload          LONGTEXT NOT NULL,
  status           VARCHAR(16) NOT NULL,
  attempts         INT NOT NULL DEFAULT 0,
  response_status  INT,
  response_excerpt VARCHAR(2000),
  next_attempt_at  BIGINT,
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  INDEX deliveries_due (status, next_attempt_at),
  INDEX deliveries_by_hook (webhook_id, created_at),
  CONSTRAINT deliveries_status CHECK (status IN ('pending', 'success', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------- analytics (no cookies, no IPs)
CREATE TABLE analytics_events (
  id          BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts          BIGINT NOT NULL,
  day         VARCHAR(10) NOT NULL,
  event       VARCHAR(32) NOT NULL,
  path        VARCHAR(200) NOT NULL DEFAULT '',
  game        VARCHAR(64) NOT NULL DEFAULT '',
  platform    VARCHAR(20) NOT NULL DEFAULT '',
  network     VARCHAR(20) NOT NULL DEFAULT '',
  slug        VARCHAR(64) NOT NULL DEFAULT '',
  referrer    VARCHAR(100) NOT NULL DEFAULT '',
  country     VARCHAR(8) NOT NULL DEFAULT '',
  device      VARCHAR(16) NOT NULL DEFAULT '',
  browser     VARCHAR(32) NOT NULL DEFAULT '',
  os          VARCHAR(16) NOT NULL DEFAULT '',
  visitor     VARCHAR(64) NOT NULL,
  INDEX analytics_events_ts (ts),
  INDEX analytics_events_day (day, event)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

-- 10-column primary key: 498 characters × 4 bytes = 1992 bytes (InnoDB's limit is 3072).
CREATE TABLE analytics_daily (
  day       VARCHAR(10) NOT NULL,
  event     VARCHAR(32) NOT NULL,
  path      VARCHAR(200) NOT NULL,
  game      VARCHAR(64) NOT NULL,
  platform  VARCHAR(20) NOT NULL,
  referrer  VARCHAR(100) NOT NULL,
  country   VARCHAR(8) NOT NULL,
  device    VARCHAR(16) NOT NULL,
  browser   VARCHAR(32) NOT NULL,
  os        VARCHAR(16) NOT NULL,
  count     BIGINT NOT NULL,
  PRIMARY KEY (day, event, path, game, platform, referrer, country, device, browser, os)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

CREATE TABLE analytics_uniques (
  day      VARCHAR(10) NOT NULL,
  visitor  VARCHAR(64) NOT NULL,
  PRIMARY KEY (day, visitor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

-- ---------------------------------------------------------------- system state
CREATE TABLE site_state (
  `key`       VARCHAR(191) NOT NULL PRIMARY KEY,
  value       LONGTEXT NOT NULL,
  updated_at  BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

-- Guard rows for optimistic-concurrency checks inside batches. The adapter also rejects any inserted row itself
-- (MySQL 5.7 parses CHECK constraints but ignores them).
CREATE TABLE tx_guard (
  ok INT NOT NULL,
  CONSTRAINT tx_guard_ok CHECK (ok = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- ---------------------------------------------------------------- audit log (append-only, hash-chained)
CREATE TABLE audit_log (
  seq            BIGINT NOT NULL PRIMARY KEY,
  id             VARCHAR(64) NOT NULL,
  ts             BIGINT NOT NULL,
  parent_id      VARCHAR(64),
  actor_type     VARCHAR(32) NOT NULL,
  actor_id       VARCHAR(150),
  actor_name     VARCHAR(255),
  actor_email    VARCHAR(320),
  actor_role     VARCHAR(255),
  api_key_id     VARCHAR(64),
  api_key_name   VARCHAR(255),
  session_id     VARCHAR(64),
  ip             VARCHAR(64),
  country        VARCHAR(8),
  city           VARCHAR(255),
  user_agent     VARCHAR(1000),
  device         VARCHAR(255),
  request_id     VARCHAR(64),
  method         VARCHAR(10),
  route          VARCHAR(500),
  source         VARCHAR(255),
  action         VARCHAR(150) NOT NULL,
  resource_type  VARCHAR(64),
  resource_id    VARCHAR(500),
  resource_label VARCHAR(1000),
  result         VARCHAR(32) NOT NULL,
  result_reason  TEXT,
  reason         TEXT,
  changes        LONGTEXT,
  `before`       LONGTEXT,
  after          LONGTEXT,
  meta           LONGTEXT,
  prev_hash      CHAR(64) NOT NULL,
  hash           CHAR(64) NOT NULL,
  UNIQUE KEY id (id),
  INDEX audit_ts (ts),
  INDEX audit_actor (actor_type, actor_id, seq),
  INDEX audit_resource (resource_type, resource_id(150), seq),
  INDEX audit_action (action, seq),
  INDEX audit_key (api_key_id, seq),
  INDEX audit_parent (parent_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin ROW_FORMAT=DYNAMIC;

-- Append-only: no UPDATE ever, DELETE only while the retention job holds site_state 'audit_purge_unlock' = '1'
-- in the same transaction. Creating triggers needs the TRIGGER privilege (cPanel's "ALL PRIVILEGES" includes it).
-- If your host refuses (e.g. binary logging without SUPER), the migration runner warns and carries on: the app never
-- edits audit rows anyway, and the HMAC hash chain still exposes any tampering (Audit › Verify).
-- @optional
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit log is append-only';

-- @optional
DELIMITER //
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
BEGIN
  IF NOT ((SELECT value FROM site_state WHERE `key` = 'audit_purge_unlock') <=> '1') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit log is append-only';
  END IF;
END//
DELIMITER ;
